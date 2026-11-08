# SpeedBike game server

Authoritative multiplayer server (Node >= 20, ES modules, `ws`). It imports the game's pure modules from `../js/` (config, state,
physics, rules, modes, maps, abilities, ai, ranks, rotation) and runs matches of 2-4 humans plus server-side bots filling the empty slots (`bots.js`). Protocol: [`../docs/MULTIPLAYER.md`](../docs/MULTIPLAYER.md).

## Run locally (dev auth)

```
cd server
npm install
DEV_AUTH=1 npm start # ws://localhost:8787, health: http://localhost:8787/health
npm test             # unit + end-to-end tests (no Firebase needed)
```

With `DEV_AUTH=1` (required: without Firebase credentials the server refuses to start otherwise) it runs in **DEV AUTH** mode (loud warning in the log): clients send
`{t:'hello', dev:true, uid, username}` (the web client does this with `?backend=mock`) and ranks are stored in `server/data/ranks.json`.
Dev auth lets anyone claim any uid: never expose it to the internet. Open the game with `?backend=mock&server=ws://localhost:8787`.

## Real accounts (Firebase Admin)

1. Firebase console -> Project settings -> Service accounts -> **Generate new private key**. Save the JSON outside the repo
   (or somewhere matched by `server/.gitignore`). **Never commit it.**
2. `GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json npm start` (or put the JSON in `FIREBASE_SERVICE_ACCOUNT` on hosts without files).
3. The server then verifies client ID tokens (`verifyIdToken`, project `speedbike-9a552`), reads the username from `users/{uid}`
   and keeps ranks in Firestore `ranks/{uid}` (Admin SDK bypasses rules; clients may only read, see `../firestore.rules`: publish them).

## Username login: `POST /auth/login`

Lets the client log in with a username without ever learning the email. Body (JSON only, `Content-Type: application/json`, max 2 KB): `{"username","password"}`.
The server reads `usernames/{lowercase}` -> uid, gets the email with `admin.auth().getUser(uid)`, verifies the password via the Firebase Auth REST API
(`accounts:signInWithPassword`, Node `fetch`), and answers `200 {ok:true, token}` where `token` is `admin.auth().createCustomToken(uid)` (the client calls `signInWithCustomToken`).
The email and the REST id/refresh tokens are never returned or logged.

| status | body | when |
|---|---|---|
| 200 | `{ok:true, token}` | success |
| 401 | `{ok:false, code:'invalid_credentials'}` | unknown/malformed username, wrong password, disabled user (identical, and padded to >= 700 ms) |
| 429 | `{ok:false, code:'rate_limited', retryAfter}` | per-IP 10 / 5 min, per-username 10 / 15 min (in memory, resets on restart), or Firebase `TOO_MANY_ATTEMPTS` (+ `Retry-After` header) |
| 400 / 413 / 415 / 405 | `{ok:false, code}` | bad JSON or shape / body over 2 KB / not JSON / not POST |
| 403 | `{ok:false, code:'forbidden_origin'}` | `Origin` not in `ALLOWED_ORIGINS` (localhost origins are also allowed when `NODE_ENV` is not `production`) |
| 503 | `{ok:false, code:'unavailable'}` | dev-auth mode (no Firebase credentials), or Firestore/Firebase unreachable |

CORS: only allowed origins get `Access-Control-Allow-Origin` (echoed, never `*`); `OPTIONS` preflight is answered. Client IP = first hop of `x-forwarded-for`
(Render/Cloudflare), else the socket address. Caveat: a client can prepend its own `x-forwarded-for` entry to dodge the per-IP limit; the per-username limit still caps guessing per account
(and lets an attacker lock a known username out for 15 min: accepted trade-off). Code: `login.js` (dependency-injected: lookup / verifyPassword / createToken / now / sleep), tests: `test/login.test.mjs`.
The Firebase service account must be allowed to sign custom tokens (a normal service-account key is).

## Environment variables

