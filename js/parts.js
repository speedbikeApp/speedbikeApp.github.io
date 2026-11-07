// Garage parts: pure data (no three, no DOM). render.js builds the meshes from the ids; save.js validates against PARTS.
// A part is {id, name, price, ach?}. price = SBCoins; ach = achievement id that unlocks it (price then ignored);
// price 0 and no ach = free (owned from the start). Colours are 0xRRGGBB.
export const CATS = ['body', 'tire', 'rim', 'glow'];
export const CAT_LABEL = { body: 'BODY', tire: 'TIRES', rim: 'RIMS', glow: 'COLOR' };
export const DEFAULT_PARTS = { body: 'sleek', tire: 'slim', rim: 'spoked', glow: 'orange' };

export const PARTS = {
  body: [
    { id: 'sleek', name: 'Sleek', price: 0 },
    { id: 'armored', name: 'Armored', price: 500 },
    { id: 'frame', name: 'Open Frame', price: 350 },
    { id: 'wedge', name: 'Wedge', price: 0, ach: 'streak10' },
    { id: 'apex', name: 'Apex', price: 0, ach: 'wins100' },
  ],
  tire: [
    { id: 'slim', name: 'Slim', price: 0 },
    { id: 'wide', name: 'Wide', price: 300 },
    { id: 'dual', name: 'Dual', price: 0, ach: 'hyperWin' },
    { id: 'knobby', name: 'Knobby', price: 0, ach: 'dist50k' },
  ],
  rim: [
    { id: 'spoked', name: 'Spoked', price: 0 },
    { id: 'disc', name: 'Solid Disc', price: 200 },
    { id: 'triblade', name: 'Tri-Blade', price: 0, ach: 'boost5' },
    { id: 'ring', name: 'Ring', price: 0, ach: 'jump5' },
    { id: 'turbine', name: 'Turbine', price: 0, ach: 'kills100' },
  ],
  glow: [
    { id: 'orange', name: 'Orange', price: 0, color: 0xff5a1f },
    { id: 'cyan', name: 'Cyan', price: 0, color: 0x00e5ff },
    { id: 'red', name: 'Red', price: 0, color: 0xff2a3d },
    { id: 'blue', name: 'Blue', price: 100, color: 0x1f8fff },
    { id: 'violet', name: 'Violet', price: 100, color: 0xb04dff },
    { id: 'acid', name: 'Acid', price: 150, color: 0x7dff2e },
    { id: 'yellow', name: 'Yellow', price: 150, color: 0xffe600 },
    { id: 'magenta', name: 'Magenta', price: 200, color: 0xff2fd0 },
    { id: 'white', name: 'Ice White', price: 250, color: 0xf2f2ff },
    { id: 'gold', name: 'Gold', price: 0, color: 0xffb300, ach: 'flawless' },
    { id: 'mint', name: 'Mint', price: 0, color: 0x2affb0, ach: 'win3d' },
  ],
};

export const partList = (cat) => PARTS[cat] || [];
export const getPart = (cat, id) => partList(cat).find((p) => p.id === id) || null;
export const isPartId = (cat, id) => !!getPart(cat, id);
export const isFreePart = (p) => !p.ach && !(p.price > 0);
export const freeParts = (cat) => partList(cat).filter(isFreePart).map((p) => p.id);
export const glowHex = (id) => (getPart('glow', id) || getPart('glow', DEFAULT_PARTS.glow)).color;

// ---- colour clash ----
export const CLASH_DIST = 100; // RGB euclidean distance (0..255 per channel) below which two bikes look alike
export function colorDist(a, b) {
  const dr = ((a >> 16) & 255) - ((b >> 16) & 255), dg = ((a >> 8) & 255) - ((b >> 8) & 255), db = (a & 255) - (b & 255);
  return Math.sqrt(dr * dr + dg * dg + db * db);
}
// Give every AI a colour that is not close to the player's (or to an earlier AI). ai = [{name,color}]. Clashing AIs take the
// palette colour (all glow colours) farthest from every used colour, and its name. Returns a new array.
export function resolveAiColors(playerColor, ai) {
  const used = [playerColor], out = [];
  for (const a of ai) {
    let pick = a;
    if (used.some((c) => colorDist(c, a.color) < CLASH_DIST)) {
      let best = null;
      for (const g of PARTS.glow) {
        const d = Math.min(...used.map((c) => colorDist(c, g.color)), ...ai.map((o) => (o === a ? 1e9 : colorDist(o.color, g.color) * 0.5)));
        if (d >= CLASH_DIST && (!best || d > best.d)) best = { d, name: g.name.toUpperCase(), color: g.color };
      }
      if (best) pick = { name: best.name, color: best.color };
    }
    used.push(pick.color); out.push({ name: pick.name, color: pick.color });
  }
  return out;
}
