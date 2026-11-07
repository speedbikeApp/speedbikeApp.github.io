# SpeedBike — Project Brief

Build SpeedBike, a 3D light-cycle arena game that runs in the browser on phone and desktop, inspired by the mobile game LightBike 2, hosted on GitHub Pages.

**Originality rule:** Original game inspired by LightBike 2 (Pankaku Inc.). Recreate the gameplay feel, not the original. Original name, original 3D models (built from Three.js primitives), original UI art, original or procedurally generated (WebAudio) sounds. Never copy the original's code, assets, logos or branding.

## Tech stack and hosting
- Rendering: Three.js (WebGL), post-processing bloom for neon glow. Load Three.js via an importmap from a pinned CDN version (e.g. `https://cdn.jsdelivr.net/npm/three@0.160.0/...`).
- Plain JavaScript ES modules. No build step — runs straight from GitHub Pages.
- Static files only (HTML, JS, models, sounds).
- Saving: localStorage for settings, coins, unlocks, stats (wrapped in try/catch).
- Later optional: Firebase/Supabase leaderboards; PeerJS peer-to-peer matches via room codes.
- Performance: steady 60 fps on a mid-range phone. Trails are merged box segments, not one mesh per segment.
- Code layout: separate modules for game state, physics/collision, rendering, input, AI, UI/HUD, audio, save data. All tuning values in one config file (`js/config.js`).

## Visual style and camera
- Dark cyber-neon: black floor with glowing white grid, arena walls with glowing green circuit-board patterns, cyan-framed UI panels.
- Camera: low chase cam behind and slightly above the bike. On a turn the camera swings smoothly to the new direction (~0.15 s) while the bike snaps 90°.
- Bikes: compact simple glowing models in the player's color (player red/orange, opponents blue and others).
- Trails: solid glowing walls in bike color rising from the floor behind the rear wheel.
- Crash: bike bursts into glowing fragments; its trail disappears.
- Glow: emissive materials + bloom; bloom strength adjustable in settings.
- UI font: squared digital-style display font, free-licensed (e.g. Google Fonts "Orbitron" or "Share Tech Mono").

## HUD layout (cyan neon frames over the 3D view)
| Position | Element | Behavior |
|---|---|---|
| Top left | Bike icon, username, lives/points bar | Death Match: segments = lives left. Other modes: round points toward 5 |
| Top center | Timer seconds.milliseconds | Death Match counts up; other modes count down from 100 s per round |
| Below timer | Pause button | Pauses vs AI; opens menu |
| Top right | Minimap | Top-down view of all bikes (dots) and trails in their colors |
| Bottom left | Boost button | "OK!!" when ready; recharges after use |
| Bottom right | Jump button | "OK!!" when ready; recharges after use |
| Bottom center | Ability button (hexagon) | Triggers equipped ability; shows cooldown |
| Beside ability | Left/right chevrons | Light up briefly when a turn is input |

Countdown (3, 2, 1, GO), round results, match results appear as centered overlays.

## Controls
Every turn is a single tap/key press that snaps the bike exactly 90°; holding does nothing.

| Action | Phone | Desktop |
|---|---|---|
| Turn left | Tap left half of screen | A or Left arrow |
| Turn right | Tap right half of screen | D or Right arrow |
| Boost | Bottom-left button | Shift |
| Jump | Bottom-right button | Space |
| Ability | Bottom-center hexagon | E |
| Pause | Pause button | Esc or P |

- Buttons take priority over tap-to-turn halves.
- Inputs buffered ~100 ms so a quick double tap gives two turns.
- Landscape on phones; show "rotate your phone" message in portrait.
- Multi-touch: turning and pressing boost simultaneously works.

## Core mechanics
- Constant base speed V; only 90° turns along grid axes. All tuning in config.
- Fixed timestep logic (120 Hz) separate from rendering.
- Trails: list of axis-aligned segments per bike (start, end, height). Newest segment grows each tick; a turn starts a new one. Rendered as thin glowing boxes.
- Collision: each tick, test the bike's front point swept along this tick's movement against all trail segments and arena walls. Ignore the bike's own newest segment just behind it.
- Elimination: crashed bike explodes, trail removed, crash credited to owner of the trail hit (kill counts/unlocks).
- Boost: 1.5× speed while burning a boost meter over 1.5 s; empty meter refills linearly in ~6–7 s. Trail still drawn.
- Jump: lifts bike in an arc above trail height for 1.2 s; trails can't be hit while above trail height. Turning disabled mid-air unless Air Turn ability. Jump drains meter instantly; refills linearly over 5.0 s. Trail keeps being drawn during the jump, following the bike's arc, and collisions with it use its real height.
- Head-on / same-tick crashes: both eliminated; if they were the last two, nobody scores that round.
- AI: look ahead and turn away from danger; harder levels cut in front of player, use boost and jump, avoid dead ends via flood-fill of open space.
- Maps: all modes use the same map for now. Platforms sized so crossing takes 5–8 s at base speed; bikes can jump between platforms.

