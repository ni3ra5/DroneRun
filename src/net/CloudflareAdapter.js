import { NetworkAdapter } from './Network.js';
import { PLAYER_COLORS } from '../drone/DroneModel.js';

/**
 * WebSocket adapter for the Cloudflare Durable Object relay in `server/`.
 *
 * Implements the same four-method contract as LocalAdapter, so swapping it in
 * is all that is needed to take the game online — Game already sends state at
 * a fixed rate and RemoteFleet already renders and interpolates whatever
 * arrives.
 *
 * Beyond the three events RemoteFleet consumes ('join', 'leave', 'state') it
 * also emits the lobby's events: 'roster', 'seed', 'start', 'lobby', 'full',
 * 'status' and 'event'.
 *
 * The relay assigns each player a palette slot so no two drones in a room
 * share a colour. It sends the slot index, not a colour value — the palette
 * itself stays in the client, in one place. This adapter resolves index to
 * colour on the way in, so everything downstream still just sees a colour.
 *
 * Reconnection is deliberate rather than automatic-and-silent: a dropped
 * socket mid-race emits 'status' so the UI can say so, and retries with
 * backoff. Reconnecting re-sends `hello`, which the relay treats as a fresh
 * join — a rejoining player gets a new id, so stale peers are cleaned up by
 * the relay's own leave broadcast rather than lingering as ghosts.
 */

const MAX_BACKOFF = 8000;

export class CloudflareAdapter extends NetworkAdapter {
  /**
   * @param {string} baseUrl e.g. wss://dronerun-relay.example.workers.dev
   */
  constructor(baseUrl) {
    super();
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.ws = null;
    this.room = null;
    this.identity = null;
    this.selfId = null;
    this.players = [];
    this.seed = null;
    this.phase = 'lobby';
    this._open = false;
    this._closing = false;
    this._attempt = 0;
    this._retryTimer = null;
  }

  get connected() { return this._open; }
  get peerCount() { return Math.max(0, this.players.length - 1); }
  get isHost() { return this.players.find((p) => p.id === this.selfId)?.host === true; }

  /** Palette slot -> colour, with a safe fallback for an unexpected index. */
  static colorFor(index) {
    return PLAYER_COLORS[index]?.hex ?? PLAYER_COLORS[0].hex;
  }

  _withColors(players) {
    return players.map((p) => ({ ...p, color: CloudflareAdapter.colorFor(p.colorIndex) }));
  }

  /**
   * @param {string} room room code
   * @param {{id: string, name: string, color: number}} identity
   * @param {{seed?: string}} opts seed proposed if this player creates the room
   * @returns {Promise<object>} the relay's welcome payload
   */
  connect(room, identity, opts = {}) {
    this.room = String(room).toUpperCase();
    this.identity = identity;
    this._proposedSeed = opts.seed ?? null;
    this._closing = false;

    return new Promise((resolve, reject) => {
      this._welcomeResolve = resolve;
      this._welcomeReject = reject;
      this._openSocket();
    });
  }

  _openSocket() {
    const url = `${this.baseUrl}/room/${this.room}/ws`;
    this.emit('status', { state: this._attempt ? 'reconnecting' : 'connecting' });

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this._scheduleRetry(err);
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this._open = true;
      this._attempt = 0;
      this._send({
        t: 'hello',
        name: this.identity.name,
        seed: this._proposedSeed ?? undefined,
      });
    });

    ws.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this._handle(msg);
    });

    ws.addEventListener('close', (e) => {
      this._open = false;
      if (this._closing) return;
      // 4001 is the relay turning us away for a full room; retrying is futile.
      if (e.code === 4001) {
        this.emit('status', { state: 'rejected', reason: 'full' });
        this._welcomeReject?.(new Error('room full'));
        this._welcomeReject = null;
        return;
      }
      this.emit('status', { state: 'disconnected' });
      this._scheduleRetry();
    });

    ws.addEventListener('error', () => {
      // 'close' always follows, so retry scheduling lives there to avoid
      // queueing two attempts for one failure.
    });
  }

  _scheduleRetry(err) {
    if (this._closing) return;
    this._attempt++;
    if (this._attempt > 6) {
      this.emit('status', { state: 'failed' });
      this._welcomeReject?.(err ?? new Error('could not reach the relay'));
      this._welcomeReject = null;
      return;
    }
    const wait = Math.min(MAX_BACKOFF, 400 * 2 ** (this._attempt - 1));
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => this._openSocket(), wait);
  }

  _handle(msg) {
    switch (msg.t) {
      case 'welcome':
        this.selfId = msg.you;
        this.colorIndex = msg.yourColorIndex ?? 0;
        this.seed = msg.seed;
        this.phase = msg.phase;
        this.players = this._withColors(msg.players ?? []);
        this.emit('status', { state: 'connected' });
        // The room decided our colour, so tell the game before the roster —
        // it needs to repaint the local drone.
        this.emit('color', { index: this.colorIndex, color: CloudflareAdapter.colorFor(this.colorIndex) });
        this.emit('roster', { players: this.players, selfId: this.selfId, isHost: this.isHost });
        this.emit('seed', { seed: msg.seed });
        this._welcomeResolve?.(msg);
        this._welcomeResolve = null;
        this._welcomeReject = null;
        break;

      case 'roster':
        this.players = this._withColors(msg.players ?? []);
        this.emit('roster', { players: this.players, selfId: this.selfId, isHost: this.isHost });
        break;

      case 'join':
        // RemoteFleet creates the peer's drone from this.
        this.emit('join', {
          id: msg.id, name: msg.name, color: CloudflareAdapter.colorFor(msg.colorIndex),
        });
        break;

      case 'leave':
        this.emit('leave', { id: msg.id });
        break;

      case 'state':
        this.emit('state', { ...msg, color: CloudflareAdapter.colorFor(msg.colorIndex) });
        break;

      case 'event':
        this.emit('event', msg);
        break;

      case 'seed':
        this.seed = msg.seed;
        this.emit('seed', { seed: msg.seed });
        break;

      case 'start':
        this.phase = 'racing';
        this.emit('start', { countdownMs: msg.countdownMs });
        break;

      case 'lobby':
        this.phase = 'lobby';
        this.emit('lobby', {});
        break;

      case 'full':
        this.emit('status', { state: 'rejected', reason: 'full', max: msg.max });
        break;

      default:
        break;
    }
  }

  _send(msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try { this.ws.send(JSON.stringify(msg)); } catch { /* dropped */ }
  }

  // ── the NetworkAdapter contract ────────────────────────────────────────

  sendState(packet) {
    this._send({ t: 'state', p: packet.p, q: packet.q, gate: packet.gate, time: packet.time });
  }

  sendEvent(kind, payload) {
    this._send({ t: 'event', kind, payload });
  }

  disconnect() {
    this._closing = true;
    clearTimeout(this._retryTimer);
    this._open = false;
    try { this.ws?.close(1000, 'left'); } catch { /* already gone */ }
    this.ws = null;
  }

  // ── lobby actions ──────────────────────────────────────────────────────

  setReady(ready) { this._send({ t: 'ready', ready: !!ready }); }
  setSeed(seed) { this._send({ t: 'seed', seed }); }
  startRace() { this._send({ t: 'start' }); }
  returnToLobby() { this._send({ t: 'lobby' }); }
}

/** Short, unambiguous room code — no vowels, so it cannot spell anything. */
export function makeRoomCode() {
  const alphabet = 'BCDFGHJKLMNPQRSTVWXZ23456789';
  let out = '';
  for (let i = 0; i < 5; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}
