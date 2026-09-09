import * as THREE from 'three';
import { makeRng } from '../core/rng.js';

/**
 * Collectable power-up crates floating on the racing line.
 *
 * Placement is seeded from the track, so every client on the same seed gets
 * the same pickups in the same places. They sit at points between gates
 * rather than at them, so grabbing one is a small line choice rather than
 * something you get for free by racing normally.
 *
 * Collection uses the same segment test as gates in spirit — a swept sphere
 * against the pickup's radius — so a pickup cannot be missed at speed.
 */

const RADIUS = 2.6;
const RESPAWN = 11;          // seconds, so a field can keep using the course

/**
 * Where along a leg a crate sits, as a fraction from one gate to the next.
 *
 * Deliberately near the start of the leg rather than the middle. Gates are
 * mounted mid-leg, so the midpoint *between* two gates falls on a corner —
 * and a corner is exactly where a flown path departs furthest from the
 * smoothed curve, because everybody cuts it. Crates placed there were
 * essentially uncollectable. Just after a gate the drone is still running
 * straight down the leg, so the curve and the racing line agree.
 */
const LEG_FRACTION = 0.22;

export class Pickups {
  /**
   * @param {THREE.Scene} scene
   * @param {object} track
   * @param {number} perLeg how many to scatter across the course
   */
  constructor(scene, track, perLeg = 1) {
    this.scene = scene;
    this.track = track;
    this.items = [];

    const rng = makeRng(`pickups-${track.seed}`);
    const cps = track.checkpoints;

    // One candidate per leg, nudged off the line so it reads as a grab
    // rather than something you cannot avoid — but kept inside the collection
    // radius of the line itself, so racing well is enough to get it.
    for (let i = 0; i < cps.length - 1; i++) {
      if (!rng.bool(0.78)) continue;
      const span = cps[i + 1].t - cps[i].t;
      const t = THREE.MathUtils.clamp(cps[i].t + span * LEG_FRACTION, 0.02, 0.98);

      const pos = track.curve.getPoint(t);
      const tangent = track.curve.getTangent(t).normalize();
      const lateral = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), tangent);
      if (lateral.lengthSq() < 1e-4) lateral.set(1, 0, 0);
      lateral.normalize();

      pos.addScaledVector(lateral, rng.float(-1.5, 1.5));
      pos.y += rng.float(-0.9, 0.9);
      this.items.push({ position: pos, cooldown: 0, index: this.items.length });
    }

    this._build();
  }

  _build() {
    // One instanced octahedron for every crate — a single draw call.
    const geo = new THREE.OctahedronGeometry(1, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xf2f7ff, emissive: 0x8fd8ff, emissiveIntensity: 1.4,
      roughness: 0.25, metalness: 0.5, transparent: true, opacity: 0.92,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, this.items.length));
    this.mesh.count = this.items.length;
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);

    // A translucent halo so crates are visible against a busy skyline.
    const halo = new THREE.MeshBasicMaterial({
      color: 0x8fd8ff, transparent: true, opacity: 0.14,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.halo = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 10), halo,
      Math.max(1, this.items.length));
    this.halo.count = this.items.length;
    this.halo.frustumCulled = false;
    this.scene.add(this.halo);

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._spin = 0;
    this._hidden = new THREE.Vector3(0, -10000, 0);
    this.update(0);
  }

  /** Spin and bob the crates; hidden ones are parked far below the world. */
  update(dt) {
    this._spin += dt * 1.6;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.cooldown > 0) {
        it.cooldown -= dt;
        if (it.cooldown > 0) {
          this._m.compose(this._hidden, this._q.identity(), this._s.setScalar(0.001));
          this.mesh.setMatrixAt(i, this._m);
          this.halo.setMatrixAt(i, this._m);
          continue;
        }
      }
      const bob = Math.sin(this._spin * 1.3 + i) * 0.35;
      this._q.setFromAxisAngle(new THREE.Vector3(0.2, 1, 0.1).normalize(), this._spin + i);
      this._s.setScalar(1.05);
      this._m.compose(
        new THREE.Vector3(it.position.x, it.position.y + bob, it.position.z),
        this._q, this._s,
      );
      this.mesh.setMatrixAt(i, this._m);
      this._s.setScalar(RADIUS);
      this._m.compose(
        new THREE.Vector3(it.position.x, it.position.y + bob, it.position.z),
        this._q, this._s,
      );
      this.halo.setMatrixAt(i, this._m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.halo.instanceMatrix.needsUpdate = true;
  }

  /**
   * Swept test of a racer's movement this frame against every live crate.
   * @returns {?number} index of the crate collected, or null
   */
  collect(prevPos, pos) {
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.cooldown > 0) continue;
      if (distanceToSegment(it.position, prevPos, pos) <= RADIUS) {
        it.cooldown = RESPAWN;
        return i;
      }
    }
    return null;
  }

  reset() {
    for (const it of this.items) it.cooldown = 0;
    this.update(0);
  }

  dispose() {
    for (const m of [this.mesh, this.halo]) {
      m.removeFromParent();
      m.geometry.dispose();
      m.material.dispose();
      m.dispose();
    }
  }
}

/** Shortest distance from a point to the segment a->b. */
const _ab = new THREE.Vector3();
const _ap = new THREE.Vector3();
export function distanceToSegment(point, a, b) {
  _ab.subVectors(b, a);
  const lenSq = _ab.lengthSq();
  if (lenSq < 1e-9) return point.distanceTo(a);
  _ap.subVectors(point, a);
  const t = THREE.MathUtils.clamp(_ap.dot(_ab) / lenSq, 0, 1);
  return _ap.copy(a).addScaledVector(_ab, t).distanceTo(point);
}
