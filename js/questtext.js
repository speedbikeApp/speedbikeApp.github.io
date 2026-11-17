// Pure text helpers for the QUESTS page (tested in tests/questtext.test.mjs).
import { parseReward } from './questdef.js';
import { ABILITIES } from './abilities.js';

/** Reward string -> "+500 SBCOINS / +2000 XP / RARE DROP / 5x PROTECTOR" parts ('' for an invalid string). */
export function rewardText(s) {
  const parts = parseReward(s) || [];
  return parts.map((r) => {
    if (r.type === 'coins') return `+${r.amount} SBCOINS`;
    if (r.type === 'xp') return `+${r.amount} XP`;
    if (r.type === 'powerup') return `${r.amount}x ${ABILITIES[r.id].name.toUpperCase()}`;
    return `${r.amount > 1 ? r.amount + 'x ' : ''}${r.type.replace('_drop', '').toUpperCase()} DROP`;
  }).join(' + ');
}
const p2 = (n) => String(n).padStart(2, '0');
/** ms left -> "hh:mm:ss" (hours may pass 24). */
export function hms(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return `${p2(Math.floor(s / 3600))}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}`; }
/** ms left -> "3d 4h" (under a day: "4h"). */
export function dh(ms) { const h = Math.max(0, Math.floor(ms / 3600000)); return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h`; }
/** ms left -> whole days, rounded up ("12 DAYS"). */
export const daysLeft = (ms) => Math.max(0, Math.ceil(ms / 86400000));
/** Completed but unclaimed quests in a questsView. */
export const unclaimedCount = (v) => [...v.daily, ...v.weekly, ...v.season, ...(v.event ? v.event.quests : [])].filter((q) => q.done && !q.claimed).length;
