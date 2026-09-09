import * as THREE from 'three';
import { applyHit } from './PowerUps.js';
import { distanceToSegment } from './Pickups.js';

/**
 * Missiles, mines and the blast effects they leave behind.
 *
 * Missiles steer rather than snap to their target: they carry a velocity and
 * turn toward the victim at a limited rate, so a fast, evasive drone can
 * still make one miss. They expire on a fuse so nothing can chase forever.
 *
 * Everything is pooled into two instanced meshes plus a shared ring geometry,
 * so a busy race adds a handful of draw calls rather than one per projectile.
 */

const MISSILE_SPEED = 34;
const MISSILE_TURN = 3.4;        // rad/s
const MISSILE_FUSE = 5;
const MISSILE_HIT_RADIUS = 2.4;

const MINE_ARM_DELAY = 0.7;      // so you cannot mine yourself on the way past
const MINE_RADIUS = 2.6;
const MINE_LIFE = 26;

export class Projectiles {
  constructor(scene) {
    this.scene = scene;
    this.missiles = [];
    this.mines = [];
    this.blasts = [];

    this._up = new THREE.Vector3(0, 1, 0);
    this._desired = new THREE.Vector3();
    this._axis = new THREE.Vector3();
    this._prev = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();

    // Missile bodies.
    const missileGeo = new THREE.ConeGeometry(0.28, 1.5, 8);
    missileGeo.rotateX(Math.PI / 2);       // point along +Z
    this.missileMesh = new THREE.InstancedMesh(missileGeo, new THREE.MeshStandardMaterial({
      color: 0xff4d7e, emissive: 0xff4d7e, emissiveIntensity: 2.2, roughness: 0.3,
    }), 16);
    this.missileMesh.count = 0;
    this.missileMesh.frustumCulled = false;
    scene.add(this.missileMesh);

    // Mines.
    this.mineMesh = new THREE.InstancedMesh(
      new THREE.OctahedronGeometry(0.55, 0),
      new THREE.MeshStandardMaterial({
        color: 0xff2f5e, emissive: 0xff2f5e, emissiveIntensity: 1.6, roughness: 0.4,
      }), 24);
    this.mineMesh.count = 0;
    this.mineMesh.frustumCulled = false;
    scene.add(this.mineMesh);

    // Expanding shockwave rings, reused from a small pool.
    this._ringGeo = new THREE.RingGeometry(0.7, 1, 28);
    this._ringMatTemplate = new THREE.MeshBasicMaterial({
      color: 0xffd9e4, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
  }

  /**
   * @param {THREE.Vector3} from
   * @param {THREE.Vector3} dir initial heading
   * @param {object} target racer to chase: {body}
   * @param {string} ownerId so a missile cannot hit whoever fired it
   * @param {number} stun seconds of degraded control on hit
   */
  fireMissile(from, dir, target, ownerId, stun) {
    this.missiles.push({
      position: from.clone().addScaledVector(dir, 1.2),
      velocity: dir.clone().normalize().multiplyScalar(MISSILE_SPEED),
      target, ownerId, stun, fuse: MISSILE_FUSE,
    });
  }

  /** @param {THREE.Vector3} at @param {string} ownerId */
  dropMine(at, ownerId) {
    this.mines.push({ position: at.clone(), ownerId, arm: MINE_ARM_DELAY, life: MINE_LIFE });
  }

  /**
   * @param {number} dt
   * @param {Array<{id: string, body: object, effects: object, prevPos: THREE.Vector3}>} racers
   * @param {() => number} rng
   * @returns {Array<{id: string, kind: string}>} hits landed this frame
   */
  update(dt, racers, rng = Math.random) {
    const hits = [];

    // ── missiles ────────────────────────────────────────────────────────
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      m.fuse -= dt;

      if (m.target && !m.target.finished) {
        // Turn toward the target at a bounded rate rather than snapping.
        this._desired.copy(m.target.body.position).sub(m.position);
        const dist = this._desired.length();
        if (dist > 1e-3) {
          this._desired.divideScalar(dist);
          const current = m.velocity.clone().normalize();
          const dot = THREE.MathUtils.clamp(current.dot(this._desired), -1, 1);
          const angle = Math.acos(dot);
          if (angle > 1e-4) {
            const step = Math.min(angle, MISSILE_TURN * dt);
            this._axis.crossVectors(current, this._desired);
            if (this._axis.lengthSq() > 1e-8) {
              this._q.setFromAxisAngle(this._axis.normalize(), step);
              m.velocity.applyQuaternion(this._q);
            }
          }
        }
      }

      this._prev.copy(m.position);
      m.position.addScaledVector(m.velocity, dt);

      let detonated = false;
      for (const r of racers) {
        if (r.id === m.ownerId || r.finished) continue;
        if (distanceToSegment(r.body.position, this._prev, m.position) <= MISSILE_HIT_RADIUS) {
          applyHit(r, m.stun, rng);
          hits.push({ id: r.id, kind: 'MISSILE' });
          this._blast(m.position, 0xffd9e4);
          detonated = true;
          break;
        }
      }

      if (detonated || m.fuse <= 0 || m.position.y < 0) {
        if (!detonated) this._blast(m.position, 0xffd9e4);
        this.missiles.splice(i, 1);
      }
    }

    // ── mines ───────────────────────────────────────────────────────────
    for (let i = this.mines.length - 1; i >= 0; i--) {
      const mine = this.mines[i];
      mine.life -= dt;
      if (mine.arm > 0) mine.arm -= dt;

      if (mine.arm <= 0) {
        for (const r of racers) {
          if (r.finished) continue;
          if (distanceToSegment(mine.position, r.prevPos, r.body.position) <= MINE_RADIUS) {
            applyHit(r, 1.4, rng);
            hits.push({ id: r.id, kind: 'MINE' });
            this._blast(mine.position, 0xff2f5e);
            mine.life = 0;
            break;
          }
        }
      }
      if (mine.life <= 0) this.mines.splice(i, 1);
    }

    // ── blast rings ─────────────────────────────────────────────────────
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const b = this.blasts[i];
      b.age += dt;
      const k = b.age / b.life;
      if (k >= 1) {
        b.mesh.removeFromParent();
        b.mesh.material.dispose();
        this.blasts.splice(i, 1);
        continue;
      }
      b.mesh.scale.setScalar(1 + k * 13);
      b.mesh.material.opacity = 0.85 * (1 - k) ** 1.6;
      b.mesh.rotation.z += dt * 1.2;
    }

    this._syncInstances();
    return hits;
  }

