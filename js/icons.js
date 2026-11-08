// Neon line icons (24px viewBox, stroke = currentColor) for abilities + the core BOOST / JUMP buttons. Pure strings, no DOM.
const dots = '<circle cx="6" cy="21" r=".8"/><circle cx="12" cy="21" r=".8"/><circle cx="18" cy="21" r=".8"/>'; // "all players" marker
const P = {
  boost: '<path d="M4 5l7 7-7 7M12 5l7 7-7 7"/>',
  jump: '<path d="M12 18V4M6 10l6-6 6 6M5 22h14"/>',
  turbo: '<path d="M13 2L5 13.5h6L10 22l9-12h-6z"/>',
  fastCharge: '<rect x="2.5" y="7" width="16" height="10" rx="2"/><path d="M21.5 10.5v3M11.5 9l-2.5 3h3.5L10 15"/>',
  rocketJump: '<path d="M12 2c3 3 4 7 4 11l-4 3-4-3c0-4 1-8 4-11zM8 14l-3 4 3-1M16 14l3 4-3-1M12 18v4"/><circle cx="12" cy="9" r="1.5"/>',
  doubleJump: '<path d="M12 22V9M6 15l6-6 6 6M6 8l6-6 6 6"/>',
  airTurn: '<path d="M4 21v-8a7 7 0 0 1 7-7h9M16 2l4 4-4 4"/>',
  protector: '<path d="M12 2l8 3v6c0 5.5-3.5 9-8 11-4.5-2-8-5.500-8-11V5z"/><path d="M8.500 11.500l2.500 2.500 4.500-5"/>',
  stealth: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/>',
  slowDown: '<path d="M12 3v13M6 11l6 6 6-6M5 22h14"/>',
  allBoost: '<path d="M5 3l6 6-6 6M13 3l6 6-6 6"/>' + dots,
  allJump: '<path d="M12 16V3M6 9l6-6 6 6"/>' + dots,
};
export const abilityIcon = (id) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[id] || ''}</svg>`;
