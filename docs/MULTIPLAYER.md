# SpeedBike Multiplayer — design & protocol (source of truth)

Owner: PM. Server and client are built in parallel against THIS document. If something here is wrong or missing, implement the most sensible thing and report the deviation — don't silently change the contract.

## Architecture
- **Server**: Node.js (>=20, ES modules) in `server/`, one process, WebSocket (`ws` package). It **imports the game's pure modules directly** from `../js/` (config, state, physics, ai, rules, modes, maps, abilities) and runs the authoritative simulation. Nothing in `js/` that the server imports may touch `window`/`document`/three.
- **One Room per match** (a class instance inside the process, ticking on a shared 16 ms `setInterval` loop that runs the ticks due). Not OS threads. Can move rooms to `worker_threads` later without protocol changes.
- **Client**: the existing static site. `js/net.js` (WebSocket client) + multiplayer UI. Server URL: `CFG.net.url` (default `ws://localhost:8787`), overridable with `?server=wss://...`.
- **Auth**: multiplayer requires a signed-in account. Client sends its Firebase ID token in `hello`. Server verifies it with `firebase-admin` (`verifyIdToken`, project `speedbike-9a552`) when credentials are configured; in **dev mode** (`DEV_AUTH=1`, default when no credentials) it accepts `{dev:true, uid, username}` instead — this pairs with the client's `?backend=mock`.
- **Username login**: the same server exposes `POST /auth/login {username,password}` -> `{ok:true, token}` (Firebase custom token; client then `signInWithCustomToken`) so players can log in with a username while emails stay private. Details, status codes, rate limits and CORS in `server/README.md`; dev-auth mode answers 503 and the mock client backend handles usernames itself.
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
- Client→server inputs are sent immediately on press with the client's estimated server tick `ctick`. The server applies each at `ctick` (**lag compensation**, below) and broadcasts the authoritative event `{t:'ev', tick, id, kind:'turn'|'boost'|'jump'|'ability'|'swap', side?, x, z, y, dx, dz}`: `tick` = the tick it was applied at (= `ctick` when within the cap), x/z/dx/dz = the exact bike state after applying it at that tick.
- Own bike: client predicts the input locally immediately. The authoritative event carries the same tick and (deterministic sim) the same state, so the correction is ~0. Any residual correction (event rounding, clamp past the cap, tick-estimate drift) is shown smoothly: the sim/trail are corrected at once, the bike MESH and camera keep a render-only offset (`vox`/`voz`) that decays over `CFG.net.blendMs` (120 ms, ~95% gone). Errors above `blendOwnMax` (3 units) or with a different heading are snapped.
- Other bikes: client applies authoritative events at their tick (rewind that bike to the tick, replay to now: trail geometry is exact), and blends the visual position error out the same way (also across the heading change of a late turn, up to `blendRemoteMax` = 10 units, else snap). The trail head follows the part of the offset along the bike's heading so the mesh stays attached to its trail. All bikes are rendered at the estimated *current* server tick (no interpolation delay).

