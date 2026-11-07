// All tuning values. World units are kept as before (speeds, sizes, distances); one visible GRID TILE = CFG.tile units = one bike
// length (the bike model is scaled to it, see bikeScale). Positions are free: nothing snaps to tile lines or centres.
export const CFG = {
  tile: 3,                        // world units per grid tile (= bike length)
  arena: { half: 51 },            // platform 102x102 = 34x34 tiles, NO walls: driving off the edge = fall
  baseSpeed: 15,
  trailHeight: 2,
  trailThickness: 0.3,
  gravity: 45,                    // u/s^2 while falling off a platform (not during a jump arc)
  bikeHeight: 2.1,                // collision height of a bike: it occupies [y, y+bikeHeight] vertically (= rendered bike+rider top: helmet 1.72+0.23 local x bikeScale 1.1 = 2.15)
  // Boost: pressing burns the whole meter as a one-shot burst (mult x speed for `duration` s), then it refills over `recharge` s.
  boost: { mult: 1.5, duration: 1.5, recharge: 6.5 },
  // Jump arc: smooth parabola, rise (ease-out) for `rise` s up to `height`, then fall (ease-in) for `fall` s (float = 0).
  // Total 0.85 s, peak 1.75x trail height; the bike is above the trail (y >= 2) for ~0.56 s => take-off must be 2.1..10.6 units
  // (0.14..0.71 s) before the trail at base speed. Meter empties on press, refills linearly over `recharge` s.
  // While airborne a new trail segment is started whenever y moved >= trailStep from the newest segment's y0.
  jump: { height: 3.5, rise: 0.425, float: 0, fall: 0.425, recharge: 5.0, trailStep: 0.25 },
  // Abilities (phase 6). price = SBCoins (0 = unlocked from the start); cooldown/duration in seconds.
  // Cooldown starts on activation (so it includes the active duration). All timers tick on the fixed step (pause freezes them).
  abilities: {
    maxSlots: 3,                  // equipped abilities per bike
    turbo: { price: 0, cooldown: 15, duration: 125 / 37.5, mult: 2.5 }, // 2.5x base speed for 125/37.5 = ~3.33 s (~125 u at base 15 u/s)
    fastCharge: { price: 300, boostDuration: 2.1, jumpRecharge: 3.75 },   // passive
    rocketJump: { price: 300, cooldown: 8, height: 7, timeScale: 1.4 },    // timeScale stretches the arc (rise/float/fall)
    doubleJump: { price: 400 },                                           // passive: one extra jump per airtime (arc restarts from current height)
    airTurn: { price: 400 },                                              // passive
    protector: { price: 500, cooldown: 20, duration: 3 },                 // trails don't hurt; arena walls still do
    stealth: { price: 300, cooldown: 20, duration: 8 },
    slowDown: { price: 400, cooldown: 18, duration: 4, mult: 0.6 },       // slows YOUR OWN bike (for tight spaces)
    allBoost: { price: 600, cooldown: 0, duration: 0 },                   // once per round
    allJump: { price: 600, cooldown: 0, duration: 0 },                    // once per round
  },
  // Modes (phase 7). Hyper = Standard rules at a higher base speed. Death Match: lives, count-up timer, respawn.
  hyper: { speed: 25 },
  deathMatch: {
    lives: 3, respawnDelay: 1.5,
    spawnProtect: 1.0,            // seconds after a respawn that trails cannot kill the bike (walls / falling still do); 0 = off
    coinsPerKill: 5,              // SBCoins per kill on top of the placement coins (CFG.rewards.coins)
    samples: 200, margin: 9,      // respawn-spot search: random candidates, kept this far from platform edges / walls
  },
  tickHz: 120,
  inputBufferMs: 100,
  minTurnGap: 1,                  // min units travelled on a segment before the next turn (safe lane width)
  cameraSwing: 0.15,              // seconds to swing to new heading
  // low chase cam: high/close enough to see over the bike's own 2-high trail, bike sits lower-middle of screen
  camera: { back: 7, up: 7.5, lookAhead: 12, lookY: 0, fov: 75, fovBoost: 12, fovLerp: 6,
    // spectating after the player crashes: damped chase of a survivor, or slow orbit when nobody is left
    spectate: { follow: 3, orbitSpeed: 0.2, orbitRadius: 60, orbitHeight: 38, orbitLerp: 2 } },
  bikeScale: 1.1,                 // model is ~2.7 local units long => ~2.97 world units = one tile
  burst: { count: 48, speed: 14, life: 1.2, gravity: 20, pool: 400, flashLife: 0.5 },
  trailFade: 0.45,                // seconds for a crashed bike's trail to drop away
  render: {
    maxDpr: 2,                    // devicePixelRatio cap
    // bloom: strength 0 bypasses the composer entirely (weak phones). msaa = samples of the composer target (0 = off)
    // floor grid: fade to black between fadeNear..fadeFar units from the camera; gain scales brightness
    grid: { fadeNear: 30, fadeFar: 110, gain: 1.0 },
    bloom: { strength: 1.0, radius: 0.5, threshold: 0.2, msaa: 4 },
  },
  quality: { low: 1, medium: 1.5, high: 2 }, // DPR cap per graphics quality
  rewards: { coins: [100, 50, 25, 10] }, // SBCoins by match placement (1st..4th)
  audio: { master: 0.8, music: 0.35, sfx: 0.8, bpm: 112 },
  colors: { player: 0xff5a1f, floor: 0x000000, grid: 0xffffff, wall: 0x00ff66 },
  spawnRadius: 0.8,               // fraction of arena half-size
  match: { winPoints: 5, roundTime: 100, countdown: 3, goShowSec: 0.7, roundEndDelay: 3, playerOutDelay: 1.5 },
  // index 0 = player, then AI opponents
  players: [
    { name: 'PLAYER', color: 0xff5a1f },
    { name: 'BLUE', color: 0x1f8fff },
    { name: 'GREEN', color: 0xc8ff00 },
    { name: 'PURPLE', color: 0xb04dff },
  ],
  // Multiplayer client (docs/MULTIPLAYER.md). url = game server (override with ?server=ws://host:port). Never used by singleplayer.
  net: {
    url: 'ws://localhost:8787',
    pingMs: 2000,                 // ping interval (clock offset + RTT)
    reconnectMs: [1000, 2000, 4000, 8000, 15000, 30000], // backoff while in menus
    helloTimeoutMs: 8000,
    snapEps: 0.35,                // units: authoritative snap vs local bike position before the bike is corrected
    maxCatchup: 60,               // ticks the online sim may run in one frame to catch the server tick estimate
    lobbySec: 30,
  },
  ai: {
    difficulty: 1,                // 0 easy, 1 normal, 2 hard
    cell: 4,                      // flood-fill coarse grid cell size (units)
    maxLook: 60,
    jumpTrigger: 5,               // boxed-in AI jumps when the trail ahead is closer than this (units)
    boostLook: 45,
    loadouts: [[], [], ['turbo', 'protector']], // abilities per difficulty (Hard only)
    turboLook: 50,                // AI uses Turbo with at least this much open road ahead (and a per-think chance below)
    turboChance: 0.04, chasedDist: 14,                // AI boosts only with at least this much open road ahead
    levels: [
      // look: danger distance; every: think every N ticks (staggered); miss: chance to ignore danger on a think;
      // wander: chance of a random turn per think; flood/cut: hard-only behaviours
      // jump: may jump out of a box; boost: chance per think to boost on a long open straight (0 = never)
      // gap: chance (rolled once per approach) to jump a platform gap / climb onto a higher platform instead of turning away
      // All distances (look, jumpTrigger, boostLook, maxLook, turboLook) are multiplied by max(1, speed / CFG.baseSpeed).
      { look: 5,  every: 10, miss: 0.2,  wander: 0.01,  flood: false, cut: 0,    jump: false, boost: 0, gap: 0 },
      { look: 8,  every: 6,  miss: 0.03, wander: 0.006, flood: false, cut: 0,    jump: true,  boost: 0.03, gap: 0.15 },
      { look: 10, every: 4,  miss: 0,    wander: 0.004, flood: true,  cut: 0.35, jump: true,  boost: 0.06, gap: 0.3 },
    ],
  },
};
