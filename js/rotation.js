// Multiplayer mode availability (pure). Standard + Death Match always; one featured mode that rotates every hour.
export const FIXED_MODES = ['standard', 'deathmatch'];
export const FEATURED_CYCLE = ['hyper', '3d', 'multimap'];
export const ROTATION_MS = 3600000;

export const featuredMode = (now = Date.now()) => FEATURED_CYCLE[Math.floor(now / ROTATION_MS) % FEATURED_CYCLE.length];
export const nextRotation = (now = Date.now()) => (Math.floor(now / ROTATION_MS) + 1) * ROTATION_MS;
export const multiplayerModes = (now = Date.now()) => [...FIXED_MODES, featuredMode(now)];
export const isMultiplayerMode = (mode, now = Date.now()) => multiplayerModes(now).includes(mode);
