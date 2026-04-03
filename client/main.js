#!/usr/bin/env node
const { spawn } = require('node-pty');
const crypto = require('crypto');
const WebSocket = require('ws');
const readline = require('readline');

/**
 * TermChat Client - Terminal bidirectional E2EE remote sync tool
 * Logic: Research -> Strategy -> Execution (Strict Plan Implementation)
 */

// --- Configuration ---
const SERVER_URL = process.env.TERMINAL_SERVER_URL || 'ws://127.0.0.1:8899/chat';

const args = process.argv.slice(2).reduce((acc, arg) => {
    const [k, v] = arg.split('=');
    acc[k.replace('--', '')] = v === undefined ? true : v;
    return acc;
}, {});

// Security Check: Enforce --allow-insecure for ws://
if (SERVER_URL.startsWith('ws://') && !args['allow-insecure']) {
    console.error('\x1b[31m[Security Error]\x1b[0m Standard "ws://" is insecure. Use "wss://" or pass --allow-insecure to proceed.');
    process.exit(1);
}

// --- Encryption Utility Functions ---

function generateSAS(transcript) {
    const hash = crypto.createHash('sha256').update(transcript).digest('hex');
    // Use BigInt conversion to ensure determinism of the 6-digit number
    return (BigInt('0x' + hash) % 1000000n).toString().padStart(6, '0');
}

function encrypt(data, key) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(data), cipher.final()]);
    return { payload: enc.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

function decrypt(msg, key) {
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(msg.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(msg.tag, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(msg.payload, 'base64')), decipher.final()]);
    } catch (e) {
        console.error('\x1b[31m[Decryption Failed]\x1b[0m Integrity check failed or wrong key.');
        process.exit(1);
    }
}

// --- Constants & UI Helpers ---
const UI = {
    RESET: '\x1b[0m',
    BANNER_TARGET: '\x1b[41;97m SESSION ACTIVE \x1b[0m',
    BANNER_CTRL: '\x1b[44;97m SESSION ACTIVE \x1b[0m'
};

function resetTerminal() {
    if (process.stdout.isTTY) {
        process.stdout.write(UI.RESET);
    }
}

// --- Encryption Helpers (Wrapped for E2EE) ---

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

// --- Main Program ---

