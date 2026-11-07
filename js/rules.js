// Pure round-scoring rules (no DOM, no three). Ids are bike ids.
const pick = (arr, rng) => arr[Math.floor(rng() * arr.length) % arr.length];

// One tick's crashes. aliveBefore: ids alive before the tick; crashed: ids that crashed this tick.
// Each crashed bike gives 1 point to a random surviving opponent; if exactly one bike is left it also
// gets the last-alive point and the round ends; if none are left (head-on / same-tick wipe) nobody scores.
export function resolveTick(aliveBefore, crashed, rng = Math.random) {
  const survivors = aliveBefore.filter((id) => !crashed.includes(id));
  const awards = [];
  if (survivors.length) for (let i = 0; i < crashed.length; i++) awards.push(pick(survivors, rng));
  let ended = false;
  if (crashed.length && survivors.length <= 1) {
    ended = true;
    if (survivors.length === 1) awards.push(survivors[0]);
  }
  return { awards, ended, survivors };
}

// The human player crashed (offline game: don't make them wait). The round ends at once and a random bot that is still alive
// after this tick gets the point (nobody if every bot went down in the same tick). Other crashes of that tick give nothing.
export function resolvePlayerOut(aliveBefore, crashed, playerId, rng = Math.random) {
  const survivors = aliveBefore.filter((id) => !crashed.includes(id));
  return { awards: survivors.length ? [pick(survivors, rng)] : [], ended: true, survivors, playerOut: true };
}

// Timer ran out: every alive bike gets 1 point.
export function resolveTimeout(alive) { return { awards: [...alive], ended: true, survivors: [...alive] }; }

export function applyAwards(scores, awards) { for (const id of awards) scores[id] = (scores[id] || 0) + 1; }

// Highest score >= winPoints, or null.
export function matchWinner(scores, winPoints) {
  const ids = Object.keys(scores).map(Number);
  const best = ids.filter((id) => scores[id] >= winPoints).sort((a, b) => scores[b] - scores[a] || a - b);
  return best.length ? best[0] : null;
}

// Competition ranking by points: equal points share a rank (5,3,3,0 -> 1,2,2,4). Returns {id: rank}.
export function rankings(scores) {
  const order = placements(scores), out = {};
  order.forEach((id, i) => { out[id] = i > 0 && scores[id] === scores[order[i - 1]] ? out[order[i - 1]] : i + 1; });
  return out;
}

// Ids sorted by points desc (ties by id, display order only - use rankings() for placement).
export function placements(scores) {
  return Object.keys(scores).map(Number).sort((a, b) => scores[b] - scores[a] || a - b);
}