### Starting tuning values (1 unit = 1 grid square)
| Value | Start | Notes |
|---|---|---|
| Platform size | 100 × 100 | ~6.6 s to cross |
| Base speed | 15 u/s | |
| Boost speed | 22.5 u/s (1.5×) | meter burns 1.5 s, refills 6–7 s |
| Turbo Boost speed | 37.5 u/s (2.5×) | dash ~125 units (~3.3 s); turning allowed |
| Hyper base speed | 25 u/s | |
| Trail height | 2.0 | |
| Jump height | 3.5 | 1.5 clearance over trails |
| Jump timing | 0.2 s rise, 0.8 s float, 0.2 s fall | 1.2 s total |
| Jump recharge | 5.0 s | |
| Fast Charge | boost lasts 2.1 s; jump recharges 3.5–4 s | later ability |
| Rocket Jump height | 7.0 | later ability |

## Game modes
| Mode | Speed | Timer | On crash | Win |
|---|---|---|---|---|
| Standard | 1× | down from 100 s | Out until next round; random surviving opponent gets 1 point | First to 5 |
| 3D | 1× | down from 100 s | Same as Standard | First to 5 |
| Hyper | 25 u/s | down from 100 s | Same as Standard | First to 5 |
| Death Match | 1× | counts up | Lose a life, trail disappears, respawn | Last bike with lives |

Round loop (Standard, 3D, Hyper):
1. Up to 4 bikes spawn at fixed evenly spaced points facing center.
2. 3 s countdown; bikes frozen.
3. 100 s timer counts down. If it runs out, every alive bike gets 1 point; round ends.
4. A crashed bike is out until next round, and 1 random alive opponent gets 1 point.
5. Last bike alive gets 1 point.
6. If nobody has 5: clear trails, reset, go to 1.
7. Else match results, award SBCoins by placement, return to menu.

Death Match: 3 lives each (top-left bar), timer counts up from 0. On crash: lose a life, trail disappears, respawn after 1.5 s at open spot farthest from other bikes with full meters. No lives → out. Last bike with lives wins.

Platforms and height: bikes track height. Driving off a platform edge without jumping → fall with gravity until landing on lower level; falling off the map = crash. Jump crosses gaps. 3D mode gets its own multi-level maps.

## Abilities
First version: only Turbo Boost; rest later. Abilities sit in slots, active one switchable mid-game, active abilities fire from center hexagon.

| Ability | Type | Effect |
|---|---|---|
| Turbo Boost | Active | Forward dash ~125 units at 2.5× (~3.3 s); can still turn; leaves trail. Build first. |
| Fast Charge | Passive | Boost lasts 25–33% longer; jump recharges 3.5–4 s |
| Rocket Jump | Active | Much higher jump |
| Double Jump | Passive | Second jump in air |
| Air Turn | Passive | 90° turns in air |
| Protector | Active | Few seconds invulnerable; drive through trails |
| Stealth | Active | Your dot hidden from opponents' minimaps |
| Slow Down | Active | Temporarily lower speed |
| All Boost | Active | Forces every other bike to boost; once per round |
| All Jump | Active | Forces every other bike to jump; once per round |

Durations/cooldowns are config values. AI can equip abilities on harder difficulties.

## Garage and progression
- SBCoins awarded by match placement (and per kill in Death Match). Used to unlock abilities.
- Garage parts: body shell, tires, wheel rims, glow color (also colors trail). Several original designs each.
- Achievement unlocks: boost 5× in one round → wheel style; jump 5× in one round → wheel style; 100 trail kills → wheel style; 10 wins in a row → body shell; 100 wins → body shell; total distance milestone → tire style.
- Stats: matches, wins, win streak, kills, distance, boosts, jumps.
- Profile: username shown on HUD; editable in settings.

## Build phases
1. Core prototype: arena, one bike, chase camera, 90° turns, trails, wall/trail collision, crash and restart. Keyboard and tap controls.
2. Standard mode vs AI: 3 AI bikes, countdown, rounds to 5 with random-point rule, 100 s timer, results screen, basic HUD (timer, minimap, score bar).
3. Boost and jump: buttons with recharge and "OK!!" state, jump physics and trail gaps.
4. Look and feel: neon materials, bloom, circuit-board walls, crash particles, sounds and music, camera polish.
5. Menus and save data: main menu, mode select, settings, username, localStorage saves.
6. Abilities: ability slot, center button, Turbo Boost; switching abilities mid-game; other abilities later.
7. More modes: Hyper, Death Match, then 3D mode with multi-level maps.
8. Garage: coins, parts, achievement unlocks, stats screen.
9. Online (optional): leaderboard backend, then P2P matches via room codes.
