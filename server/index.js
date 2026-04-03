#!/usr/bin/env node
const { WebSocketServer } = require('ws');
const url = require('url');

const args = process.argv.slice(2);
function getArg(name, short) {
  const index = args.findIndex(arg => arg === name || arg === short);
  if (index !== -1 && index + 1 < args.length) {
    return args[index + 1];
  }
  return null;
}

const port = parseInt(getArg('--port', '-p') || process.env.PORT || '8899', 10);
const host = getArg('--host', '-h') || process.env.HOST || '0.0.0.0';

const sessions = new Map();
const wss = new WebSocketServer({ 
  port: port, 
  host: host,
  path: '/chat' 
});

wss.on('listening', () => {
    console.log(`[Relay Server] Listening on ${host}:${port}/chat`);
});

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