## Lag compensation (server, `server/room.js`)
- Problem: a turn pressed at client tick T reaches the server ~one-way-latency later. Applying it at the server's current tick moves the turn point forward by latency x speed (~1.1 units at 150 ms RTT) and pulls the player's own bike back on every turn.
- The server keeps, per bike, a ring (48 ticks) of the state at the start of every running tick: all numeric/boolean bike fields (position, heading, speed, jump/boost timers ...) + the trail segment count. Inputs carry `ctick` (integer; a non-number is treated as "now").
- Per input: `T = ctick`; `T > now` -> `now` (future claims get no advantage); `T < now - maxRewind` -> `now - maxRewind` (`CFG.net.maxRewindMs` = 150 ms = 18 ticks; covers up to ~300 ms RTT); `T <` the bike's previous input tick -> that tick (events are never reordered); `T <` the bike's last crash tick -> input ignored (a crash is final; a dead bike is never revived, a respawn/round start voids the history so a stale tick cannot reach into an earlier life).
- If `T < now`: rewind that bike on a scratch copy to its state at `T` (history scalars, trail truncated to the recorded length, newest segment ended at the head), apply the input (turn needs `canTurn`; boost/jump need their meter), broadcast `ev` with `tick = T` and the state right after applying, then replay the bike alone from `T` to `now` with `step()` and commit the result (position, heading, trail) to the real bike; its history entries are rewritten. If the input is not valid at `T` (e.g. inside the min turn gap) or there is no history, it falls back to the normal path (buffered turn at the current tick).
- **Collision choice**: during the replay the bike is checked against every other bike's trail **as it was at each replayed tick** (looked up in the other bikes' history), not as it is now. Using "now" would kill the turner at a spot where the other bike only drew its trail *after* the turner had passed (false deaths that the player's own screen never showed); the time-aware lookup is the same world the server simulated, with only this bike's path rewritten. Consequence: other bikes are NOT re-simulated, so a bike that drove through the new lane after the turner passed it is not retro-killed (the two trails simply cross). A replayed death is a normal `crash` (killer = trail owner) sent in the same tick. Trails of bikes that crashed within the last 150 ms have already vanished, so crossing them in the replay is allowed (lenient).
- Fairness trade-offs: the turner is favoured (it acts at its own time, up to 150 ms in the past) at the expense of the other player, who may see a bike "turn away" from a collision course that already looked decided on their screen, or die to a turn that appears 150 ms later. Abuse is bounded: a client can only move the turn point back by at most the cap (2.25 u at base speed, 3.75 u Hyper), cannot undo a crash, cannot send positions (only the tick), and the input rate limit is unchanged. Beyond the cap the part past 150 ms is not compensated (the bike is pulled back by the excess x speed, smoothed on the client).
- Stats per room in `/health` (`roomStats[].lagComp`): inputs, rewound, clamped, future, fallback, ignored, average / max rewind in ticks.

## Server loop
- One shared `setInterval` of 16 ms (`loopMs`) drives all rooms (each wake-up runs the ticks that are due: ~2 at 120 Hz), lobby timers, rotation and the heartbeat. Snapshots stay at 10 Hz. `/health` reports per-room tick timing (avg/max ms, ticks behind) and the loop's own wake-up spacing / CPU share, to spot CPU starvation on small hosts.
- Hosting region: Frankfurt (`render.yaml`). Netcode targets 50-250 ms RTT.
- Server sends `{t:'snap', tick, bikes:[{id,x,z,y,dx,dz,speed,alive,lives,boostMeter,jumpMeter,...}]}` at 10 Hz for drift correction; trails are reconstructed on clients from events (turn points) + head position; crashes come as events.
- Crash/round/match flow comes from the server: `{t:'crash', tick, victim, killer, cause}`, `{t:'round', phase, scores, lastResult, roundTime}`, `{t:'end', ranks:[{id, uid, place, won, rankBefore, rankAfter, change}]}`.

## Messages (JSON over WebSocket)
Client → server:
- `{t:'hello', token}` or dev `{t:'hello', dev:true, uid, username}`
- `{t:'queue', mode}` / `{t:'leaveQueue'}`
- `{t:'in', kind, side?, ctick}` (game inputs during a match; `ctick` = the client's estimated server tick when the key was pressed, used for lag compensation)
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

## Social: friends + presence (`server/social.js`, `server/social-store.js`, client `js/social.js` + `js/friends-ui.js`)
- **One persistent socket**: the same authenticated WebSocket (`js/online.js` `net`) is the presence connection (it connects on sign-in, reconnects with backoff, waits out the Render cold start) AND is used for the queue / match. A uid is **online** while it has a live authenticated session (`byUid` in `server/index.js`); a second connection of the same account replaces the first (`error replaced`), without an offline blip for friends. Presence is also the hook the party feature uses (see Party): `social.isOnline(uid)`, `social.friendsOf(uid)`, `send(uid, msg)`.
- **Authority**: only the server writes friendships (Admin SDK). `firestore.rules` has no rule for `friends/*`, so clients are denied. Firestore doc `friends/{uid}` = `{friends:[uid], incoming:[uid], outgoing:[uid]}`; every change is one transaction over both users' docs (`store.update([a,b], fn)`), so both sides always agree. Dev mode (no credentials): `server/data/social.json` (`SOCIAL_FILE`), which also remembers `{uid -> username}` of everyone who connected (stand-in for `users/` + `usernames/`); tests use an in-memory store.
- **Limits**: 100 friends, 50 pending incoming, 50 pending outgoing. Cannot friend yourself. `fadd` to someone who already asked you accepts instead (`state:'friends'`). Searches: token bucket 0.7/s burst 5 per connection; mutations 1/s burst 10 (`fres code:'rate_limited'`).
- **Names / ranks**: usernames are resolved on the server from `users/{uid}` (cached 60 s for offline users; online users are live). After a rename the client sends `frefresh`; the server re-reads the name and pushes `fname`. Ranks: live from the session, else `ranks/{uid}` (cached 60 s); rank changes after a match are pushed as `frank`. Deleted accounts (`users/{uid}` gone, a successful read) are pruned from every list lazily when a snapshot is built (a failed read never prunes).
- **Search** is a prefix match on `usernames/{lowercase}` doc ids (documentId range, limit 10, self excluded); query = 2-12 chars of `[A-Za-z0-9 _-]` (the username charset), lowercased server-side.

Client -> server (all need `hello` first; `uid` = `^[\w-]{1,128}$`):
| message | meaning |
|---|---|
| `{t:'fsearch', q}` | prefix search -> `fresults` (or `fres ok:false`) |
| `{t:'fadd', uid}` | send a friend request (auto-accepts a mutual one) |
| `{t:'faccept', uid}` / `{t:'fdecline', uid}` | answer an incoming request |
| `{t:'fcancel', uid}` | withdraw our outgoing request |
| `{t:'fremove', uid}` | unfriend (both sides) |
| `{t:'flist'}` | ask for a fresh `friends` snapshot (sent automatically after `welcome`) |
| `{t:'frefresh', username?}` | "my username changed": re-read it and tell friends (`username` is only honoured in dev-auth mode) |

Server -> client:
| message | meaning |
|---|---|
| `{t:'friends', friends:[{uid,username,rank,online}], incoming:[{uid,username,rank}], outgoing:[...]}` | full snapshot: after `welcome`, after any change to our links, on `flist`. `rank` = `{tier,div,wins}` |
| `{t:'fpresence', uid, online}` | a friend came online / went offline |
| `{t:'frank', uid, rank}` / `{t:'fname', uid, username}` | a friend's rank / username changed |
| `{t:'fresults', q, results:[{uid,username,rank,rel}]}` | search answer; `rel` = `none` / `outgoing` / `incoming` / `friend` |
| `{t:'fres', op, uid?, ok, state?, code?}` | result of an intent. `state` = `sent` / `friends` / `none`. `code`: `self not_found already_friends already_sent limit_friends target_limit_friends limit_outgoing target_limit_incoming no_request rate_limited unavailable` |
| `{t:'fevent', kind:'request'\|'accepted', uid, username}` | toast: somebody asked us / accepted our request |

Friend icon in matches: `start.players[]` and `end.ranks[]` carry `uid`; `js/hud.js` shows the blue person icon next to a name when `social.isFriend(uid)` (viewer's friends only), in the top-left scoreboard and on the results screen.

## Party (`server/party.js`, client `js/party.js` + `js/party-ui.js`)
- Up to **4** friends play together. **In-memory only** (server restart = parties gone). A party always has >= 2 members; when one is left it **dissolves**.
- **Invites**: anyone in a party (or nobody yet) may invite **their own online friends**. An invite lives 60 s on the server (`pinvites` list per invitee, with `ttl` ms left) and is shown as a toast + a persistent panel top-right until answered / expired. Inviting creates nothing: **accepting** creates the party (inviter = leader) or joins the inviter's current party (max 4). Accepting while in another party **leaves that one first** (it may dissolve). Invites / accepts are refused while the party (or you) is in a queue, lobby or match (`busy`).
- **Leader** (the creator, or the earliest-joined member after the leader left / was removed): the only one who may **queue** (`queue` from a non-leader -> `error not_leader`), cancel (`leaveQueue`), **kick** and **transfer** the lead. Leader leaves / is removed -> the member who joined **earliest** (online ones first) leads. Members can always `pleave`.
- **Queue as a group**: the leader's `queue` puts every ONLINE member (>= 2, else `error party_offline`) into the matchmaker as ONE entry (`Matchmaker.queueGroup`): the party is never split, it counts as its players in the queue / lobby (2+ players -> 30 s countdown, reset by each join; a party of 4 starts at once; party of N + solos fill the lobby up to 4; a party that does not fit the open lobby waits for the next one). Members are pulled in without asking: they receive the same `queued` / `lobby` / `start` messages. A member that is in a match when the leader queues -> `error member_busy`. Stale queue entries of members (e.g. the leader reconnected) are cleared first. If the leader cancels (`leaveQueue`) members get `{t:'unqueued', reason:'leader'}`; a member who leaves / is kicked while searching is pulled out of the lobby (`unqueued reason:'party'`).
- **Unranked**: players that entered the room through a party are flagged (`room.players[].party`). `settleMatch` is skipped for them (also for leaving mid-match): no rank change, no wins/losses, no tier announcements. `end.ranks[]` rows carry `party:true`, `rankBefore == rankAfter`, `change:'none'`. Solo players in the same room rank normally. The client shows "PARTY MATCH - UNRANKED" instead of the rank change; coins are unchanged (2x online coins). If the party dissolves while its (remaining) member is still in the lobby, the flag is cleared (a lone ranked solo).
- **Disconnects**: a member whose last session closes stays in the party for **30 s** (shown dimmed / `online:false`); a second connection of the same uid replaces the first without counting as a disconnect. Reconnecting resends `party` + `pinvites`. After the grace the member is removed (`reason:'timeout'`), the usual leader / dissolve rules apply. Offline members are not queued with the party.
- **Limits**: party intents use their own bucket (2/s, burst 12 per connection; `pres code:'rate_limited'`), at most 10 pending invites per invitee (`invite_limit`).

Client -> server (all need `hello`; `uid` = `^[\w-]{1,128}$`):
| message | meaning |
|---|---|
| `{t:'pinvite', uid}` | invite an online friend |
| `{t:'paccept', uid}` / `{t:'pdecline', uid}` | answer the invite of `uid` |
| `{t:'pleave'}` | leave the party (also leaves the queue / lobby if searching) |
| `{t:'pkick', uid}` / `{t:'ptransfer', uid}` | leader only |
| `{t:'plist'}` | resend `party` + `pinvites` (sent automatically after `welcome`) |
| `{t:'queue', mode}` / `{t:'leaveQueue'}` | as before; in a party only the leader may, and it moves the whole party |

Server -> client:
| message | meaning |
|---|---|
| `{t:'party', party:null or {id, leader, max:4, members:[{uid,username,rank,online}]}, reason?}` | full snapshot on every change (members in join order). `party:null` = you are in none; `reason` = `left` / `kicked` / `disbanded` / `timeout` |
| `{t:'pinvites', invites:[{uid,username,ttl}]}` | full list of pending invites for us (`ttl` = ms left) |
| `{t:'pres', op, uid?, ok, code?}` | result of an intent. `code`: `self not_friend offline party_full already_in_party busy invite_limit no_invite not_in_party not_leader not_member rate_limited` |
| `{t:'pevent', kind:'invite' / 'joined' / 'left' / 'kicked' / 'leader', username}` | toast text |
| `{t:'unqueued', reason:'leader' or 'party'}` | we were taken out of the queue / lobby by someone else |
| `{t:'error', code}` | new codes for `queue`: `not_leader`, `party_offline`, `member_busy` (plus `busy`) |

Client UI: party row on the main menu next to the FRIENDS button (member names, gold crown on the leader, LEAVE at the end; compact, wraps above FRIENDS on narrow phones). The leader taps a member -> TRANSFER LEAD / KICK / CLOSE; non-leaders get nothing destructive. The mode buttons of MULTIPLAYER are disabled for non-leaders ("ONLY THE PARTY LEADER CAN START A GAME") and CANCEL becomes LEAVE PARTY on a queue / lobby screen a member was pulled into. INVITE TO PARTY in the FRIENDS list (`friends-ui.js setPartyHooks`).

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
