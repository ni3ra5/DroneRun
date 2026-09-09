import * as THREE from 'three';

/**
 * Speed streaks around the drone while boosting.
 *
 * A tube of short line segments surrounding the flight axis, streaming from
 * ahead of the drone to behind it. Their speed and length scale with the
 * drone's actual velocity, so the effect reads as air rushing past rather
 * than as an animation playing at a fixed rate.
 *
 * Built as one LineSegments with a dynamic position buffer — 72 streaks is
 * 144 vertices and a single draw call, so this is far cheaper than a sprite
 * particle system and needs no texture.
 */

const COUNT = 72;
const FRONT = 15;      // spawn this far ahead of the drone, in metres
const BACK = 11;       // recycle once this far behind
const TUBE_MIN = 0.7;  // streaks avoid the very centre, where the drone is
const TUBE_MAX = 2.9;

export class BoostEffect {
  constructor(scene, color = 0xbfefff) {
    this.positions = new Float32Array(COUNT * 6);
    this.radius = new Float32Array(COUNT);
    this.angle = new Float32Array(COUNT);
    this.along = new Float32Array(COUNT);
    this.lenScale = new Float32Array(COUNT);

    for (let i = 0; i < COUNT; i++) this._respawn(i, true);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.mesh = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    this.mesh.frustumCulled = false;   // the buffer is rebuilt in world space
    this.mesh.visible = false;
    scene.add(this.mesh);

    this._fade = 0;
    this._dir = new THREE.Vector3();
    this._u = new THREE.Vector3();
    this._v = new THREE.Vector3();
    this._helper = new THREE.Vector3();
    this._base = new THREE.Vector3();
  }

  _respawn(i, initial = false) {
    this.radius[i] = TUBE_MIN + Math.random() * (TUBE_MAX - TUBE_MIN);
    this.angle[i] = Math.random() * Math.PI * 2;
    // On first fill, scatter along the whole tube so it does not all arrive
    // at once; afterwards, always re-enter from the front.
    this.along[i] = initial ? -BACK + Math.random() * (FRONT + BACK) : FRONT;
    this.lenScale[i] = 0.6 + Math.random() * 0.9;
  }

  /**
   * @param {number} dt
   * @param {import('./DronePhysics.js').DronePhysics} body
   * @param {boolean} active is boost firing this frame?
   */
  update(dt, body, active) {
    // Ramp in fast, out a little slower, so a tapped boost still registers
    // and a released one does not pop.
    const target = active ? 1 : 0;
    const rate = active ? 14 : 6;
    this._fade += (target - this._fade) * (1 - Math.exp(-rate * dt));
    if (this._fade < 0.004) {
      this._fade = 0;
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    this.mesh.material.opacity = this._fade * 0.5;

    // Align the tube with travel, falling back to the nose when nearly still.
    const speed = body.speed;
    if (speed > 0.8) this._dir.copy(body.velocity).divideScalar(speed);
    else this._dir.copy(body.forward);

    // Any two vectors perpendicular to the axis will do; pick a helper that
    // is not parallel to it so the cross product stays well conditioned.
    this._helper.set(0, 1, 0);
    if (Math.abs(this._dir.y) > 0.9) this._helper.set(1, 0, 0);
    this._u.crossVectors(this._dir, this._helper).normalize();
    this._v.crossVectors(this._dir, this._u).normalize();

    const drift = speed * 1.5 + 9;
    const p = body.position;
    const pos = this.positions;

    for (let i = 0; i < COUNT; i++) {
      this.along[i] -= drift * dt;
      if (this.along[i] < -BACK) this._respawn(i);

      const r = this.radius[i];
      const c = Math.cos(this.angle[i]) * r;
      const s = Math.sin(this.angle[i]) * r;

      this._base.copy(p)
        .addScaledVector(this._dir, this.along[i])
        .addScaledVector(this._u, c)
        .addScaledVector(this._v, s);

      const len = (0.9 + speed * 0.13) * this.lenScale[i];
      const o = i * 6;
      pos[o] = this._base.x;
      pos[o + 1] = this._base.y;
      pos[o + 2] = this._base.z;
      pos[o + 3] = this._base.x - this._dir.x * len;
      pos[o + 4] = this._base.y - this._dir.y * len;
      pos[o + 5] = this._base.z - this._dir.z * len;
    }

    this.mesh.geometry.getAttribute('position').needsUpdate = true;
  }

  /** 0..1, for driving a matching screen-space effect. */
  get intensity() { return this._fade; }

  reset() {
    this._fade = 0;
    this.mesh.visible = false;
    for (let i = 0; i < COUNT; i++) this._respawn(i, true);
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
