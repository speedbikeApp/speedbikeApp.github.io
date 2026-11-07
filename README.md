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

## Tests
```
for f in tests/*.mjs; do node "$f"; done
```

## Deploy to GitHub Pages
Push this folder to a public GitHub repo, then Settings → Pages → Deploy from branch → `main` / root.

See `BRIEF.md` for the design spec and `NOTES.md` for architecture.
