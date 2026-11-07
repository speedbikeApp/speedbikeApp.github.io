# SpeedBike

Neon 3D light-cycle arena game for phone and desktop browsers. Built with Three.js, plain ES modules, no build step.

## Play locally
```
python -m http.server 8000
```
Open http://localhost:8000 (opening index.html directly won't work, ES modules need http).

## Controls
| Action | Phone | Desktop |
|---|---|---|
| Turn | Tap left / right half | A / D or arrows |
| Boost | Bottom-left button | Shift |
| Jump | Bottom-right button | Space |
| Ability | Center hexagon | E (Q swaps) |
| Pause | Pause button | Esc / P |

## Modes
Standard, Hyper, Death Match, 3D (multi-level map).

## Online accounts (Firebase setup)
Accounts (register / login / user panel) use Firebase Auth + Firestore, loaded from Google's CDN. Until you configure it the game works fully offline and the ACCOUNT screen says "Online accounts not configured". Steps:

1. Go to https://console.firebase.google.com and click **Add project** (Analytics not needed).
2. Project overview -> **Add app** -> **Web** (`</>`), give it a nickname; skip Firebase Hosting.
3. Copy the `firebaseConfig` values shown into `js/firebase-config.js` (replace every `YOUR_...` placeholder). These values are public by design; security comes from the rules.
4. **Build -> Authentication -> Get started -> Sign-in method -> Email/Password -> Enable** (leave "Email link" off).
5. **Build -> Firestore Database -> Create database** (production mode, pick a region near your players).
6. Firestore **Rules** tab: paste the contents of `firestore.rules` and **Publish**.
7. **Authentication -> Settings -> Authorized domains -> Add domain**: `<your-github-username>.github.io` (and make sure `localhost` is listed for local testing).
8. Optional: Authentication -> Templates lets you customise the password-reset email.

Login accepts an **email or a username**. A username login goes through the game server (`POST /auth/login`, see `server/README.md`): it looks the email up privately, checks the password and returns a Firebase custom token, so emails are never exposed. The free Render server sleeps when idle, so the first username login can show "Waking up the login server..." for up to a minute; logging in with the email always works without the server. Registration stays email + username + password; "Forgot password" needs the account email.

Dev / testing without Firebase: open `http://localhost:8000/?backend=mock`. This uses a localStorage-only fake backend (labelled "DEV MOCK" in the UI; never used unless that URL parameter is present).

## Multiplayer (ranked, up to 4 players)
PLAY -> **MULTIPLAYER** needs a signed-in account (ACCOUNT screen) and a running game server. Singleplayer never needs the server: if it is unreachable the multiplayer screen just says "SERVER OFFLINE".

Run it locally (two or more browsers / profiles, each with its own account):
```
cd server && npm install && npm start        # game server on ws://localhost:8787 (dev auth, ranks in server/data/ranks.json)
python -m http.server 8000                   # in the repo root, in another terminal
```
Open `http://localhost:8000/?backend=mock` in two different browser profiles (the mock accounts live in each profile's localStorage and are accepted by the dev-auth server), register a user in each (ACCOUNT), then PLAY -> MULTIPLAYER -> pick a mode in both. Two players open a lobby that starts after 30 s (4 players start at once); set `LOBBY_COUNTDOWN_MS=3000` when starting the server to shorten it.

- Server URL: `CFG.net.url` in `js/config.js` (default `ws://localhost:8787`), or per visit with `?server=wss://your-host` (also combine: `?backend=mock&server=ws://localhost:8790`). For a deployed game set it to your `wss://` URL.
- Modes: STANDARD, DEATH MATCH and one FEATURED mode (HYPER or 3D) that rotates every hour. Ranks: Helium / Neon / Xenon, divisions III-I, two win pips per division; only a sole 1st place wins a pip, everything else (including leaving) loses one.
- Known limits: abilities are off online and everyone rides default parts (your own glow colour only); the match never pauses (the pause button opens Leave match, which counts as a loss).
- Real accounts: with Firebase configured the client sends its ID token; the server needs service-account credentials (see `server/README.md`).

## Tests
```
for f in tests/*.mjs; do node "$f"; done
```

## Deploy to GitHub Pages
Push this folder to a public GitHub repo, then Settings → Pages → Deploy from branch → `main` / root.

See `BRIEF.md` for the design spec and `NOTES.md` for architecture.
