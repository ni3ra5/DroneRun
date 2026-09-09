import * as THREE from 'three';
import { DroneModel } from '../drone/DroneModel.js';

/**
 * Networking seam.
 *
 * The game is single-player today, but it talks to the world only through
 * this interface so that adding a server later is a drop-in. Two rules make
 * that cheap:
 *
 *   1. Track geometry is never transmitted. Both ends derive it from the seed
 *      (see TrackGenerator), so a room is identified by seed + room id alone.
 *   2. Only kinematic state crosses the wire, at a fixed low rate, and remote
 *      drones are interpolated on the receiving end.
 *
 * To go multiplayer, implement an adapter with the same four methods that
 * emits 'join', 'leave' and 'state' events, and hand it to Game instead of
 * LocalAdapter. Nothing else in the codebase needs to change.
 *
 * Wire format for a state packet (all optional except id and p):
 *   { id: string, name: string, color: number,
 *     p: [x, y, z], q: [x, y, z, w], gate: number, time: number }
 */

class Emitter {
  constructor() { this._handlers = new Map(); }

  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(fn);
    return () => this._handlers.get(event).delete(fn);
  }

  emit(event, payload) {
    const set = this._handlers.get(event);
    if (set) for (const fn of set) fn(payload);
  }
}

export class NetworkAdapter extends Emitter {
  /** @returns {Promise<void>} resolves once the room is joined */
  async connect(_room, _identity) {}
  /** Called at SEND_HZ with the local drone's kinematic state. */
  sendState(_packet) {}
  /** Called when the local player passes a gate or finishes. */
  sendEvent(_type, _payload) {}
  disconnect() {}
  get connected() { return false; }
  get peerCount() { return 0; }
}

/** Single-player: accepts everything, emits nothing. */
export class LocalAdapter extends NetworkAdapter {
  async connect(room) { this.room = room; }
  get connected() { return true; }
}

export const SEND_HZ = 20;

/**
 * Renders and interpolates other players' drones.
 *
 * Remote state arrives at ~20 Hz but we draw at 60+, so each peer is rendered
 * INTERP_DELAY behind the newest packet and interpolated between the two
 * snapshots that straddle the render time. That trades a fixed ~120 ms of
 * latency for motion with no visible stepping.
 */
const INTERP_DELAY = 0.12;
const SNAPSHOT_KEEP = 12;

export class RemoteFleet {
  constructor(scene) {
    this.scene = scene;
    this.peers = new Map();
    this._clock = 0;
  }

  get count() { return this.peers.size; }

  attach(adapter) {
    // Detach first so swapping adapters — going online, then leaving — cannot
    // leave the previous one's listeners feeding this fleet.
    this.detach();
    this._off = [
      adapter.on('join', (p) => this.add(p)),
      adapter.on('leave', (p) => this.remove(p.id)),
      adapter.on('state', (p) => this.applyState(p)),
      // The roster is authoritative, so reconcile against it. Join and leave
      // alone are not enough: a state packet in flight when someone departs
      // would otherwise resurrect them as a peer nothing ever removes again.
      adapter.on('roster', ({ players, selfId }) => this.syncRoster(players, selfId)),
    ];
    return this;
  }

  /**
   * Make the fleet match the relay's roster exactly: add anyone missing,
   * drop anyone no longer listed.
   *
   * @param {Array<{id: string, name: string, color: number}>} players
   * @param {?string} selfId excluded — we render our own drone ourselves
   */
  syncRoster(players, selfId) {
    const present = new Set();
    for (const p of players) {
      if (p.id === selfId) continue;
      present.add(p.id);
      this.add(p);
    }
    for (const id of [...this.peers.keys()]) {
      if (!present.has(id)) this.remove(id);
    }
  }

  detach() {
    if (this._off) for (const off of this._off) off();
    this._off = null;
    this.clear();
    return this;
  }

  add({ id, name, color }) {
    if (this.peers.has(id)) return this.peers.get(id);
    const model = new DroneModel(color ?? 0xffffff, { trail: true }).addTo(this.scene);
    const peer = { id, name, model, snapshots: [], gate: 0, time: 0 };
    this.peers.set(id, peer);
    return peer;
  }

  remove(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.model.dispose();
    this.peers.delete(id);
  }

  clear() {
    for (const id of [...this.peers.keys()]) this.remove(id);
  }

  applyState(packet) {
    // Deliberately does not create unknown peers. Peers come from the
    // roster, which is authoritative; creating one here means a packet that
    // was already in flight when its sender left brings them back as a
    // ghost, and nothing will ever remove them.
    const peer = this.peers.get(packet.id);
    if (!peer) return;
    peer.snapshots.push({
      t: this._clock,
      p: new THREE.Vector3().fromArray(packet.p),
      q: packet.q
        ? new THREE.Quaternion().fromArray(packet.q)
        : new THREE.Quaternion(),
    });
    if (peer.snapshots.length > SNAPSHOT_KEEP) peer.snapshots.shift();
    if (packet.gate != null) peer.gate = packet.gate;
    if (packet.time != null) peer.time = packet.time;
  }

  update(dt) {
    this._clock += dt;
    const renderAt = this._clock - INTERP_DELAY;

    for (const peer of this.peers.values()) {
      const snaps = peer.snapshots;
      if (snaps.length === 0) continue;

      // Find the pair straddling renderAt.
      let a = snaps[0];
      let b = snaps[snaps.length - 1];
      for (let i = 0; i < snaps.length - 1; i++) {
        if (snaps[i].t <= renderAt && snaps[i + 1].t >= renderAt) {
          a = snaps[i];
          b = snaps[i + 1];
          break;
        }
      }

      const span = b.t - a.t;
      const alpha = span > 1e-5 ? THREE.MathUtils.clamp((renderAt - a.t) / span, 0, 1) : 1;

      peer.model.group.position.lerpVectors(a.p, b.p, alpha);
      peer.model.group.quaternion.copy(a.q).slerp(b.q, alpha);
      // Remote props spin at a plausible constant rate — thrust isn't sent.
      for (let i = 0; i < peer.model.rotors.length; i++) {
        peer.model.rotors[i].rotation.y += peer.model.rotors[i].userData.dir * 90 * dt;
      }
    }
  }

  dispose() {
    this.detach();
  }
}

/** Build the packet the adapter would send. Kept here so the shape is one-sourced. */
export function makeStatePacket(identity, body, gate, time) {
  return {
    id: identity.id,
    name: identity.name,
    color: identity.color,
    p: [
      Math.round(body.position.x * 100) / 100,
      Math.round(body.position.y * 100) / 100,
      Math.round(body.position.z * 100) / 100,
    ],
    q: [
      Math.round(body.quaternion.x * 1000) / 1000,
      Math.round(body.quaternion.y * 1000) / 1000,
      Math.round(body.quaternion.z * 1000) / 1000,
      Math.round(body.quaternion.w * 1000) / 1000,
    ],
    gate,
    time: Math.round(time * 100) / 100,
  };
}
