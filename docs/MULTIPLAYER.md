# SpeedBike Multiplayer — design & protocol (source of truth)

Owner: PM. Server and client are built in parallel against THIS document. If something here is wrong or missing, implement the most sensible thing and report the deviation — don't silently change the contract.

## Architecture
- **Server**: Node.js (>=20, ES modules) in `server/`, one process, WebSocket (`ws` package). It **imports the game's pure modules directly** from `../js/` (config, state, physics, ai, rules, modes, maps, abilities) and runs the authoritative simulation. Nothing in `js/` that the server imports may touch `window`/`document`/three.
- **One Room per match** (a class instance inside the process, ticking on a shared `setInterval` loop or its own timer). Not OS threads. Can move rooms to `worker_threads` later without protocol changes.
- **Client**: the existing static site. `js/net.js` (WebSocket client) + multiplayer UI. Server URL: `CFG.net.url` (default `ws://localhost:8787`), overridable with `?server=wss://...`.
- **Auth**: multiplayer requires a signed-in account. Client sends its Firebase ID token in `hello`. Server verifies it with `firebase-admin` (`verifyIdToken`, project `speedbike-9a552`) when credentials are configured; in **dev mode** (`DEV_AUTH=1`, default when no credentials) it accepts `{dev:true, uid, username}` instead — this pairs with the client's `?backend=mock`.
- **Rank storage**: server-only writes. With credentials → Firestore `ranks/{uid}` via Admin SDK (clients may read, never write — add a `ranks` read-only rule to `firestore.rules`). Without credentials → JSON file `server/data/ranks.json`. Service-account JSON path from env `GOOGLE_APPLICATION_CREDENTIALS`; never committed (`server/.gitignore`).

## Modes & rotation (shared pure module `js/rotation.js`)
- Multiplayer modes always available: `standard`, `deathmatch`. Plus one **featured** mode rotating **hourly**: `featuredMode(now) = ['hyper','3d'][Math.floor(now / 3600000) % 2]`; `nextRotation(now)` = ms timestamp of the next hour boundary. Server is authoritative on time; it sends `serverNow` so clients can correct clock skew.
- All multiplayer matches are 4 slots, humans only, no bots. Standard/Hyper/3D: rounds to 5 points with the existing rules (`rules.js resolveTick`, NOT the single-player `resolvePlayerOut` instant-round-end rule). Death Match: existing lives rules.

## Ranks (shared pure module `js/ranks.js`)
- Tiers in order: `He` (Helium), `Ne` (Neon), `Xe` (Xenon). Divisions per tier: `3`, `2`, `1` (3 is lowest). Ladder (index 0..8): He3, He2, He1, Ne3, Ne2, Ne1, Xe3, Xe2, Xe1.
- Record: `{ tier:'He', div:3, wins:0, matches:0, totalWins:0, updatedAt }`. Default for new players: He3, wins 0.
- After each ranked match, per player: **1st place (sole winner) → wins+1; any other result (2nd–4th, shared 1st, disconnect/leave) → wins−1.**
  - wins reaches 2 → promote one division (ladder index+1), wins=0. At the top (Xe1) wins is capped at 1... i.e. stays max 1.
  - wins drops below 0 → demote one division, wins=1. At the bottom (He3) wins floors at 0.
- Function API: `applyResult(rank, won) -> {rank, change: 'promote'|'demote'|'none', tierChange: bool}`, `ladderIndex(rank)`, `rankLabel(rank)` (e.g. "NEON II" / short "Ne II"), `isTierPoint(rank)` = true when one more win promotes into a new tier (div 1 and wins 1, not Xe1), `TIERS` with display name + color: He = soft orange-pink `#ff9a76` (helium discharge), Ne = neon red-orange `#ff4d2e`, Xe = violet-blue `#8f7bff`.
- **Announcements**: server broadcasts to **everyone connected** (all lobbies, menus, matches): when a player reaches tier point (`isTierPoint` becomes true) → `"<name> is one win from NEON!"`; when a player is promoted into a new tier → `"<name> reached NEON!"`.