async function main() {
    const mode = args['mode'] || 'target';
    const isController = mode === 'controller';
    
    // TLS options
    const wsOptions = args['allow-insecure'] ? { rejectUnauthorized: false } : {};

    if (!isController) {
        // ==========================
        //        Target Mode
        // ==========================
        const uuid = crypto.randomUUID();
        const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const pubKeyStr = publicKey.export({ type: 'spki', format: 'pem' });
        const nonceT = crypto.randomBytes(16).toString('hex');

        console.log(`\x1b[32m[Target Mode]\x1b[0m UUID: \x1b[1m${uuid}\x1b[0m`);
        console.log(`Waiting for controller to initiate handshake...`);

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

            // If it's a secure message, decrypt it first
            if (msg.type === 'secure' && aesKey) {
                msg = decryptEnvelope(msg, aesKey);
                // After decryption, it will have the real type: input, resize, etc.
            }

            if (msg.type === 'handshake_init') {
                // Send proposal immediately so controller can also show SAS
                ws.send(JSON.stringify({ type: 'handshake_proposal', pub: pubKeyStr, nonce: nonceT }));
                
                const transcript = msg.pub + pubKeyStr + msg.nonce + nonceT;
                const sas = generateSAS(transcript);

                process.stdout.write(`\n\x1b[33m[!] Incoming connection. Verification Code: \x1b[1;36m${sas}\x1b[0m\n`);
                
                const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                const answer = await new Promise(resolve => rl.question('Approve this controller? [y/n]: ', resolve));
                rl.close();
                process.stdin.resume();

                if (answer.toLowerCase() === 'y') {
                    isApproved = true;
                    ws.send(JSON.stringify({ type: 'handshake_res', approved: true }));
                } else {
                    console.log('Rejected.');
                    ws.close();
                }
            } else if (msg.type === 'auth' && isApproved) {
                aesKey = crypto.privateDecrypt(privateKey, Buffer.from(msg.key, 'base64'));
                console.log(`\x1b[32m[OK] Encrypted Session Established.\x1b[0m`);
                
                const hotkey = args['hotkey'] || '\x18'; 
                const hotkeyName = hotkey === '\x18' ? 'Ctrl+X' : `ASCII(${hotkey.charCodeAt(0)})`;
                
                console.log(`${UI.BANNER_TARGET} Press \x1b[1m${hotkeyName}\x1b[0m to exit.`);
                
                startPty();
            } else if (msg.type === 'input' && aesKey && ptyProcess) {
                const input = msg.data.toString();
                if (input === '/quit\r') {
                    cleanup('Remote terminated via /quit.');
                    process.exit(0);
                }
                ptyProcess.write(input);
            } else if (msg.type === 'resize' && aesKey && ptyProcess) {
                const { cols, rows } = JSON.parse(msg.data.toString());
                ptyProcess.resize(cols, rows);
            } else if (msg.type === 'close') {
                cleanup('Session closed by peer.');
                process.exit(0);
            }
        });

        function startPty() {
            const shell = args['shell'] || (process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/zsh'));
            const hotkey = args['hotkey'] || '\x18';

            const cols = parseInt(process.stdout.columns) || 80;
            const rows = parseInt(process.stdout.rows) || 24;
            const cwd = process.env.HOME || process.cwd();

            process.stdin.removeAllListeners('data');

            try {
                ptyProcess = spawn(shell, [], {
                    name: 'xterm-256color',
                    cols,
                    rows,
                    cwd,
                    env: process.env
                });
            } catch (err) {
                console.error(`\x1b[31m[Error]\x1b[0m Failed to spawn shell (${shell}):`, err.message);
                process.exit(1);
            }

            if (process.stdin.isTTY) {
                process.stdin.setRawMode(true);
            }
            process.stdin.on('data', d => {
                const str = d.toString();
                if (str === hotkey) {
                    ws.send(JSON.stringify(encryptEnvelope('close', Buffer.alloc(0), aesKey)));
                    cleanup('You exited the session.');
                    process.exit(0);
                }
                if (!args['no-local-input']) ptyProcess.write(d);
            });

            ptyProcess.onData(data => {
                process.stdout.write(data);
                
                if (aesKey && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(encryptEnvelope('output', data, aesKey)));
                }
            });

            ptyProcess.onExit(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(encryptEnvelope('close', Buffer.alloc(0), aesKey)));
                }
                cleanup('Local shell exited.');
                process.exit(0);
            });
        }

    } else {
        // ==========================
        //        Controller Mode
        // ==========================
        const targetUuid = args['target-uuid'];
        if (!targetUuid) {
            console.error('Usage: node main.js --mode=controller --target-uuid=UUID [--allow-insecure]');
            process.exit(1);
        }

        const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const pubKeyStr = publicKey.export({ type: 'spki', format: 'pem' });
        const nonceC = crypto.randomBytes(16).toString('hex');
        const sessionKey = crypto.randomBytes(32);

        console.log(`\x1b[34m[Controller Mode]\x1b[0m Connecting to ${targetUuid}...`);
        const ws = new WebSocket(`${SERVER_URL}?id=${targetUuid}&role=controller`, wsOptions);

        let commandBuffer = '';

        ws.on('open', () => {
            console.log(`\x1b[90mConnected to relay, waiting for target...\x1b[0m`);
        });

        const cleanup = (reason = 'Disconnected.') => {
            console.log(`\n\x1b[33m[!] ${reason}\x1b[0m`);
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(false);
                process.stdin.pause();
            }
        };

        ws.on('message', (data) => {
            let msg = JSON.parse(data);

            if (msg.type === 'secure') {
                msg = decryptEnvelope(msg, sessionKey);
            }

            if (msg.type === 'session_sync' && msg.peer === 'target' && msg.status === 'ready') {
                console.log(`\x1b[32m[OK] Target is online. Initiating handshake...\x1b[0m`);
                ws.send(JSON.stringify({ type: 'handshake_init', pub: pubKeyStr, nonce: nonceC }));
            } else if (msg.type === 'handshake_proposal') {
                const transcript = pubKeyStr + msg.pub + nonceC + msg.nonce;
                const sas = generateSAS(transcript);
                console.log(`\x1b[33m[!] Handshake Initiated. Verification Code: \x1b[1;36m${sas}\x1b[0m`);
                console.log(`Waiting for target to approve...`);
                ws.targetPub = msg.pub;
            } else if (msg.type === 'handshake_res' && msg.approved) {
                console.log(`\x1b[32m[OK] Connection Approved by Target.\x1b[0m`);

                const encKey = crypto.publicEncrypt(ws.targetPub, sessionKey);
                ws.send(JSON.stringify({ type: 'auth', key: encKey.toString('base64') }));

                const hotkey = args['hotkey'] || '\x18'; 
                const hotkeyName = hotkey === '\x18' ? 'Ctrl+X' : `ASCII(${hotkey.charCodeAt(0)})`;
                console.log(`${UI.BANNER_CTRL} Press \x1b[1m${hotkeyName}\x1b[0m to exit.`);

                if (!args['read-only']) {
                    if (process.stdin.isTTY) process.stdin.setRawMode(true);
                    process.stdin.on('data', d => {
                        const str = d.toString();
                        if (str === hotkey) {
                            ws.send(JSON.stringify(encryptEnvelope('close', Buffer.alloc(0), sessionKey)));
                            cleanup('You exited the session.');
                            process.exit(0);
                        }
                        
                        commandBuffer += str;
                        if (commandBuffer.includes('/quit\r')) {
                             ws.send(JSON.stringify(encryptEnvelope('input', Buffer.from('/quit\r'), sessionKey)));
                             setTimeout(() => { cleanup('Sent /quit to target.'); process.exit(0); }, 100);
                             return;
                        }
                        if (commandBuffer.length > 20) commandBuffer = commandBuffer.slice(-10);

                        ws.send(JSON.stringify(encryptEnvelope('input', d, sessionKey)));
                    });
                } else {
                    console.log(`\x1b[90m(Read-only mode active)\x1b[0m`);
                }
                
                process.stdout.on('resize', () => {
                    ws.send(JSON.stringify(encryptEnvelope('resize', Buffer.from(JSON.stringify({ cols: process.stdout.columns, rows: process.stdout.rows })), sessionKey)));
                });
            } else if (msg.type === 'output') {
                process.stdout.write(msg.data);
            } else if (msg.type === 'close') {
                cleanup('Session closed by peer.');
                process.exit(0);
            }
        });

        ws.on('close', () => {
            cleanup('Connection lost.');
            process.exit(0);
        });
    }
}

main().catch(console.error);
