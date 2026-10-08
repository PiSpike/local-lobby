# local-lobby
## (Unfinished StormHacks26)

StormHacks26 | A zero-internet, local offline game launcher server for mobile devices.

## Quick start

```bash
npm install
npm start
```

The server binds to `0.0.0.0:3000` and prints every LAN IP it can find.
Point any phone/laptop on the same Wi-Fi at, e.g. `http://192.168.1.42:3000`.

Everything (Socket.IO client dist, Tailwind CSS, games) is served from the
machine itself — no internet required at play time.

## Layout

```
server/
  server.js        Express + Socket.io bootstrap, LAN URL banner
  rooms.js         RoomManager — isolates all events by room code (ROOM-101…)
  persistence.js   lowdb (JSON) async, coalesced writes to data/rooms.json
  public/
    index.html     Launcher landing page (host / join / game library)
    tailwind.css   Offline utility CSS (CDN-free Tailwind subset)
    arcade-sdk.js  Injectable SDK that binds game HTML to a room socket
  games/
    manifest.json  Game registry the launcher fetches (/api/games)
    tictactoe/     Demo game using the SDK end-to-end
data/rooms.json    Created at runtime — board state survives restarts
```

## How rooms work

- Room codes: `ROOM-101`, `ROOM-102`, …
- The launcher hosts (`room:create`) or joins (`room:join`) and opens the
  game at `/games/<id>/index.html?room=ROOM-101&player=<name>`.
- `arcade-sdk.js` reads `?room=` and auto-binds the Socket.IO client:
  - `Arcade.makeMove(patch, meta)` → server validates, updates in-memory
    state, writes to disk **asynchronously** (debounced/coalesced), and
    broadcasts `game:state` to `io.to(roomCode)` only — rooms are isolated.
- Presence: `room:player` events keep the roster fresh; late joiners get
  the full snapshot via `room:joined`.

## Adding a game

1. Create `server/games/<id>/index.html` with your game.
2. Include the two scripts and wire the SDK:

```html
<script src="/socket.io/socket.io.js"></script>
<script src="/arcade-sdk.js"></script>
<script>
  Arcade.init({
    gameId: '<id>',
    onState: (state) => { /* render authoritative board state */ },
    onPlayers: (players) => { /* presence */ },
  });
  // on local action:
  // Arcade.makeMove({ board, turn, winner }, { player: 'Zoe', cell: 4 });
</script>
```

3. Add an entry to `server/games/manifest.json` (title, emoji, players,
   `entry`, and an `initialState` used when hosting).

## Event protocol (server ⇄ client)

| Event (client → server) | Reply / broadcast |
|---|---|
| `room:create` `{gameId, hostName, initialState}` | ack `{roomCode, snapshot}` + `room:player` to room |
| `room:join` `{roomCode, playerName}` | `room:joined` (snapshot, to joiner) + `room:player` |
| `game:move` `{patch, meta}` | `game:state` broadcast to the room only + ack |
| `room:state` | ack with full snapshot |
| `room:leave` / disconnect | `room:player`; last leaver closes the room |
| `room:close` | persists final state, empties presence |

