#!/usr/bin/env node
const { WebSocketServer } = require('ws');
const http = require('http');
const url = require('url');
const { hasArg, getArgValue, normalizeWsPath, resolveWsPaths } = require('../relay/ws-path-config');

const args = process.argv.slice(2);

if (hasArg(args, '--path', '-pt')) {
  console.error('[Relay Server] `--path` has been removed. Please use `--paths`.');
  process.exit(1);
}

if (process.env.WS_PATH || process.env.API_BASE) {
  console.error('[Relay Server] `WS_PATH`/`API_BASE` has been removed. Please use `WS_PATHS`.');
  process.exit(1);
}

const port = parseInt(getArgValue(args, '--port', '-p') || process.env.PORT || '8899', 10);
const host = getArgValue(args, '--host', '-h') || process.env.HOST || '0.0.0.0';
const wsPaths = resolveWsPaths(args, process.env);
const wsPathSet = new Set(wsPaths);

const sessions = new Map();
const server = http.createServer();
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const pathname = normalizeWsPath(url.parse(req.url).pathname);

  if (!pathname || !wsPathSet.has(pathname)) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit('connection', ws, req);
  });
});

server.on('listening', () => {
  console.log(`[Relay Server] Listening on ${host}:${port} (${wsPaths.join(', ')})`);
});

wss.on('error', (err) => {
  console.error('[Relay Server] Server Error:', err);
});

server.listen(port, host);

wss.on('connection', (ws, req) => {
  const params = url.parse(req.url, true).query;
  const id = params.id;
  const role = params.role;

  console.log(`[Relay] New connection: role=${role}, id=${id}`);

  if (!id || !role) {
    ws.close();
    return;
  }

  if (!sessions.has(id)) {
    sessions.set(id, {});
  }

  const session = sessions.get(id);
  if (role === 'target') {
    session.target = ws;
    console.log(`[Relay] Target joined session: ${id}`);
  } else if (role === 'controller') {
    session.controller = ws;
    console.log(`[Relay] Controller joined session: ${id}`);
  }

  // If both are now present, notify them
  if (session.target && session.controller && 
      session.target.readyState === 1 && session.controller.readyState === 1) {
      console.log(`[Relay] Session ${id} fully connected. Notifying peers.`);
      session.target.send(JSON.stringify({ type: 'session_sync', peer: 'controller', status: 'ready' }));
      session.controller.send(JSON.stringify({ type: 'session_sync', peer: 'target', status: 'ready' }));
  }

  ws.on('message', (message) => {
    const session = sessions.get(id);
    if (!session) return;
    
    let peer = (role === 'target') ? session.controller : session.target;
    if (peer && peer.readyState === 1) {
      peer.send(message);
    }
  });

  ws.on('close', () => {
    console.log(`[Relay] Connection closed: role=${role}, id=${id}`);
    let peer = (role === 'target') ? session.controller : session.target;
    if (peer && (peer.readyState === 1 || peer.readyState === 0)) {
      peer.close();
    }
    if (role === 'target') {
      delete session.target;
    } else {
      delete session.controller;
    }
    if (!session.target && !session.controller) {
      sessions.delete(id);
    }
  });

  ws.on('error', (err) => {
    console.error(`[Relay] WS Error:`, err);
  });
});
