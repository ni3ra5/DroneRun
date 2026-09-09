/**
 * DroneRun realtime relay — Cloudflare Worker + Durable Objects.
 *
 * One Durable Object per race room. That mapping is the reason this design
 * was chosen: a room is a single-threaded object with its own state, which is
 * exactly the shape of a lobby, and there is no always-on server to pay for.
 *
 * Rooms use the WebSocket **Hibernation** API rather than holding sockets in
 * memory. An idle lobby is evicted and costs nothing until a message arrives,
 * at which point the object wakes with its sockets intact. Two consequences
 * drive the code below:
 *
 *   · In-memory fields do not survive hibernation, so per-socket metadata
 *     lives in `ws.serializeAttachment()` and room-level state lives in
 *     Durable Object storage.
 *   · The live roster is derived from `state.getWebSockets()` rather than a
 *     tracked array, so it cannot drift out of sync with reality.
 *
 * The relay is deliberately dumb about the race itself. Course geometry is
 * never transmitted: both ends generate it from the seed, so the server only
 * has to agree on the seed and fan out ~40 bytes of kinematic state per
 * player per tick.
 */

/**
 * Room capacity, which is deliberately the same as the number of colours in
 * the client's palette (see PLAYER_COLORS in drone/DroneModel.js). Colours
 * are assigned here rather than chosen by players, so that every drone in a
 * room is a different colour — and because the room is the only place that
 * can know what is already taken.
 */
const MAX_PLAYERS = 8;
const COUNTDOWN_MS = 3000;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'dronerun-relay' });
    }

    // /room/<id>/ws  ->  the Durable Object for that room
    const match = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{1,32})\/ws$/);
    if (!match) return json({ error: 'not found' }, 404);

    const roomId = match[1].toUpperCase();
    // idFromName is deterministic, so the same room code always resolves to
    // the same object no matter which edge location the request lands on.
    const stub = env.RACE_ROOMS.get(env.RACE_ROOMS.idFromName(roomId));
    return stub.fetch(request);
  },
};

