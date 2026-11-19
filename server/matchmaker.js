// Global per-mode queues and lobbies. No sockets and no timers in here: the host calls tick(now) regularly, so it is
// testable with a fake clock. A "player" is any object with { uid, username, rank, send(msg), where }.
//   p.where = null | {type:'queue', mode} | {type:'lobby', lobby} | {type:'match', ...}   (match is set by the host)
// Queue entries are { players:[p...], group } : a solo player is an entry of one; a PARTY is queued with queueGroup() and is placed into one
// lobby atomically (never split). Grouped players carry p.group (the party id) until the host clears it; the host reads it at onStart.
// Parties (unranked) and solo players (ranked) never share a lobby: otherwise a party could be used to farm rank wins from solos. So the open lobbies
// are at most one per (mode, party-or-solo); two parties may share a party lobby.
// Solo lobbies (with a makeBot hook): ONE human is enough. If nobody else joins within soloWaitMs, bots join one at a time (botJoinMs apart,
// l.bots) and the match starts when the lobby is full. A second human switches the lobby to the normal countdown (bots that already joined stay).
export const LOBBY_MAX = 4, LOBBY_MIN = 2, LOBBY_COUNTDOWN_MS = 30000, SOLO_WAIT_MS = 5000, BOT_JOIN_MS = [1000, 3000];

export class Matchmaker {
  // allowed(mode, now) -> may a NEW queue join use this mode (the featured mode rotates; people already queued are kept).
  // makeBot(humans, bots) -> a bot entry { username, rank, colorIdx, ... } (server/bots.js newBot); without it a lobby needs LOBBY_MIN humans.
  constructor({ now = Date.now, countdownMs = LOBBY_COUNTDOWN_MS, allowed = () => true, onStart, makeBot = null, soloWaitMs = SOLO_WAIT_MS, botJoinMs = BOT_JOIN_MS, rng = Math.random }) {
    this.now = now; this.countdownMs = countdownMs; this.allowed = allowed; this.onStart = onStart;
    this.makeBot = makeBot; this.soloWaitMs = soloWaitMs; this.botJoinMs = botJoinMs; this.rng = rng;
    this.queues = new Map();   // mode -> [entry]  entry = { players:[player], group:id|null }
    this.lobbies = [];         // open lobbies (at most one per mode and kind), l.party = party lobby
    this.seq = 0;
  }

  queue(p, mode) {
    if (p.where) return { ok: false, code: 'busy', message: 'already queued or in a match' };
    if (!this.allowed(mode, this.now())) return { ok: false, code: 'bad_mode', message: 'mode not available right now' };
    if (!this.queues.has(mode)) this.queues.set(mode, []);
    this.queues.get(mode).push({ players: [p], group: null });
    p.where = { type: 'queue', mode };
    this.#pump(mode);
    return { ok: true };
  }

  // Queue a party as one unit. members: 2..LOBBY_MAX players (all idle), group: party id. -> { ok } | { ok:false, code, message }
  queueGroup(members, mode, group) {
    if (members.length < LOBBY_MIN || members.length > LOBBY_MAX) return { ok: false, code: 'bad_party', message: 'party size not allowed' };
    if (members.some((p) => p.where)) return { ok: false, code: 'busy', message: 'already queued or in a match' };
    if (!this.allowed(mode, this.now())) return { ok: false, code: 'bad_mode', message: 'mode not available right now' };
    if (!this.queues.has(mode)) this.queues.set(mode, []);
    this.queues.get(mode).push({ players: members.slice(), group });
    for (const p of members) { p.where = { type: 'queue', mode }; p.group = group; }
    this.#pump(mode);
    return { ok: true };
  }