  _blast(at, color) {
    const mesh = new THREE.Mesh(this._ringGeo, this._ringMatTemplate.clone());
    mesh.material.color.setHex(color);
    mesh.position.copy(at);
    // Face the ring at the camera-ish plane; billboarding it every frame is
    // not worth it for a 0.5 s effect.
    mesh.rotation.x = -Math.PI / 2;
    this.scene.add(mesh);
    this.blasts.push({ mesh, age: 0, life: 0.55 });
  }

  _syncInstances() {
    this.missileMesh.count = Math.min(this.missiles.length, 16);
    for (let i = 0; i < this.missileMesh.count; i++) {
      const m = this.missiles[i];
      this._q.setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        m.velocity.clone().normalize(),
      );
      this._m.compose(m.position, this._q, this._s.setScalar(1));
      this.missileMesh.setMatrixAt(i, this._m);
    }
    this.missileMesh.instanceMatrix.needsUpdate = true;

    this.mineMesh.count = Math.min(this.mines.length, 24);
    for (let i = 0; i < this.mineMesh.count; i++) {
      const mine = this.mines[i];
      // Armed mines sit still; unarmed ones are visibly smaller.
      const scale = mine.arm > 0 ? 0.5 : 1;
      this._q.setFromAxisAngle(this._up, mine.life * 1.5);
      this._m.compose(mine.position, this._q, this._s.setScalar(scale));
      this.mineMesh.setMatrixAt(i, this._m);
    }
    this.mineMesh.instanceMatrix.needsUpdate = true;
  }

  clear() {
    this.missiles.length = 0;
    this.mines.length = 0;
    for (const b of this.blasts) {
      b.mesh.removeFromParent();
      b.mesh.material.dispose();
    }
    this.blasts.length = 0;
    this._syncInstances();
  }

  dispose() {
    this.clear();
    for (const m of [this.missileMesh, this.mineMesh]) {
      m.removeFromParent();
      m.geometry.dispose();
      m.material.dispose();
      m.dispose();
    }
    this._ringGeo.dispose();
    this._ringMatTemplate.dispose();
  }
}