| var | default | meaning |
|---|---|---|
| `PORT` | 8787 | listen port (hosts like Render/Fly set it) |
| `GOOGLE_APPLICATION_CREDENTIALS` / `FIREBASE_SERVICE_ACCOUNT` | - | service-account file path / JSON string; presence selects Firebase mode |
| `DEV_AUTH` | unset | `1` = dev auth (local only, explicit); anything else without Firebase credentials = the server refuses to start |
| `FIREBASE_PROJECT_ID` | speedbike-9a552 | project for token verification |
| `RANKS_FILE` | server/data/ranks.json | JSON rank file (dev mode) |
| `SOCIAL_FILE` | server/data/social.json | JSON friends file + dev user directory (dev mode) |
| `ALLOWED_ORIGINS` | any (websocket) / none (login CORS in production) | comma-separated browser origins allowed to connect; also the CORS allow-list of `/auth/login` |
| `PUBLIC_URL` | `https://speedbikeapp.github.io` | base URL in e-mailed reset links |
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN` | console mailer (logs only) | Gmail API credentials for sign-up codes / password reset mail; see NOTES.md "E-mail" |
| `FIREBASE_WEB_API_KEY` | public key from `js/firebase-config.js` | web API key for the Auth REST password check (public by design) |
| `LOBBY_COUNTDOWN_MS` | 30000 | lobby countdown (tests) |
| `TIME_SCALE` | 1 | TEST ONLY: runs the sim N times faster than real time |
| `HEALTH_TOKEN` | unset | when set, `/health?detail=<token>` also returns auth mode, store, loop timing and per-room stats |
| `NODE_ENV=production` | | login CORS allow-list only; dev auth needs `DEV_AUTH=1` anyway |

## Files

`index.js` http + ws + glue, shared 16 ms loop (rooms, lobby timers, rotation, heartbeat) | `protocol.js` message validation + rate limiter |
`auth.js` dev / Firebase auth | `login.js` `POST /auth/login` (username login) | `store.js` ranks (atomic JSON file or Firestore) | `ranking.js` applies results + announcements | `social.js` + `social-store.js` friends, presence, search (Firestore `friends/{uid}`, Admin SDK only) | `party.js` parties (in memory) |
`matchmaker.js` queues and lobbies (clock-injected, no timers) | `room.js` one match | `test/` (`npm test`; `e2e.test.mjs` plays full matches over real sockets).

## How a room runs

`Room.update(now)` computes how many ticks are due from the absolute start time (`floor((now - t0) * 120 / 1000)`), so a late timer
runs several ticks in a row instead of drifting; a stall over ~2 s is skipped. One shared loop wakes every 16 ms (`loopMs`, ~4x fewer wake-ups than the
old 4 ms timer: the free Render instance has 0.1 CPU) and each wake-up runs the ~2 ticks that are due. Per tick: record every alive bike's
state into a short history ring, apply leavers, apply queued inputs (**lag compensation**: an input with a recent `ctick` is applied at that
tick by rewinding + replaying that one bike, see docs/MULTIPLAYER.md "Lag compensation"; otherwise turns wait up to 100 ms for the min
turn gap, like the offline input buffer), `step()`, feed crashes to `match.onTick` (`resolveTick`, never
`resolvePlayerOut`: `state.playerId = -1`), broadcast. `ev` = authoritative state right before server tick `tick`; `crash`/`round`/`snap`
carry the tick counter after the iteration. Snapshots go out at 10 Hz. Leaving or dropping a socket crashes the bike and charges
a rank loss immediately; in a room WITHOUT bots fewer than 2 humans left ends the match (the remaining player wins); with bots the last human plays on, and the room closes when no human is left. Bots (`bots.js`) think like the singleplayer AI (`js/ai.js`) and all their actions are broadcast as `ev`; abilities are server-authoritative (`ability` input -> `ev kind:'ability'`).

## Monitoring: `/health`

`GET /health` also returns `loop` (`intervalMs` = scheduler interval, `avgIntervalMs` / `maxIntervalMs` = actual wake-up spacing over the last
~10-20 s, `cpuPct` = share of one CPU the process used over the last ~5 s) and `roomStats[]` per running room: `avgMs` / `maxMs` = time of one
`update()` call, `behind` / `behindMax` = ticks owed at wake-up (about 2 normally; a growing number = CPU starvation), `skipped` = stalls > 2 s that were
skipped, `lagComp` = `{inputs, rewound, avgRewindTicks, maxRewindTicks, clamped, future, fallback, ignored}` input counters. On Render free, watch
`maxIntervalMs` far above 16 and `behindMax` above ~10: the instance is being throttled.

## Hosting notes (no decision made)

The server is one long-lived process holding WebSockets and match state in memory, so it needs a host with persistent processes
and WebSocket support, TLS termination (`wss://`), and a single instance (rooms are not shared between instances).

