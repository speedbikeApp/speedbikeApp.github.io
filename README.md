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

Dev / testing without Firebase: open `http://localhost:8000/?backend=mock`. This uses a localStorage-only fake backend (labelled "DEV MOCK" in the UI; never used unless that URL parameter is present).

## Tests
```
for f in tests/*.mjs; do node "$f"; done
```

## Deploy to GitHub Pages
Push this folder to a public GitHub repo, then Settings → Pages → Deploy from branch → `main` / root.

See `BRIEF.md` for the design spec and `NOTES.md` for architecture.
