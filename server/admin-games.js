// GAMES tab ops. args are untrusted (admin.js already verified the sender is an admin). Ops:
//   gget {} -> {lobbies, queues, rooms, featured:{current, override, cycle}}   (waiting lobbies / queues from the matchmaker, running rooms)
//   gstart {lobby:id} | {queue:mode}   start a waiting lobby / queue now (empty seats become bots)
//   gstop {id}                         end a running room at once; nobody's rank changes (host: reason 'stopped')
//   gfeatured {mode:'auto'|hyper|3d|multimap}   override the hourly featured mode (persisted), 'auto' clears it
import { FEATURED_CYCLE } from '../js/rotation.js';
import { adminError as E } from './admin.js';

// deps: { admin, mm, rooms (Map), featured: { view(), set(mode|null) }, log }
export function registerGameOps({ admin, mm, rooms, featured, log = () => {} }) {
  admin.register('gget', async () => ({ ...mm.view(), rooms: [...rooms.values()].map((r) => r.adminView()), featured: { ...featured.view(), cycle: FEATURED_CYCLE } }));
  admin.register('gstart', async (a, ctx) => {
    const ok = a.lobby !== undefined ? mm.forceStart(a.lobby) : typeof a.queue === 'string' && mm.forceStartQueue(a.queue);
    if (!ok) throw E('not_found');
    log(`[admin] ${ctx.uid} force start ${a.lobby ?? a.queue}`); return {};
  });
  admin.register('gstop', async (a, ctx) => {
    const r = rooms.get(a.id);
    if (!r || r.over) throw E('not_found');
    log(`[admin] ${ctx.uid} stop room ${r.id}`); r.stop(); return {};
  });
  admin.register('gfeatured', async (a, ctx) => {
    const m = a.mode === 'auto' ? null : a.mode;
    if (m !== null && !FEATURED_CYCLE.includes(m)) throw E('bad_mode');
    await featured.set(m); log(`[admin] ${ctx.uid} featured ${m || 'auto'}`);
    return { featured: { ...featured.view(), cycle: FEATURED_CYCLE } };
  });
}