- **Fly.io**: Docker/`fly launch`, always-on small VM, regions close to players, WebSockets work out of the box; free tier is limited; secrets via `fly secrets`.
- **Render** (web service): simple git deploy, WebSockets OK, free tier sleeps when idle (bad for a game server), paid tier is always on.
- **Railway**: easiest deploy, usage-based pricing, WebSockets fine.
- **Small VPS** (Hetzner, DO, ...): cheapest per CPU and best latency control, but you run Node (pm2/systemd), TLS (Caddy/nginx) and updates yourself.

CPU is light (a 4-player room is a few hundred microseconds per tick); the Firestore round trip only happens at match end.

## Protocol notes / deviations from docs/MULTIPLAYER.md

- Lag compensation: `in.ctick` is now used (it was informational): `ev.tick` can be up to `CFG.net.maxRewindMs` (150 ms = 18 ticks) older than the server's current tick, so `ev` messages are no longer in tick order across bikes. Old clients are fine (they already rewind + replay to `ev.tick`).
- `hello` may be up to 4 KB (a Firebase ID token is ~1 KB+); every other message is capped at 1 KB.
- Tick numbering: `tick0` is always 0 (the sim starts in the 3 s countdown). `ev.tick` = state before iteration `tick`; `crash`/`round`/`snap` use the counter after the iteration.
- `round` also carries `round` (number), `cd` (countdown seconds left), `lives` (Death Match) and, for `phase:'countdown'`, `bikes` (fresh spawn states). Phases: `countdown | running | roundEnd | matchEnd`.
- `crash` has `cause`: `'trail' | 'wall' | 'void' | 'side' | 'leave'` and `lives` (remaining, Death Match only). `ev.kind` also includes `'respawn'` (Death Match, full bike state). `snap` also has `phase`, `roundTime` and per-bike `lives`.
- `end` = `{t:'end', mode, reason:'normal'|'forfeit', ranks:[{id,uid,username,place,won,left,scores,rankBefore,rankAfter,change}]}`.
- Extra server messages: `{t:'online', online}` (throttled to 1 per 2 s) and `{t:'rank', rank}` (sent to a player who left a match, after the loss is applied).
- `colorIdx` is the index into `CFG.players` (0 orange, 1 blue, 2 green, 3 purple), distinct per lobby. `start.players[].loadout` is the provisional ability list (queue time) and `bot:true` marks bots (`uid`/`rank` null); the final loadout arrives as `loadout` messages in the first countdown. `in` accepts `kind:'ability'` + `ability:<id>`; `swap` is ignored (local). `ev.kind` also includes `'ability'` (with `ability`, `dj?`), snapshots carry `ab` timers, `end.ranks[]` rows of bots have `bot:true` and null ranks. Rank records carry `v:2` (old records without `v` are converted on read, `js/ranks.js migrateRank`).
- A second login with the same uid replaces the first connection (`error` code `replaced`). Queueing the same player twice or while in a match is `error busy`.
- If a match without bots ends because everyone else left (`forfeit`), the remaining player counts as the sole winner. With bots in the room the survivor keeps playing; the room closes (`forfeit`, nobody notified) when no human is left.
