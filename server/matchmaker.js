// Global per-mode queues and lobbies. No sockets and no timers in here: the host calls tick(now) regularly, so it is
// testable with a fake clock. A "player" is any object with { uid, username, rank, send(msg), where }.
//   p.where = null | {type:'queue', mode} | {type:'lobby', lobby} | {type:'match', ...}   (match is set by the host)
export const LOBBY_MAX = 4, LOBBY_MIN = 2, LOBBY_COUNTDOWN_MS = 30000;

export class Matchmaker {
  // allowed(mode, now) -> may a NEW queue join use this mode (the featured mode rotates; people already queued are kept).
  constructor({ now = Date.now, countdownMs = LOBBY_COUNTDOWN_MS, allowed = () => true, onStart }) {
    this.now = now; this.countdownMs = countdownMs; this.allowed = allowed; this.onStart = onStart;
    this.queues = new Map();   // mode -> [player]
    this.lobbies = [];         // open lobbies (at most one per mode)
    this.seq = 0;
  }

  queue(p, mode) {
    if (p.where) return { ok: false, code: 'busy', message: 'already queued or in a match' };
    if (!this.allowed(mode, this.now())) return { ok: false, code: 'bad_mode', message: 'mode not available right now' };
    if (!this.queues.has(mode)) this.queues.set(mode, []);
    this.queues.get(mode).push(p);
    p.where = { type: 'queue', mode };
    this.#pump(mode);
    return { ok: true };
  }

  // leaveQueue, or the socket dropped before the match started. Returns true if p was queued / in a lobby.
  leave(p) {
    const w = p.where;
    if (!w) return false;
    if (w.type === 'queue') {
      const q = this.queues.get(w.mode);
      q.splice(q.indexOf(p), 1);
      p.where = null; this.#notifyQueue(w.mode);
      return true;
    }
    if (w.type === 'lobby') {
      const l = w.lobby;
      l.players.splice(l.players.indexOf(p), 1);
      p.where = null;
      if (l.players.length < LOBBY_MIN) { // dissolve: whoever is left goes back to the FRONT of the queue
        this.lobbies.splice(this.lobbies.indexOf(l), 1);
        if (!this.queues.has(l.mode)) this.queues.set(l.mode, []);
        for (const r of l.players.reverse()) { r.where = { type: 'queue', mode: l.mode }; this.queues.get(l.mode).unshift(r); }
        this.#notifyQueue(l.mode);
      } else this.#sendLobby(l);
      return true;
    }
    return false;
  }

  tick(now = this.now()) {
    for (const l of [...this.lobbies]) if (now >= l.endsAt && l.players.length >= LOBBY_MIN) this.#start(l);
  }

  stats() {
    let queued = 0, inLobby = 0;
    for (const q of this.queues.values()) queued += q.length;
    for (const l of this.lobbies) inLobby += l.players.length;
    return { queued, inLobby, lobbies: this.lobbies.length };
  }

  #pump(mode) {
    const q = this.queues.get(mode);
    let l = this.lobbies.find((x) => x.mode === mode);
    if (!l && q.length >= LOBBY_MIN) { l = { id: ++this.seq, mode, players: [], endsAt: 0 }; this.lobbies.push(l); }
    if (!l) return this.#notifyQueue(mode);
    let joined = false;
    while (q.length && l.players.length < LOBBY_MAX) {
      const p = q.shift();
      p.colorIdx = [0, 1, 2, 3].find((c) => !l.players.some((x) => x.colorIdx === c)); // distinct colour per lobby
      p.where = { type: 'lobby', lobby: l }; l.players.push(p); joined = true;
    }
    if (joined) l.endsAt = this.now() + this.countdownMs; // every join resets the countdown
    if (l.players.length >= LOBBY_MAX) this.#start(l); else this.#sendLobby(l);
    this.#notifyQueue(mode);
  }

  #start(l) {
    this.lobbies.splice(this.lobbies.indexOf(l), 1);
    for (const p of l.players) p.where = { type: 'match' };
    this.onStart(l);
  }

  #sendLobby(l) {
    const msg = { t: 'lobby', mode: l.mode, players: l.players.map((p) => ({ uid: p.uid, username: p.username, rank: p.rank, colorIdx: p.colorIdx })), countdownEndsAt: l.endsAt, serverNow: this.now() };
    for (const p of l.players) p.send(msg);
  }

  #notifyQueue(mode) {
    const q = this.queues.get(mode) || [];
    q.forEach((p, i) => p.send({ t: 'queued', mode, position: i + 1, inQueue: q.length }));
  }
}
