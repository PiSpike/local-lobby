/**
 * persistence.js — automatic board-state persistence.
 *
 * - In-memory state is mutated synchronously (fast moves, no latency).
 * - Writes to the local JSON database (lowdb) are queued ASYNCHRONOUSLY and
 *   coalesced: a burst of moves results in a single file write.
 * - On boot, the last known states are reloaded so rooms survive restarts.
 */

const fs = require('fs');
const path = require('path');
const { JSONFile } = require('lowdb/node');

const DB_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DB_DIR, 'rooms.json');

class Persistence {
  constructor(filePath = DB_FILE) {
    this.filePath = filePath;
    this.queue = new Set(); // roomCodes pending write (dedup)
    this.flushScheduled = false;
    this.ready = false; // true once init() completes; flushes wait on this
  }

  async init() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.adapter = new JSONFile(this.filePath);
    this.data = (await this.adapter.read()) || {};
    if (!this.data.rooms) this.data.rooms = {};
    await this.adapter.write(this.data); // no-op if file already correct; creates if not
    this.ready = true;
    // Drain anything queued during startup (before the adapter existed).
    if (this.queue.size) this._flush().catch(() => {});
    return this.data.rooms;
  }

  /**
   * Record a move for a room. Pure bookkeeping: `room.state` has already been
   * mutated by the caller. Triggers an async, coalesced write.
   */
  record(roomCode, serializedRoom) {
    this.queue.add(roomCode);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      setImmediate(() => this._flush());
    }
  }

  /**
   * Serialize a room into its persistable form.
   * (player Socket.IO ids are dropped — presence is rebuilt on connect.)
   */
  static serialize(room) {
    if (!room) return null;
    return {
      code: room.code,
      gameId: room.gameId,
      hostName: room.hostName,
      state: room.state,
      status: room.status,
      started: !!room.started,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
    };
  }

  async _flush() {
    this.flushScheduled = false;
    if (!this.adapter || !this.ready) return; // queue survives; flushed on next write

    const codes = [...this.queue];
    this.queue.clear();

    // Fresh read of the file so we never clobber records written by a
    // concurrent flush that finished while we were serializing.
    const snapshot = (await this.adapter.read()) || {};
    const data = snapshot.rooms ? snapshot : { rooms: {} };
    for (const code of codes) {
      const live = this._rooms ? this._rooms.get(code) : null;
      if (!live) {
        delete data.rooms[code];
        continue;
      }
      const serialized = Persistence.serialize(live);
      if (serialized) data.rooms[code] = serialized;
      else delete data.rooms[code];
    }
    try {
      await this.adapter.write(data);
      this.data = data;
    } catch (err) {
      console.error(`[persistence] write failed for [${codes.join(', ')}]:`, err.message);
      // Re-queue failed codes so the next move retries persistence.
      codes.forEach((c) => this.queue.add(c));
    }
  }

  /** Wire in the RoomManager so flushes can serialize live room objects. */
  bind(rooms) {
    this._rooms = rooms;
    return this;
  }

  /** Load persisted room records at startup. Returns { roomCode: serialized }. */
  loadAll() {
    return this.data && this.data.rooms ? this.data.rooms : {};
  }
}

module.exports = { Persistence };
