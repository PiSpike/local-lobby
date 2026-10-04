/**
 * server.js — local-lobby server entry point.
 *
 * Serves:
 *   /                -> public/   (launcher landing page + arcade-sdk.js)
 *   /games/...       -> games/    (game clones, e.g. /games/tictactoe/index.html)
 *   /socket.io/...   -> Socket.io (client dist served from node_modules, offline-safe)
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');

const express = require('express');
const { Server } = require('socket.io');

const { RoomManager } = require('./rooms');
const { Persistence } = require('./persistence');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });

// ---------------------------------------------------------------------------
// Persistence + RoomManager bootstrap
// ---------------------------------------------------------------------------

const persistence = new Persistence();
const rooms = new RoomManager(persistence);
persistence.bind(rooms);

(async () => {
  const persisted = await persistence.init();
  rooms.restore(persisted);
  const restored = Object.keys(persisted).filter((c) => rooms.get(c));
  if (restored.length) {
    console.log(`[rooms] restored ${restored.length} persisted room(s): ${restored.join(', ')}`);
  }
})().catch((err) => {
  console.error('[persistence] init failed:', err);
});

// ---------------------------------------------------------------------------
// Static hosting (local network, zero-internet)
// ---------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));
app.use('/games', express.static(path.join(__dirname, 'games')));

// Game registry for the launcher (must live inside games/ to be static).
app.get('/api/games', (req, res) => {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'games', 'manifest.json'), 'utf8')
    );
    res.json(manifest.games || manifest);
  } catch (err) {
    res.status(500).json({ error: 'MANIFEST_UNREADABLE', detail: err.message });
  }
});

// Room list for the launcher "Join" screen.
app.get('/api/rooms', (req, res) => {
  res.json({ rooms: rooms.list() });
});

// ---------------------------------------------------------------------------
// Socket.IO — all game traffic is routed through the RoomManager
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  const myRoom = () => rooms.roomOfSocket(socket.id);

  function pruneStaleRoomMembers(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;
    for (const sid of [...room.players.keys()]) {
      if (!io.sockets.sockets.has(sid)) {
        rooms.leave(room.code, sid);
      }
    }
  }

  socket.on('room:create', async ({ gameId, hostName, initialState } = {}, ack) => {
    try {
      const room = rooms.create({ gameId, hostName, initialState });
      rooms.join(room.code, socket.id, hostName);
      await socket.join(room.code);
      const snap = rooms.snapshot(room.code);
      socket.emit('room:joined', snap);
      io.to(room.code).emit('room:player', { roomCode: room.code, players: snap.players });
      if (typeof ack === 'function') ack({ ok: true, roomCode: room.code, snapshot: snap });
      console.log(`[room] ${room.code} created by ${hostName || 'host'} (${gameId || 'unknown'})`);
    } catch (err) {
      console.error('[room:create]', err);
      if (typeof ack === 'function') ack({ ok: false, error: 'CREATE_FAILED' });
    }
  });

  socket.on('room:join', async ({ roomCode, playerName } = {}, ack) => {
    const room = rooms.get(roomCode);
    if (room) pruneStaleRoomMembers(room.code);
    const res = rooms.join(roomCode, socket.id, playerName);
    if (!res.ok) return typeof ack === 'function' && ack({ ok: false, error: res.error });
    const joinedRoom = res.room;
    await socket.join(joinedRoom.code);
    const snap = rooms.snapshot(joinedRoom.code);
    socket.emit('room:joined', snap); // snapshot goes ONLY to this socket
    io.to(joinedRoom.code).emit('room:player', { roomCode: joinedRoom.code, players: snap.players, started: !!snap.started });
    if (typeof ack === 'function') ack({ ok: true, roomCode: joinedRoom.code, snapshot: snap });
    console.log(`[room] ${playerName || socket.id} joined ${joinedRoom.code}`);
  });

  socket.on('room:start', (ack) => {
    const room = myRoom();
    if (!room) return typeof ack === 'function' && ack({ ok: false, error: 'NOT_IN_ROOM' });
    const res = rooms.start(room.code);
    if (!res.ok) return typeof ack === 'function' && ack({ ok: false, error: res.error });
    const snap = rooms.snapshot(room.code);
    io.to(room.code).emit('room:started', { roomCode: room.code, started: true, snapshot: snap });
    io.to(room.code).emit('room:player', { roomCode: room.code, players: snap.players, started: true });
    if (typeof ack === 'function') ack({ ok: true, snapshot: snap });
  });

  socket.on('room:leave', (ack) => {
    const room = myRoom();
    if (room) {
      const code = room.code;
      rooms.leave(code, socket.id);
      socket.leave(code);
      const snap = rooms.snapshot(code);
      if (snap) {
        io.to(code).emit('room:player', {
          roomCode: code,
          players: snap.players,
        });
      }
    }
    if (typeof ack === 'function') ack({ ok: true });
  });

  /**
   * The one event that mutates game state. Always validated against the
   * manager, applied in-memory, persisted asynchronously, then broadcast
   * ONLY to this room (io.to(room.code)).
   */
  socket.on('game:move', (payload, ack) => {
    const room = myRoom();
    if (!room) return typeof ack === 'function' && ack({ ok: false, error: 'NOT_IN_ROOM' });
    if (room.status === 'closed') return typeof ack === 'function' && ack({ ok: false, error: 'ROOM_CLOSED' });
    if (!payload || typeof payload !== 'object') return typeof ack === 'function' && ack({ ok: false, error: 'BAD_PAYLOAD' });

    const state = rooms.applyMove(room, payload);
    io.to(room.code).emit('game:state', { roomCode: room.code, state, at: room.updatedAt });
    if (typeof ack === 'function') ack({ ok: true, state, at: room.updatedAt });
  });

  socket.on('room:state', (ack) => {
    const room = myRoom();
    if (typeof ack === 'function') {
      ack({ ok: !!room, snapshot: room ? rooms.snapshot(room.code) : null });
    }
  });

  socket.on('room:close', ({ reason } = {}, ack) => {
    const room = myRoom();
    if (room && room.players.size > 0) {
      rooms.close(room.code, socket.id, reason);
      socket.leave(room.code);
      if (typeof ack === 'function') ack({ ok: true });
    } else if (typeof ack === 'function') {
      ack({ ok: false, error: 'NOT_IN_ROOM' });
    }
  });

  socket.on('disconnect', () => {
    const room = myRoom();
    if (room) {
      const code = room.code;
      rooms.leave(code, socket.id);
      const snap = rooms.snapshot(code);
      if (snap) {
        io.to(code).emit('room:player', {
          roomCode: code,
          players: snap.players,
        });
      }
      console.log(`[room] ${socket.id} disconnected from ${code}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Boot + LAN URL banner
// ---------------------------------------------------------------------------

function lanUrls() {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) urls.push(`http://${net.address}:${PORT}`);
    }
  }
  urls.push(`http://localhost:${PORT}`);
  return urls;
}

server.listen(PORT, HOST, () => {
  console.log('==================================================');
  console.log('  local-lobby — offline game launcher server');
  console.log('==================================================');
  console.log('Point mobile devices on the same Wi-Fi at:');
  for (const url of lanUrls()) console.log(`  ${url}`);
  console.log('');
  console.log('Games:   /games/<id>/index.html?room=<ROOM-###>');
  console.log('DB:      data/rooms.json (async, coalesced writes)');
});

process.on('SIGINT', async () => {
  console.log('\n[server] shutting down — flushing pending writes...');
  await persistence._flush().catch(() => {});
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
});
