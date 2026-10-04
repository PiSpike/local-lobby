/**
 * rooms.js — central RoomManager.
 *
 * Isolates all WebSocket events by room ID (e.g. ROOM-101):
 *   - Every game event is validated against the manager before it touches
 *     a room, and is ONLY ever broadcast with io.to(roomCode), so two
 *     rooms can never see each other's moves or presence.
 *   - In-memory state updates on every move; persistence is delegated
 *     asynchronously to the Persistence layer.
 */

const PERSIST_DEBOUNCE_MS = 150; // coalesce bursty moves into one write

class RoomManager {
  constructor(persistence) {
    this.rooms = new Map(); // roomCode -> room object
    this.persistence = persistence;
    this.playerIndex = new Map(); // socketId -> roomCode
    this._counter = 0;
    this._flushTimer = null;
  }

  /** Next human-friendly code: ROOM-101, ROOM-102, ... */
  _nextCode() {
    this._counter += 1;
    let code;
    do {
      code = `ROOM-${100 + this._counter}`;
    } while (this.rooms.has(code));
    return code;
  }

  /**
   * Restore persisted rooms at boot. Presence is empty — players rejoin.
   * `persisted` = { "ROOM-101": { gameId, state, status, hostName, ... } }
   */
  restore(persisted) {
    for (const [code, rec] of Object.entries(persisted)) {
      if (!code || !code.startsWith('ROOM-')) continue;
      if (!rec || rec.status === 'closed') continue; // stale, do not auto-rejoin on restart
      this.rooms.set(code, {
        code,
        gameId: rec.gameId,
        hostName: rec.hostName || null,
        state: rec.state || {},
        status: rec.status || 'open',
        started: !!rec.started,
        createdAt: rec.createdAt || Date.now(),
        updatedAt: rec.updatedAt || Date.now(),
        players: new Map(), // socketId -> { name, joinedAt }
      });
      const num = parseInt(code.slice('ROOM-'.length), 10);
      if (Number.isFinite(num)) this._counter = Math.max(this._counter, num - 100);
    }
  }

  create({ gameId, hostName, initialState }) {
    const code = this._nextCode();
    const room = {
      code,
      gameId,
      hostName: hostName || 'host',
      state: typeof initialState === 'object' && initialState ? { ...initialState } : {},
      status: 'open',
      started: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      players: new Map(),
    };
    this.rooms.set(code, room);
    this._persistSoon(code);
    return room;
  }

  get(code) {
    return this.rooms.get(this._normalize(code));
  }

  /** Live room object for a socket (used to validate moves). */
  roomOfSocket(socketId) {
    const code = this.playerIndex.get(socketId);
    return code ? this.rooms.get(code) : null;
  }

  list() {
    return [...this.rooms.values()].map((r) => ({
      code: r.code,
      gameId: r.gameId,
      status: r.status,
      playerCount: r.players.size,
      hostName: r.hostName,
      playerNames: [...r.players.values()].map((p) => p.name || 'player'),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  join(code, socketId, name) {
    const room = this.get(code);
    if (!room) return { ok: false, error: 'ROOM_NOT_FOUND' };
    if (room.status === 'closed') return { ok: false, error: 'ROOM_CLOSED' };
    if (room.started) return { ok: false, error: 'GAME_STARTED' };

    const maxPlayers = room.gameId === 'tictactoe' ? 2 : Infinity;
    if (room.players.size >= maxPlayers && !room.players.has(socketId)) {
      return { ok: false, error: 'ROOM_FULL' };
    }

    const normalized = (name || 'player').trim() || 'player';
    const prev = this.playerIndex.get(socketId);
    if (prev && prev !== room.code) this.leave(prev, socketId); // one room per client

    // Same human name should not appear twice in the same room. If a previous
    // socket joined under the same display name, swap it out and keep only the
    // newest connection for that player identity.
    for (const [existingSocketId, meta] of [...room.players.entries()]) {
      if (existingSocketId === socketId) continue;
      if ((meta.name || 'player').toLowerCase() === normalized.toLowerCase()) {
        room.players.delete(existingSocketId);
        this.playerIndex.delete(existingSocketId);
      }
    }

    room.players.set(socketId, { name: normalized, joinedAt: Date.now() });
    this.playerIndex.set(socketId, room.code);
    room.updatedAt = Date.now();
    this._persistSoon(code);
    return { ok: true, room };
  }

  leave(code, socketId) {
    const room = this.get(code);
    if (!room || !room.players.has(socketId)) return;
    room.players.delete(socketId);
    this.playerIndex.delete(socketId);
    room.updatedAt = Date.now();

    if (room.players.size === 0) {
      room.status = 'closed';
      room.started = false;
      this.rooms.delete(room.code);
      this._persistNow(code);
    } else {
      this._persistSoon(code);
    }
  }

  start(code) {
    const room = this.get(code);
    if (!room || room.status === 'closed') return { ok: false, error: 'ROOM_NOT_FOUND' };
    if (room.players.size < 2) return { ok: false, error: 'NOT_ENOUGH_PLAYERS' };
    room.started = true;
    room.status = 'playing';
    room.updatedAt = Date.now();
    this._persistSoon(code);
    return { ok: true, room };
  }

  /**
   * Record a move: mutate in-memory state synchronously, then persist
   * asynchronously. Returns the updated state.
   */
  applyMove(room, payload) {
    room.state = this._mergeMove(room.state, payload);
    room.updatedAt = Date.now();
    this._persistSoon(room.code);
    return room.state;
  }

  _mergeMove(current, payload) {
    // Default reducer: shallow-merge the payload's `patch` into the board
    // state. The SDK sends { patch, meta }; games keep their own shape.
    if (payload && typeof payload === 'object') {
      const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : payload;
      return { ...current, ...patch, lastMove: payload.meta || null };
    }
    return current;
  }

  close(code, socketId, reason) {
    const room = this.get(code);
    if (!room) return;
    room.status = 'closed';
    room.started = false;
    room.updatedAt = Date.now();
    this._persistNow(code);
    for (const sid of [...room.players.keys()]) this.leave(code, sid);
  }

  /** Full snapshot for late-joiners / the launcher. */
  snapshot(code) {
    const room = this.get(code);
    if (!room) return null;
    return {
      code: room.code,
      gameId: room.gameId,
      status: room.status,
      started: !!room.started,
      hostName: room.hostName,
      state: room.state,
      players: [...room.players.entries()].map(([socketId, p]) => ({
        socketId,
        name: p.name,
        joinedAt: p.joinedAt,
      })),
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
    };
  }

  _normalize(code) {
    return typeof code === 'string' ? code.trim().toUpperCase() : null;
  }

  // ---- persistence glue -------------------------------------------------

  _persistSoon(code) {
    this.persistence.record(code, null);
    if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => {
        this._flushTimer = null;
        this.persistence._flush();
      }, PERSIST_DEBOUNCE_MS);
    }
  }

  _persistNow(code) {
    this._persistSoon(code);
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
      this.persistence._flush();
    }
  }
}

module.exports = { RoomManager };