export class RaceRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    if (request.headers.get('upgrade') !== 'websocket') {
      return json({ error: 'expected websocket upgrade' }, 426);
    }

    const sockets = this.state.getWebSockets();
    if (sockets.length >= MAX_PLAYERS) {
      // Refuse politely over the socket so the client can show a message,
      // rather than failing the upgrade with an opaque error.
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify({ t: 'full', max: MAX_PLAYERS }));
      pair[1].close(4001, 'room full');
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernatable: the runtime may evict this object and still deliver
    // messages for this socket to webSocketMessage() later.
    this.state.acceptWebSocket(server);

    const seq = ((await this.state.storage.get('seq')) ?? 0) + 1;
    await this.state.storage.put('seq', seq);

    server.serializeAttachment({
      id: crypto.randomUUID().slice(0, 8),
      seq,
      name: null,
      colorIndex: null,   // assigned on hello, once we know who else is here
      ready: false,
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  // ── helpers ────────────────────────────────────────────────────────────

  /**
   * Live roster, derived from the sockets that actually exist.
   *
   * `exclude` matters more than it looks: a socket is still present in
   * `getWebSockets()` while its own close handler runs, so a departure has to
   * filter itself out explicitly or it stays on the roster it just left —
   * and, worse, remains host.
   */
  _roster(exclude = null) {
    return this.state.getWebSockets()
      .filter((ws) => ws !== exclude)
      .map((ws) => ({ ws, meta: ws.deserializeAttachment() }))
      .filter((e) => e.meta && e.meta.name)
      .sort((a, b) => a.meta.seq - b.meta.seq);
  }

  /** The longest-connected player runs the lobby. */
  _hostId(roster) {
    return roster.length ? roster[0].meta.id : null;
  }

  _players(roster) {
    const hostId = this._hostId(roster);
    return roster.map(({ meta }) => ({
      id: meta.id,
      name: meta.name,
      colorIndex: meta.colorIndex,
      ready: meta.ready,
      host: meta.id === hostId,
    }));
  }

  /**
   * Lowest palette slot nobody in the room is using.
   *
   * Capacity equals the palette size, so a slot is always available for
   * anyone the room actually admits.
   */
  _freeColorIndex(exclude = null) {
    const taken = new Set(
      this._roster(exclude).map((e) => e.meta.colorIndex).filter((i) => i != null),
    );
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (!taken.has(i)) return i;
    }
    return 0;   // unreachable while capacity matches the palette
  }

  _send(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch { /* socket already gone */ }
  }

  /** @param {{exceptId?: string, exclude?: WebSocket}} opts */
  _broadcast(msg, opts = {}) {
    const payload = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) {
      if (opts.exclude && ws === opts.exclude) continue;
      const meta = ws.deserializeAttachment();
      if (opts.exceptId && meta?.id === opts.exceptId) continue;
      try { ws.send(payload); } catch { /* socket already gone */ }
    }
  }

  _broadcastRoster(exclude = null) {
    const roster = this._roster(exclude);
    this._broadcast({ t: 'roster', players: this._players(roster) }, { exclude });
  }

  // ── message handling ───────────────────────────────────────────────────

  async webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;   // ignore anything that is not JSON
    }
    const meta = ws.deserializeAttachment();
    if (!meta) return;

    switch (msg.t) {
      case 'hello': {
        // Identify, then tell this player about the room and everyone else.
        meta.name = String(msg.name ?? 'Pilot').slice(0, 16);
        // The client does not get to choose: colours are handed out here so
        // no two drones in a room can look alike.
        meta.colorIndex = this._freeColorIndex(ws);
        meta.ready = false;
        ws.serializeAttachment(meta);

        let seed = await this.state.storage.get('seed');
        if (!seed) {
          // First player through the door sets the course.
          seed = String(msg.seed ?? 'shared-course').slice(0, 64);
          await this.state.storage.put('seed', seed);
        }
        const phase = (await this.state.storage.get('phase')) ?? 'lobby';

        const roster = this._roster();
        this._send(ws, {
          t: 'welcome',
          you: meta.id,
          yourColorIndex: meta.colorIndex,
          seed,
          phase,
          host: this._hostId(roster),
          players: this._players(roster),
        });
        this._broadcast(
          { t: 'join', id: meta.id, name: meta.name, colorIndex: meta.colorIndex },
          { exceptId: meta.id },
        );
        this._broadcastRoster();
        return;
      }

      case 'ready': {
        meta.ready = !!msg.ready;
        ws.serializeAttachment(meta);
        this._broadcastRoster();
        return;
      }

      case 'seed': {
        // Only the host may change the course, and only while in the lobby.
        const roster = this._roster();
        if (this._hostId(roster) !== meta.id) return;
        if (((await this.state.storage.get('phase')) ?? 'lobby') !== 'lobby') return;
        const seed = String(msg.seed ?? '').slice(0, 64);
        if (!seed) return;
        await this.state.storage.put('seed', seed);
        this._broadcast({ t: 'seed', seed });
        return;
      }

      case 'start': {
        const roster = this._roster();
        if (this._hostId(roster) !== meta.id) return;
        await this.state.storage.put('phase', 'racing');

        // Each client runs its own 3-2-1 on receipt rather than to a shared
        // wall clock. Clock synchronisation would buy tens of milliseconds of
        // alignment, which is meaningless when every player's time is
        // measured locally from their own countdown ending.
        this._broadcast({ t: 'start', countdownMs: COUNTDOWN_MS });
        return;
      }

      case 'lobby': {
        // Host returns everyone to the lobby after a race.
        const roster = this._roster();
        if (this._hostId(roster) !== meta.id) return;
        await this.state.storage.put('phase', 'lobby');
        for (const entry of roster) {
          entry.meta.ready = false;
          entry.ws.serializeAttachment(entry.meta);
        }
        this._broadcast({ t: 'lobby' });
        this._broadcastRoster();
        return;
      }

      case 'state': {
        // The hot path: relayed to everyone else and never persisted. Storage
        // writes here would cost a disk round-trip 20 times a second per
        // player for data that is stale before it lands.
        this._broadcast({
          t: 'state',
          id: meta.id,
          name: meta.name,
          colorIndex: meta.colorIndex,
          p: msg.p,
          q: msg.q,
          gate: msg.gate,
          time: msg.time,
        }, { exceptId: meta.id });
        return;
      }

      case 'event': {
        this._broadcast({ t: 'event', id: meta.id, kind: msg.kind, payload: msg.payload },
          { exceptId: meta.id });
        return;
      }

      case 'ping':
        this._send(ws, { t: 'pong', at: msg.at });
        return;

      default:
        return;
    }
  }

  async webSocketClose(ws) {
    await this._departed(ws);
  }

  async webSocketError(ws) {
    await this._departed(ws);
  }

  async _departed(ws) {
    const meta = ws.deserializeAttachment();
    if (meta?.name) this._broadcast({ t: 'leave', id: meta.id }, { exclude: ws });

    // The departing socket is filtered out explicitly — see _roster — so the
    // roster that goes out is the post-departure one, including a new host if
    // the player who left was holding it.
    const roster = this._roster(ws);
    if (roster.length === 0) {
      // Nobody left: drop the room's state so a later reuse of the same code
      // starts clean instead of inheriting a stale seed and phase.
      await this.state.storage.deleteAll();
      return;
    }
    this._broadcastRoster(ws);
  }
}
