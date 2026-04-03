#!/usr/bin/env node

const WebSocket = require('ws');
const { spawn } = require('node-pty');
const crypto = require('crypto');
const readline = require('readline');

// --- Configuration ---
const args = process.argv.slice(2).reduce((acc, arg) => {
    const [k, v] = arg.split('=');
    acc[k.replace('--', '')] = v === undefined ? true : v;
    return acc;
}, {});

const mode = args['mode'] || 'target'; 
const SERVER_URL = args['server'] || process.env.TERMINAL_SERVER_URL || 'ws://127.0.0.1:8899/live-term/';

// Hotkey Parser: Supports "ctrl+x", "^x", or raw hex like "\x18"
function parseHotkey(val) {
    if (!val) return '\x18'; // Default Ctrl+X
    const lower = val.toLowerCase();
    if (lower.startsWith('ctrl+') || lower.startsWith('^')) {
        const char = lower.replace('ctrl+', '').replace('^', '');
        if (char.length === 1) {
            const code = char.charCodeAt(0) - 96;
            if (code >= 1 && code <= 26) return String.fromCharCode(code);
        }
    }
    if (val.startsWith('\\x')) return String.fromCharCode(parseInt(val.slice(2), 16));
    return val[0]; 
}

const HOTKEY = parseHotkey(args['hotkey']);
const HOTKEY_DISPLAY = args['hotkey'] || 'Ctrl+X';

// Security Check: Enforce --allow-insecure for ws://
if (SERVER_URL.startsWith('ws://') && !args['allow-insecure']) {
    console.error('\x1b[31m[Security Error]\x1b[0m Standard "ws://" is insecure. Use "wss://" or pass --allow-insecure to proceed.');
    process.exit(1);
}

// --- Encryption Utility Functions ---

function generateSAS(transcript) {
    const hash = crypto.createHash('sha256').update(transcript).digest('hex');
    return (BigInt('0x' + hash) % 1000000n).toString().padStart(6, '0');
}

function encryptEnvelope(type, data, key) {
    const json = JSON.stringify({ type, data: Buffer.from(data).toString('base64') });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(json), cipher.final()]);
    return { 
        type: 'secure', 
        payload: enc.toString('base64'), 
        iv: iv.toString('base64'), 
        tag: cipher.getAuthTag().toString('base64') 
    };
}

function decryptEnvelope(msg, key) {
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(msg.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(msg.tag, 'base64'));
        const decrypted = Buffer.concat([decipher.update(Buffer.from(msg.payload, 'base64')), decipher.final()]);
        const obj = JSON.parse(decrypted.toString());
        return { type: obj.type, data: Buffer.from(obj.data, 'base64') };
    } catch (e) {
        console.error('\x1b[31m[Decryption Failed]\x1b[0m Integrity check failed or wrong key.');
        process.exit(1);
    }
}

const UI = {
    RESET: '\x1b[0m',
    BANNER_TARGET: '\x1b[41;97m SESSION ACTIVE \x1b[0m',
    BANNER_CTRL: '\x1b[44;97m SESSION ACTIVE \x1b[0m'
};

function resetTerminal() {
    if (process.stdout.isTTY) process.stdout.write(UI.RESET);
}

// --- Main Program ---