  // leaveQueue, or the socket dropped before the match started. Returns true if p was queued / in a lobby.
  leave(p) {
    const w = p.where;
    if (!w) return false;
    if (w.type === 'queue') {
      const q = this.queues.get(w.mode), i = q.findIndex((e) => e.players.includes(p)), e = q[i];
      e.players.splice(e.players.indexOf(p), 1);
      if (!e.players.length) q.splice(i, 1);
      p.where = null; p.group = null; this.#notifyQueue(w.mode);
      return true;
    }
    if (w.type === 'lobby') {
      const l = w.lobby;
      l.players.splice(l.players.indexOf(p), 1);
      p.where = null; p.group = null;
      if (l.players.length < (this.#solo(l) ? 1 : LOBBY_MIN)) { // dissolve: whoever is left goes back to the FRONT of the queue (parties stay together)
        this.lobbies.splice(this.lobbies.indexOf(l), 1);
        if (!this.queues.has(l.mode)) this.queues.set(l.mode, []);
        const back = [];
        for (const r of l.players) {
          r.where = { type: 'queue', mode: l.mode };
          const e = r.group != null && back.find((x) => x.group === r.group);
          if (e) e.players.push(r); else back.push({ players: [r], group: r.group ?? null });
        }
        this.queues.get(l.mode).unshift(...back);
        this.#notifyQueue(l.mode);
      } else { if (this.#solo(l) && l.players.length === 1) this.#plan(l); this.#sendLobby(l); }
      return true;
    }
    return false;
  }

  tick(now = this.now()) {
    for (const l of [...this.lobbies]) {
      let arrived = false;
      while (l.plan?.length && now >= l.plan[0]) { l.plan.shift(); l.bots.push(this.makeBot(l.players, l.bots)); arrived = true; }
      if (this.#seats(l) >= LOBBY_MAX || (now >= l.endsAt && l.players.length >= (this.#solo(l) ? 1 : LOBBY_MIN))) this.#start(l);
      else if (arrived) this.#sendLobby(l);
    }
  }

  // Admin: start a waiting lobby now (free seats become bots in onStart, same as the countdown running out).
  forceStart(id) {
    const l = this.lobbies.find((x) => x.id === id);
    if (!l) return false;
    l.forced = true; this.#start(l); return true;
  }

  // Admin: start whoever waits in a mode's queue (e.g. a lone searcher who never got a lobby) with bots. One kind (party / solo) per match, like #pump.
  forceStartQueue(mode) {
    const q = this.queues.get(mode);
    if (!q || !q.length) return false;
    const party = q[0].players.some((p) => p.group != null), l = { id: ++this.seq, mode, party, players: [], bots: [], plan: null, endsAt: 0, forced: true };
    this.lobbies.push(l);
    for (let i = 0; i < q.length && l.players.length < LOBBY_MAX;) {
      if (q[i].players.some((p) => p.group != null) !== party || q[i].players.length > LOBBY_MAX - l.players.length) { i++; continue; }
      for (const p of q.splice(i, 1)[0].players) { p.colorIdx = [0, 1, 2, 3].find((c) => !l.players.some((x) => x.colorIdx === c)); p.where = { type: 'lobby', lobby: l }; l.players.push(p); }
    }
    this.#start(l); this.#notifyQueue(mode); return true;
  }

  // Admin bots switch: null = no bots (lobbies need LOBBY_MIN humans again; a lone human goes back to the queue, bots already in a lobby leave).
  setMakeBot(fn) {
    this.makeBot = fn;
    for (const l of [...this.lobbies]) {
      if (l.party) continue;
      if (fn) { if (l.players.length === 1) { this.#plan(l); this.#sendLobby(l); } continue; }
      l.bots = []; l.plan = null;
      if (l.players.length >= LOBBY_MIN) { this.#sendLobby(l); continue; }
      this.lobbies.splice(this.lobbies.indexOf(l), 1);
      for (const p of l.players) { p.where = { type: 'queue', mode: l.mode }; this.queues.get(l.mode).unshift({ players: [p], group: null }); }
    }
    for (const m of this.queues.keys()) this.#pump(m);
  }

  /** Admin view: waiting lobbies + non-empty queues. */
  view() {
    const names = (ps) => ps.map((p) => p.username);
    return {
      lobbies: this.lobbies.map((l) => ({ id: l.id, mode: l.mode, party: l.party, players: [...names(l.players), ...l.bots.map((b) => `${b.username} (BOT)`)], endsAt: l.endsAt })),
      queues: [...this.queues].filter(([, q]) => q.length).map(([mode, q]) => ({ mode, players: names(q.flatMap((e) => e.players)) })),
    };
  }

  stats() {
    let queued = 0, inLobby = 0;
    for (const q of this.queues.values()) for (const e of q) queued += e.players.length;
    for (const l of this.lobbies) inLobby += l.players.length;
    return { queued, inLobby, lobbies: this.lobbies.length };
  }

  #pump(mode) {
    const q = this.queues.get(mode);
    for (const party of [false, true]) {
      const mine = (e) => e.players.some((p) => p.group != null) === party; // a lone leftover of a dissolved party (group cleared) is a solo again
      let l = this.lobbies.find((x) => x.mode === mode && x.party === party);
      if (!l && q.filter(mine).reduce((n, e) => n + e.players.length, 0) >= (party || !this.makeBot ? LOBBY_MIN : 1)) { l = { id: ++this.seq, mode, party, players: [], bots: [], plan: null, endsAt: 0 }; this.lobbies.push(l); }
      if (!l) continue;
      let joined = false;
      for (let i = 0; i < q.length && this.#seats(l) < LOBBY_MAX;) { // first entries that fit (a party that does not fit waits for the next lobby)
        if (!mine(q[i]) || q[i].players.length > LOBBY_MAX - this.#seats(l)) { i++; continue; }
        for (const p of q.splice(i, 1)[0].players) {
          p.colorIdx = [0, 1, 2, 3].find((c) => ![...l.players, ...l.bots].some((x) => x.colorIdx === c)); // distinct colour per lobby
          p.where = { type: 'lobby', lobby: l }; l.players.push(p); joined = true;
        }
      }
      if (joined) { if (this.#solo(l) && l.players.length === 1) this.#plan(l); else { l.plan = null; l.endsAt = this.now() + this.countdownMs; } } // every join resets the countdown
      if (this.#seats(l) >= LOBBY_MAX) this.#start(l); else this.#sendLobby(l);
    }
    this.#notifyQueue(mode);
  }

  #solo(l) { return !l.party && !!this.makeBot; }
  #seats(l) { return l.players.length + l.bots.length; }
  // One human in a solo lobby: schedule the bot arrivals (first after soloWaitMs, or a join gap if some bots are already in); endsAt = the last one.
  #plan(l) {
    const gap = () => Math.round(this.botJoinMs[0] + this.rng() * (this.botJoinMs[1] - this.botJoinMs[0]));
    let t = this.now() + (l.bots.length ? gap() : this.soloWaitMs);
    l.plan = [];
    for (let n = LOBBY_MAX - 1 - l.bots.length; n > 0; n--) { l.plan.push(t); t += gap(); }
    l.endsAt = l.plan.at(-1) ?? this.now();
  }

  #start(l) {
    this.lobbies.splice(this.lobbies.indexOf(l), 1);
    for (const p of l.players) p.where = { type: 'match' };
    this.onStart(l);
    if ((this.queues.get(l.mode) || []).length) this.#pump(l.mode); // anyone left over (e.g. a party that did not fit) opens the next lobby
  }

  #sendLobby(l) {
    const msg = { t: 'lobby', mode: l.mode, players: [...l.players.map((p) => ({ uid: p.uid, username: p.username, rank: p.rank, colorIdx: p.colorIdx, ...(p.admin ? { admin: true } : {}) })),
      ...l.bots.map((b) => ({ uid: null, username: b.username, rank: b.rank, colorIdx: b.colorIdx }))], countdownEndsAt: l.endsAt, serverNow: this.now() };
    for (const p of l.players) p.send(msg);
  }

  #notifyQueue(mode) {
    const ps = (this.queues.get(mode) || []).flatMap((e) => e.players);
    ps.forEach((p, i) => p.send({ t: 'queued', mode, position: i + 1, inQueue: ps.length }));
  }
}