## Queue & lobby (global, per mode)
- One global queue per mode (`standard`, `deathmatch`, featured). A player is in at most one queue/lobby/match.
- When a mode has ≥2 queued players → open a **lobby** with them (up to 4). Lobby state "WAITING FOR OTHER PLAYERS" with a **30 s countdown**; each new player joining **resets** the countdown to 30 s. Start at 4 players immediately, or when the countdown hits 0 with whoever is in (≥2). If players leave and <2 remain → lobby dissolves back to queue.
- Further queued players join an open lobby of that mode before a new one is created.
- If the featured mode rotates while a player is queued/in lobby for the old featured mode, that queue keeps working until matched (don't strand people); new joins use the new featured mode.

## Netcode
- Server sim runs at `CFG.tickHz` (120). Movement is deterministic, so the server broadcasts **inputs as events** and periodic state; clients run the same sim locally.
- Client→server inputs are sent immediately on press with the client's estimated server tick. Server applies them at its current tick (never in the past), then broadcasts the authoritative event `{t:'ev', tick, id, kind:'turn'|'boost'|'jump'|'ability'|'swap', side?, x, z, y, dx, dz}` with the exact bike state after applying.
- Own bike: client predicts the input locally immediately; on the authoritative event, if its position/direction differs by > a small epsilon, snap/rewind own bike to the authoritative state and re-simulate forward to now (or simply snap — keep it simple first, note it).
- Other bikes: client applies authoritative events at their tick (sim runs ~100 ms behind server time for other bikes to hide jitter, or applies late with correction — pick the simpler approach that looks smooth and document it).
- Server sends `{t:'snap', tick, bikes:[{id,x,z,y,dx,dz,speed,alive,lives,boostMeter,jumpMeter,...}]}` at 10 Hz for drift correction; trails are reconstructed on clients from events (turn points) + head position; crashes come as events.
- Crash/round/match flow comes from the server: `{t:'crash', tick, victim, killer, cause}`, `{t:'round', phase, scores, lastResult, roundTime}`, `{t:'end', ranks:[{id, uid, place, won, rankBefore, rankAfter, change}]}`.

## Messages (JSON over WebSocket)
Client → server:
- `{t:'hello', token}` or dev `{t:'hello', dev:true, uid, username}`
- `{t:'queue', mode}` / `{t:'leaveQueue'}`
- `{t:'in', kind, side?, ctick}` (game inputs during a match)
- `{t:'leave'}` (leave match = counts as loss)
- `{t:'ping', c}`
Server → client:
- `{t:'welcome', uid, username, rank, serverNow, featured, nextRotation, online}`
- `{t:'queued', mode, position, inQueue}`
- `{t:'lobby', mode, players:[{uid,username,rank,colorIdx}], countdownEndsAt, serverNow}` (sent on every change)
- `{t:'start', mode, mapId, seed, tick0, you:<bikeId>, players:[{id,uid,username,rank,colorIdx,loadout}], cfgOverrides}`
- `ev` / `snap` / `crash` / `round` / `end` (above)
- `{t:'announce', text, kind:'tierPoint'|'tierUp'}`
- `{t:'rotation', featured, nextRotation}` (on change)
- `{t:'pong', c, serverNow}`
- `{t:'error', code, message}`
- Server validates every client message (shape, size ≤ 1 KB, rate-limit inputs ~30/s, ignore inputs from dead bikes / wrong match).

## Client UI
- **PLAY** → choice screen: **SINGLEPLAYER** (the existing mode select, unchanged) / **MULTIPLAYER**.
- MULTIPLAYER (requires sign-in; otherwise prompt to open ACCOUNT): shows your rank badge (tier symbol He/Ne/Xe, division roman numeral, 2 win pips), online count, mode cards: STANDARD, DEATH MATCH, and FEATURED (HYPER or 3D) with "rotates in mm:ss". Selecting a mode → queue screen ("SEARCHING… n in queue", Cancel) → lobby screen ("WAITING FOR OTHER PLAYERS", player list with rank badges, countdown) → match.
- In match: same HUD (scoreboard shows rank badges next to names), pause button shows a small menu (Resume / Leave match — warns it counts as a loss); the game never actually pauses online.
- Match end: placements + rank change animation (pip gained/lost, PROMOTED / DEMOTED banner).
- Announcements: toast at top for every `announce` message, anywhere in the app while connected.
- Equipped garage parts (glow color etc.) and abilities are sent with `queue` later — **for now: everyone uses default parts but their own glow color; abilities disabled online** (keep the hex button hidden in online matches). Note this as a known limitation.

## Dev / test
- `cd server && npm install && npm start` → listens on `PORT` (default 8787). `npm test` runs server tests.
- Headless test harness: a node script that opens 4 WebSocket clients in dev-auth mode, queues them, plays a match with random inputs, and checks the match ends and ranks are updated and persisted.