async function main() {
    const isController = mode === 'controller';
    const wsOptions = args['allow-insecure'] ? { rejectUnauthorized: false } : {};

    if (!isController) {
        // ==========================
        //        Target Mode
        // ==========================
        const uuid = args['id'] || crypto.randomUUID();
        const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const pubKeyStr = publicKey.export({ type: 'spki', format: 'pem' });
        const nonceT = crypto.randomBytes(16).toString('hex');

        console.log(`\x1b[32m[Target Mode]\x1b[0m Session ID: \x1b[1;36m${uuid}\x1b[0m`);
        console.log(`\x1b[90mRelay Server: ${SERVER_URL}\x1b[0m`);
        console.log(`Waiting for controller to connect...`);

        const ws = new WebSocket(`${SERVER_URL}?id=${uuid}&role=target`, wsOptions);
        let aesKey = null;
        let ptyProcess = null;
        let isApproved = false;

        const cleanup = (reason = 'Session ended.') => {
            resetTerminal();
            console.log(`\n\x1b[33m[!] ${reason}\x1b[0m`);
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(false);
                process.stdin.pause();
            }
        };

        ws.on('message', async (data) => {
            let msg = JSON.parse(data);
            if (msg.type === 'secure' && aesKey) msg = decryptEnvelope(msg, aesKey);

            if (msg.type === 'handshake_init') {
                ws.send(JSON.stringify({ type: 'handshake_proposal', pub: pubKeyStr, nonce: nonceT }));
                const transcript = msg.pub + pubKeyStr + msg.nonce + nonceT;
                const sas = generateSAS(transcript);

                process.stdout.write(`\n\x1b[33m[!] Incoming connection. Verification Code: \x1b[1;36m${sas}\x1b[0m\n`);
                const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                let answer = '';
                while (true) {
                    answer = await new Promise(resolve => rl.question('Approve this controller? [y/N]: ', resolve));
                    answer = answer.trim().toLowerCase();
                    if (answer === 'y' || answer === 'n' || answer === '') break;
                    process.stdout.write('Please enter "y" for yes or "n" for no.\n');
                }
                rl.close();
                process.stdin.resume();

                if (answer === 'y') {
                    isApproved = true;
                    ws.send(JSON.stringify({ type: 'handshake_res', approved: true }));
                } else {
                    console.log('\x1b[31m[!] Rejected.\x1b[0m');
                    ws.close();
                    process.exit(0);
                }
            } else if (msg.type === 'auth' && isApproved) {
                aesKey = crypto.privateDecrypt(privateKey, Buffer.from(msg.key, 'base64'));
                console.log(`\x1b[32m[OK] Encrypted Session Established.\x1b[0m`);
                console.log(`${UI.BANNER_TARGET} Press \x1b[1m${HOTKEY_DISPLAY}\x1b[0m to exit.`);
                startPty();
            } else if (msg.type === 'input' && aesKey && ptyProcess) {
                ptyProcess.write(msg.data.toString());
            } else if (msg.type === 'resize' && aesKey && ptyProcess) {
                const { cols, rows } = JSON.parse(msg.data.toString());
                ptyProcess.resize(cols, rows);
            } else if (msg.type === 'close') {
                cleanup('Session closed by peer.');
                process.exit(0);
            }
        });

        function startPty() {
            let shell = args['shell'] || process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh');
            const cols = process.stdout.columns || 80;
            const rows = process.stdout.rows || 24;
            
            function trySpawn(exe) {
                try { return spawn(exe, [], { name: 'xterm-256color', cols, rows, cwd: process.env.HOME || process.cwd(), env: process.env }); }
                catch (e) { return null; }
            }
            ptyProcess = trySpawn(shell) || trySpawn('/bin/sh') || trySpawn('sh');

            if (!ptyProcess) {
                console.error(`\x1b[31m[Error]\x1b[0m Failed to spawn shell.`);
                process.exit(1);
            }

            if (process.stdin.isTTY) process.stdin.setRawMode(true);
            process.stdin.on('data', d => {
                if (d.toString() === HOTKEY) {
                    ws.send(JSON.stringify(encryptEnvelope('close', Buffer.alloc(0), aesKey)));
                    cleanup('You exited.');
                    process.exit(0);
                }
                if (!args['no-local-input']) ptyProcess.write(d);
            });

            ptyProcess.onData(data => {
                process.stdout.write(data);
                if (aesKey && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(encryptEnvelope('output', data, aesKey)));
            });

            ptyProcess.onExit(() => {
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(encryptEnvelope('close', Buffer.alloc(0), aesKey)));
                cleanup('Local shell exited.');
                process.exit(0);
            });
        }
    } else {
        // ==========================
        //        Controller Mode
        // ==========================
        const targetId = args['target-id'];
        if (!targetId) {
            console.error('Usage: live-term --mode=controller --target-id=ID');
            process.exit(1);
        }

        const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const pubKeyStr = publicKey.export({ type: 'spki', format: 'pem' });
        const nonceC = crypto.randomBytes(16).toString('hex');
        const sessionKey = crypto.randomBytes(32);

        console.log(`\x1b[34m[Controller Mode]\x1b[0m Connecting to target: \x1b[1;36m${targetId}\x1b[0m...`);
        const ws = new WebSocket(`${SERVER_URL}?id=${targetId}&role=controller`, wsOptions);

        const cleanup = (reason = 'Disconnected.') => {
            console.log(`\n\x1b[33m[!] ${reason}\x1b[0m`);
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(false);
                process.stdin.pause();
            }
        };

        ws.on('message', (data) => {
            let msg = JSON.parse(data);
            if (msg.type === 'secure') msg = decryptEnvelope(msg, sessionKey);

            if (msg.type === 'session_sync' && msg.peer === 'target' && msg.status === 'ready') {
                console.log(`\x1b[32m[OK] Target is online. Handshaking...\x1b[0m`);
                ws.send(JSON.stringify({ type: 'handshake_init', pub: pubKeyStr, nonce: nonceC }));
            } else if (msg.type === 'handshake_proposal') {
                const sas = generateSAS(pubKeyStr + msg.pub + nonceC + msg.nonce);
                console.log(`\x1b[33m[!] Verification Code: \x1b[1;36m${sas}\x1b[0m (Waiting for approval)`);
                ws.targetPub = msg.pub;
            } else if (msg.type === 'handshake_res' && msg.approved) {
                console.log(`\x1b[32m[OK] Approved.\x1b[0m`);
                ws.send(JSON.stringify({ type: 'auth', key: crypto.publicEncrypt(ws.targetPub, sessionKey).toString('base64') }));
                console.log(`${UI.BANNER_CTRL} Press \x1b[1m${HOTKEY_DISPLAY}\x1b[0m to exit.`);

                if (!args['read-only']) {
                    if (process.stdin.isTTY) process.stdin.setRawMode(true);
                    process.stdin.on('data', d => {
                        if (d.toString() === HOTKEY) {
                            ws.send(JSON.stringify(encryptEnvelope('close', Buffer.alloc(0), sessionKey)));
                            cleanup('You exited.');
                            process.exit(0);
                        }
                        ws.send(JSON.stringify(encryptEnvelope('input', d, sessionKey)));
                    });
                }
                const sendResize = () => {
                    const data = JSON.stringify({ cols: process.stdout.columns, rows: process.stdout.rows });
                    ws.send(JSON.stringify(encryptEnvelope('resize', data, sessionKey)));
                };
                sendResize();
                process.stdout.on('resize', sendResize);
            } else if (msg.type === 'output') {
                process.stdout.write(msg.data);
            } else if (msg.type === 'close') {
                cleanup('Closed by peer.');
                process.exit(0);
            }
        });

        ws.on('close', () => cleanup('Relay connection closed.'));
        ws.on('error', (e) => cleanup(`Connection error: ${e.message}`));
    }
}

main().catch(console.error);
