/*
 * arcade-sdk.js — bind any game clone to a local-lobby room.
 *
 * Inject into your game's HTML:
 *
 *   <script src="/socket.io/socket.io.js"></script>
 *   <script src="/arcade-sdk.js"></script>
 *   <script>
 *     Arcade.init({
 *       gameId: 'tictactoe',          // matches manifest.json
 *       playerName: 'Zoe',            // optional
 *       onState:  (state) => render(state),   // every board update
 *       onPlayers: (players) => showRoster(players), // presence
 *       onDisconnected: () => alert('lost server')
 *     });
 *     // later, when the local player acts:
 *     Arcade.makeMove({ board: newBoard, turn: 1 }, { player: 'Zoe', cell: 4 });
 *   </script>
 *
 * The launcher always opens games as:
 *   /games/<id>/<file>.html?room=ROOM-101
 * The SDK reads `room` from the query string and auto-binds.
 */
(function () {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const roomCode = (params.get('room') || '').trim().toUpperCase();

  const Arcade = {
    socket: null,
    roomCode: roomCode || null,
    _callbacks: {},
    _joined: false,

    /**
     * Initialize. Requires window.io (Socket.IO client) to be loaded.
     * options: { gameId, playerName, onState, onPlayers, onJoined, onDisconnected }
     */
    init(options = {}) {
      if (typeof window.io !== 'function') {
        throw new Error('[Arcade] Socket.IO client (/socket.io/socket.io.js) must load before arcade-sdk.js');
      }
      this._callbacks = options;
      if (!this.roomCode) {
        console.warn('[Arcade] no ?room= in URL — running unattached (local only).');
        return this;
      }

      this.socket = window.io({ transports: ['websocket', 'polling'] });

      this.socket.on('connect', () => this._join());
      this.socket.on('connect_error', (err) => {
        console.error('[Arcade] connect error:', err.message);
      });
      this.socket.on('disconnect', () => {
        this._joined = false;
        if (this._callbacks.onDisconnected) this._callbacks.onDisconnected();
      });

      // Game state — broadcast by the server to THIS room only.
      this.socket.on('game:state', ({ roomCode: rc, state }) => {
        if (rc === this.roomCode && this._callbacks.onState) this._callbacks.onState(state);
      });

      // Presence — who's in the room.
      this.socket.on('room:player', ({ roomCode: rc, players, started }) => {
        if (rc === this.roomCode && this._callbacks.onPlayers) this._callbacks.onPlayers(players, started);
      });

      this.socket.on('room:started', ({ roomCode: rc, started, snapshot }) => {
        if (rc === this.roomCode && this._callbacks.onStarted) this._callbacks.onStarted(started, snapshot);
      });

      return this;
    },

    _join() {
      if (this._joined) return;
      this._joined = true;
      this.socket.emit('room:join', {
        roomCode: this.roomCode,
        gameId: this._callbacks.gameId,
        playerName: this._callbacks.playerName,
      }, (res) => {
        if (!res || !res.ok) {
          console.error('[Arcade] join failed:', res && res.error);
          return;
        }
        console.log(`[Arcade] attached to ${res.roomCode}`);
        if (this._callbacks.onJoined) this._callbacks.onJoined(res.snapshot);
        // Bootstrap local render from the authoritative snapshot.
        if (res.snapshot && this._callbacks.onState) this._callbacks.onState(res.snapshot.state);
      });
    },

    /**
     * Submit a move. `patch` is the new/changed board state (shallow-merged
     * server-side); `meta` is free-form context (who moved, which cell...).
     */
    makeMove(patch, meta) {
      if (!this.socket || !this.roomCode) return Promise.resolve({ ok: false, error: 'NOT_ATTACHED' });
      return new Promise((resolve) => {
        this.socket.emit('game:move', { patch, meta }, (res) => resolve(res));
      });
    },

    /** Start the match for the current room. */
    startGame() {
      if (!this.socket || !this.roomCode) return Promise.resolve({ ok: false, error: 'NOT_ATTACHED' });
      return new Promise((resolve) => {
        this.socket.emit('room:start', (res) => resolve(res));
      });
    },

    /** Fetch the current authoritative snapshot. */
    getState() {
      return new Promise((resolve) => {
        if (!this.socket) return resolve(null);
        this.socket.emit('room:state', (res) => resolve(res && res.ok ? res.snapshot : null));
      });
    },

    /** Leave the room (state stays persisted on the server). */
    leave() {
      if (this.socket) this.socket.emit('room:leave');
    }
  };

  window.addEventListener('beforeunload', () => {
    if (window.Arcade && window.Arcade.leave) window.Arcade.leave();
  });

  window.Arcade = Arcade;
})();
