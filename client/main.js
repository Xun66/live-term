#!/usr/bin/env node

const WebSocket = require('ws');
const { spawn } = require('node-pty');
const crypto = require('crypto');
const readline = require('readline');
const { getLinearBackoffDelay } = require('./reconnect');
const { DEFAULT_MAX_AGE_MS, DEFAULT_MAX_BYTES, ReplayBuffer } = require('./replay-buffer');

// --- Configuration ---
const args = process.argv.slice(2).reduce((acc, arg) => {
    const [k, v] = arg.split('=');
    acc[k.replace('--', '')] = v === undefined ? true : v;
    return acc;
}, {});

const mode = args['mode'] || 'target'; 
const RELAY_URL = args['relay'] || process.env.TERMINAL_RELAY_URL || 'wss://xebox.org/live-term/ws';

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

function parsePositiveInt(value, fallback) {
    if (value === undefined) return fallback;
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const HOTKEY = parseHotkey(args['hotkey']);
const HOTKEY_DISPLAY = args['hotkey'] || 'Ctrl+X';
const MAX_CONTROLLER_RETRIES = 2;
const REPLAY_BUFFER_BYTES = parsePositiveInt(args['replay-buffer-bytes'], DEFAULT_MAX_BYTES);
const REPLAY_BUFFER_MS = parsePositiveInt(args['replay-buffer-ms'], DEFAULT_MAX_AGE_MS);

// Security Check: Enforce --allow-insecure for ws://
if (RELAY_URL.startsWith('ws://') && !args['allow-insecure']) {
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

function encryptJsonEnvelope(type, data, key) {
    return encryptEnvelope(type, Buffer.from(JSON.stringify(data)), key);
}

function parseJsonEnvelopeData(msg) {
    return JSON.parse(msg.data.toString());
}

const UI = {
    RESET: '\x1b[0m',
    TERMINAL_STYLE_RESET: '\x1b[0m\x1b[?25h\x1b[?12l\x1b[0 q\x1b]112\x07',
    BANNER_TARGET: '\x1b[41;97m SESSION ACTIVE \x1b[0m',
    BANNER_CTRL: '\x1b[44;97m SESSION ACTIVE \x1b[0m'
};

function resetTerminal() {
    if (process.stdout.isTTY) process.stdout.write(UI.RESET);
}

function resetTerminalStyle() {
    if (process.stdout.isTTY) process.stdout.write(UI.TERMINAL_STYLE_RESET);
}

function buildRelayConnectionUrl(sessionId, role) {
    const relayUrl = new URL(RELAY_URL);
    relayUrl.searchParams.set('id', sessionId);
    relayUrl.searchParams.set('role', role);
    return relayUrl.toString();
}

function logReconnect(role, attempt, connect) {
    const delayMs = getLinearBackoffDelay(attempt);
    console.log(`\x1b[90m[${role}] Reconnecting in ${delayMs / 1000}s...\x1b[0m`);
    setTimeout(connect, delayMs);
}

// --- Main Program ---

async function main() {
    const isController = mode === 'controller';
    const wsOptions = args['allow-insecure'] ? { rejectUnauthorized: false } : {};
    console.log(`\x1b[90musing relay: ${RELAY_URL}\x1b[0m`);

    if (!isController) {
        // ==========================
        //        Target Mode
        // ==========================
        const uuid = args['id'] || crypto.randomUUID();

        console.log(`\x1b[32m[Target Mode]\x1b[0m Session ID: \x1b[1;36m${uuid}\x1b[0m`);
        console.log(`Waiting for controller to connect...`);

        let ws = null;
        let aesKey = null;
        let ptyProcess = null;
        let replayReady = false;
        let shouldReconnect = true;
        let reconnectAttempt = 0;
        const replayBuffer = new ReplayBuffer({
            maxBytes: REPLAY_BUFFER_BYTES,
            maxAgeMs: REPLAY_BUFFER_MS
        });

        const cleanup = (reason = 'Session ended.') => {
            resetTerminal();
            console.log(`\n\x1b[33m[!] ${reason}\x1b[0m`);
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(false);
                process.stdin.pause();
            }
        };

        connectTarget();

        function connectTarget() {
            const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
            const pubKeyStr = publicKey.export({ type: 'spki', format: 'pem' });
            const nonceT = crypto.randomBytes(16).toString('hex');
            let isApproved = false;

            ws = new WebSocket(buildRelayConnectionUrl(uuid, 'target'), wsOptions);

            ws.on('open', () => {
                reconnectAttempt = 0;
                console.log(`\x1b[32m[OK]\x1b[0m Connected to relay as target.`);
            });

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
                    }
                } else if (msg.type === 'auth' && isApproved) {
                    aesKey = crypto.privateDecrypt(privateKey, Buffer.from(msg.key, 'base64'));
                    replayReady = false;
                    console.log(`\x1b[32m[OK] Encrypted Session Established.\x1b[0m`);
                    console.log(`${UI.BANNER_TARGET} Press \x1b[1m${HOTKEY_DISPLAY}\x1b[0m to exit.`);
                    if (ptyProcess) {
                        enableTargetInput();
                    } else {
                        startPty();
                    }
                } else if (msg.type === 'input' && aesKey && replayReady && ptyProcess) {
                    ptyProcess.write(msg.data.toString());
                } else if (msg.type === 'resize' && aesKey && replayReady && ptyProcess) {
                    const { cols, rows } = JSON.parse(msg.data.toString());
                    ptyProcess.resize(cols, rows);
                } else if (msg.type === 'resume' && aesKey) {
                    const { lastSeq } = parseJsonEnvelopeData(msg);
                    sendReplay(lastSeq);
                } else if (msg.type === 'close') {
                    shouldReconnect = false;
                    cleanup('Session closed by peer.');
                    process.exit(0);
                }
            });

            ws.on('close', () => {
                aesKey = null;
                replayReady = false;
                cleanup('Relay connection closed.');
                if (shouldReconnect) {
                    reconnectAttempt += 1;
                    logReconnect('Target', reconnectAttempt, connectTarget);
                }
            });

            ws.on('error', (e) => {
                console.error(`\x1b[31m[Connection error]\x1b[0m ${e.message}`);
            });
        }

        function enableTargetInput() {
            if (process.stdin.isTTY) process.stdin.setRawMode(true);
            process.stdin.resume();
        }

        function startPty() {
            process.stdin.removeAllListeners('data');
            const shell = args['shell'] || (process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/zsh'));
            const cols = parseInt(process.stdout.columns) || 80;
            const rows = parseInt(process.stdout.rows) || 24;
            
            try {
                ptyProcess = spawn(shell, [], {
                    name: 'xterm-256color',
                    cols,
                    rows,
                    cwd: process.env.HOME || process.cwd(),
                    env: process.env
                });
            } catch (err) {
                console.error(`\x1b[31m[Error]\x1b[0m Failed to spawn shell (${shell}):`, err.message);
                if (err.message.includes('posix_spawnp') && process.platform === 'darwin') {
                    console.error('\n\x1b[33m[Hint]\x1b[0m This error often occurs on macOS when node-pty spawn-helper lacks execute permissions.');
                    console.error('Try running: \x1b[1mchmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper\x1b[0m');
                }
                process.exit(1);
            }

            if (process.stdin.isTTY) process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.on('data', d => {
                if (d.toString() === HOTKEY) {
                    shouldReconnect = false;
                    if (aesKey && ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify(encryptEnvelope('close', Buffer.alloc(0), aesKey)));
                    }
                    cleanup('You exited.');
                    process.exit(0);
                }
                if (!args['no-local-input']) ptyProcess.write(d);
            });

            ptyProcess.onData(data => {
                const entry = replayBuffer.append(data);
                process.stdout.write(data);
                sendOutput(entry, false);
            });

            ptyProcess.onExit(() => {
                shouldReconnect = false;
                if (aesKey && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(encryptEnvelope('close', Buffer.alloc(0), aesKey)));
                cleanup('Local shell exited.');
                process.exit(0);
            });
        }

        function sendOutput(entry, replay) {
            if (!aesKey || !replayReady || !ws || ws.readyState !== WebSocket.OPEN) return;
            ws.send(JSON.stringify(encryptJsonEnvelope('output', {
                seq: entry.seq,
                replay,
                data: entry.data.toString('base64')
            }, aesKey)));
        }

        function sendReplay(lastSeq) {
            if (!aesKey || !ws || ws.readyState !== WebSocket.OPEN) return;

            const normalizedLastSeq = Number.isFinite(lastSeq) && lastSeq >= 0 ? lastSeq : 0;
            const requestedSeq = normalizedLastSeq + 1;
            const missed = replayBuffer.hasMissed(requestedSeq);
            const entries = replayBuffer.getAfter(normalizedLastSeq);

            ws.send(JSON.stringify(encryptJsonEnvelope('replay_start', {
                fromSeq: entries[0] ? entries[0].seq : requestedSeq,
                latestSeq: replayBuffer.getLatestSeq()
            }, aesKey)));

            if (missed) {
                ws.send(JSON.stringify(encryptJsonEnvelope('replay_miss', {
                    requestedSeq,
                    earliestSeq: replayBuffer.getEarliestSeq(),
                    latestSeq: replayBuffer.getLatestSeq()
                }, aesKey)));
            }

            replayReady = true;
            for (const entry of entries) {
                sendOutput(entry, true);
            }

            ws.send(JSON.stringify(encryptJsonEnvelope('replay_done', {
                latestSeq: replayBuffer.getLatestSeq(),
                missed
            }, aesKey)));
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

        console.log(`\x1b[34m[Controller Mode]\x1b[0m Connecting to target: \x1b[1;36m${targetId}\x1b[0m...`);
        let reconnectAttempt = 0;
        let shouldReconnect = true;
        let inputHandler = null;
        let resizeHandler = null;
        let lastOutputSeq = 0;

        const cleanup = (reason = 'Disconnected.') => {
            resetTerminalStyle();
            console.log(`\n\x1b[33m[!] ${reason}\x1b[0m`);
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(false);
                process.stdin.pause();
            }
        };

        process.once('exit', resetTerminalStyle);
        connectController();

        function exitAfterReconnects() {
            shouldReconnect = false;
            cleanup(`Unable to reconnect after ${MAX_CONTROLLER_RETRIES} retries.`);
            console.log('\x1b[90mHint: if the target comes back online later, run the same live-term command again to reconnect.\x1b[0m');
            process.exit(1);
        }

        function connectController() {
            const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
            const pubKeyStr = publicKey.export({ type: 'spki', format: 'pem' });
            const nonceC = crypto.randomBytes(16).toString('hex');
            const sessionKey = crypto.randomBytes(32);
            const ws = new WebSocket(buildRelayConnectionUrl(targetId, 'controller'), wsOptions);

            ws.on('open', () => {
                console.log(`\x1b[32m[OK]\x1b[0m Connected to relay as controller.`);
            });

            ws.on('message', (data) => {
                let msg = JSON.parse(data);
                if (msg.type === 'secure') msg = decryptEnvelope(msg, sessionKey);

                if (msg.type === 'error') {
                    console.log(`\x1b[33m[Relay]\x1b[0m ${msg.message}`);
                    ws.close();
                    return;
                }

                if (msg.type === 'session_sync' && msg.peer === 'target' && msg.status === 'ready') {
                    console.log(`\x1b[32m[OK] Target is online. Handshaking...\x1b[0m`);
                    ws.send(JSON.stringify({ type: 'handshake_init', pub: pubKeyStr, nonce: nonceC }));
                } else if (msg.type === 'handshake_proposal') {
                    const sas = generateSAS(pubKeyStr + msg.pub + nonceC + msg.nonce);
                    console.log(`\x1b[33m[!] Verification Code: \x1b[1;36m${sas}\x1b[0m (Waiting for approval)`);
                    ws.targetPub = msg.pub;
                } else if (msg.type === 'handshake_res' && msg.approved) {
                    reconnectAttempt = 0;
                    console.log(`\x1b[32m[OK] Approved.\x1b[0m`);
                    ws.send(JSON.stringify({ type: 'auth', key: crypto.publicEncrypt(ws.targetPub, sessionKey).toString('base64') }));
                    ws.send(JSON.stringify(encryptJsonEnvelope('resume', { lastSeq: lastOutputSeq }, sessionKey)));
                    console.log('\x1b[90mReplaying buffered output...\x1b[0m');
                } else if (msg.type === 'output') {
                    const output = parseJsonEnvelopeData(msg);
                    if (Number.isFinite(output.seq)) {
                        lastOutputSeq = Math.max(lastOutputSeq, output.seq);
                    }
                    process.stdout.write(Buffer.from(output.data, 'base64'));
                } else if (msg.type === 'replay_miss') {
                    const miss = parseJsonEnvelopeData(msg);
                    resetTerminalStyle();
                    console.log(`\n\x1b[33m[!] Terminal output was lost while disconnected. Requested seq ${miss.requestedSeq}, earliest available seq ${miss.earliestSeq}.\x1b[0m`);
                } else if (msg.type === 'replay_done') {
                    const replay = parseJsonEnvelopeData(msg);
                    if (Number.isFinite(replay.latestSeq)) {
                        lastOutputSeq = Math.max(lastOutputSeq, replay.latestSeq);
                    }
                    console.log(`${UI.BANNER_CTRL} Press \x1b[1m${HOTKEY_DISPLAY}\x1b[0m to exit.`);
                    attachControllerSession(ws, sessionKey);
                } else if (msg.type === 'close') {
                    shouldReconnect = false;
                    cleanup('Closed by peer.');
                    process.exit(0);
                }
            });

            ws.on('close', () => {
                detachControllerSession();
                cleanup('Relay connection closed.');
                if (shouldReconnect) {
                    if (reconnectAttempt >= MAX_CONTROLLER_RETRIES) {
                        exitAfterReconnects();
                    } else {
                        reconnectAttempt += 1;
                        logReconnect('Controller', reconnectAttempt, connectController);
                    }
                }
            });

            ws.on('error', (e) => {
                console.error(`\x1b[31m[Connection error]\x1b[0m ${e.message}`);
            });
        }

        function attachControllerSession(ws, sessionKey) {
            detachControllerSession();

            if (!args['read-only']) {
                if (process.stdin.isTTY) process.stdin.setRawMode(true);
                process.stdin.resume();
                inputHandler = d => {
                    if (d.toString() === HOTKEY) {
                        shouldReconnect = false;
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify(encryptEnvelope('close', Buffer.alloc(0), sessionKey)));
                        }
                        cleanup('You exited.');
                        process.exit(0);
                    }
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify(encryptEnvelope('input', d, sessionKey)));
                    }
                };
                process.stdin.on('data', inputHandler);
            }

            resizeHandler = () => {
                if (ws.readyState !== WebSocket.OPEN) return;
                const data = JSON.stringify({ cols: process.stdout.columns, rows: process.stdout.rows });
                ws.send(JSON.stringify(encryptEnvelope('resize', data, sessionKey)));
            };
            resizeHandler();
            process.stdout.on('resize', resizeHandler);
        }

        function detachControllerSession() {
            if (inputHandler) {
                process.stdin.removeListener('data', inputHandler);
                inputHandler = null;
            }
            if (resizeHandler) {
                process.stdout.removeListener('resize', resizeHandler);
                resizeHandler = null;
            }
        }
    }
}

main().catch(console.error);
