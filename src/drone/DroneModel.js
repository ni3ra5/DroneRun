import * as THREE from 'three';

/**
 * Visual airframe. Every player flies the identical model — only the accent
 * colour changes — so nobody gets an aerodynamic or readability advantage.
 */

const SQRT1_2 = Math.SQRT1_2;
const ARM = 0.26;

export const PLAYER_COLORS = [
  { name: 'Cyan',    hex: 0x35e6d0 },
  { name: 'Rose',    hex: 0xff4d7e },
  { name: 'Amber',   hex: 0xffb028 },
  { name: 'Violet',  hex: 0xa46bff },
  { name: 'Lime',    hex: 0x9fe339 },
  { name: 'Azure',   hex: 0x3d9bff },
  { name: 'Coral',   hex: 0xff7a45 },
  { name: 'Mint',    hex: 0x5cffb1 },
];

// Shared geometry/material — one allocation regardless of player count.
const geo = {
  body: new THREE.BoxGeometry(0.3, 0.085, 0.4),
  canopy: new THREE.SphereGeometry(0.11, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.55),
  arm: new THREE.BoxGeometry(0.042, 0.028, ARM * 1.02),
  hub: new THREE.CylinderGeometry(0.037, 0.045, 0.05, 12),
  blade: new THREE.BoxGeometry(0.235, 0.006, 0.03),
  disc: new THREE.CircleGeometry(0.125, 20),
  skid: new THREE.BoxGeometry(0.022, 0.075, 0.022),
  led: new THREE.SphereGeometry(0.021, 8, 6),
};

const mat = {
  carbon: new THREE.MeshStandardMaterial({ color: 0x1a1f28, roughness: 0.55, metalness: 0.6 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x0d1016, roughness: 0.7, metalness: 0.3 }),
  blade: new THREE.MeshStandardMaterial({
    color: 0x2a3038, roughness: 0.4, metalness: 0.5,
    transparent: true, opacity: 0.82, side: THREE.DoubleSide,
  }),
};

export class DroneModel {
  /**
   * @param {number} colorHex accent colour
   * @param {{trail?: boolean}} opts
   */
  constructor(colorHex = PLAYER_COLORS[0].hex, opts = {}) {
    this.color = new THREE.Color(colorHex);
    this.group = new THREE.Group();
    this.rotors = [];
    this._spin = [0, 0, 0, 0];

    const accent = new THREE.MeshStandardMaterial({
      color: colorHex, roughness: 0.3, metalness: 0.2,
      emissive: colorHex, emissiveIntensity: 0.45,
    });
    const glow = new THREE.MeshBasicMaterial({ color: colorHex });
    this.accentMaterial = accent;

    const body = new THREE.Mesh(geo.body, mat.carbon);
    body.castShadow = true;
    this.group.add(body);

    const canopy = new THREE.Mesh(geo.canopy, accent);
    canopy.position.set(0, 0.04, -0.06);
    canopy.castShadow = true;
    this.group.add(canopy);

    // Four arms in an X, each carrying a hub, a two-blade prop and an LED.
    for (let i = 0; i < 4; i++) {
      const sx = i === 0 || i === 1 ? 1 : -1;
      const sz = i === 1 || i === 2 ? 1 : -1;
      const px = sx * SQRT1_2 * ARM;
      const pz = sz * SQRT1_2 * ARM;

      const arm = new THREE.Mesh(geo.arm, mat.carbon);
      arm.position.set(px / 2, 0, pz / 2);
      arm.lookAt(px, 0, pz);
      arm.castShadow = true;
      this.group.add(arm);

      const hub = new THREE.Mesh(geo.hub, mat.dark);
      hub.position.set(px, 0.028, pz);
      hub.castShadow = true;
      this.group.add(hub);

      // Prop: two blades plus a translucent disc that fades in with RPM to
      // read as motion blur instead of a strobing polygon.
      const prop = new THREE.Group();
      prop.position.set(px, 0.058, pz);
      const b1 = new THREE.Mesh(geo.blade, mat.blade);
      const b2 = new THREE.Mesh(geo.blade, mat.blade);
      b2.rotation.y = Math.PI / 2;
      const disc = new THREE.Mesh(geo.disc, new THREE.MeshBasicMaterial({
        color: 0x8fa6c0, transparent: true, opacity: 0, side: THREE.DoubleSide,
        depthWrite: false,
      }));
      disc.rotation.x = -Math.PI / 2;
      prop.add(b1, b2, disc);
      prop.userData.disc = disc;
      prop.userData.dir = i === 0 || i === 2 ? 1 : -1;
      this.group.add(prop);
      this.rotors.push(prop);

      // Rear LEDs in the player colour, front ones white, so heading is
      // readable at a glance from any angle.
      const led = new THREE.Mesh(geo.led, sz > 0 ? glow : new THREE.MeshBasicMaterial({ color: 0xf2f7ff }));
      led.position.set(px, -0.03, pz);
      this.group.add(led);

      if (i < 2) {
        const skid = new THREE.Mesh(geo.skid, mat.dark);
        skid.position.set(sx * 0.1, -0.06, 0);
        this.group.add(skid);
      }
    }

    if (opts.trail !== false) this._buildTrail();
  }

  _buildTrail() {
    this.trailLength = 90;

    // Two separate buffers, deliberately.
    //
    // `_ring` is the source of truth: newest sample overwrites oldest, with
    // `_trailHead` marking the write slot. `_draw` is what the geometry
    // renders, always ordered oldest-to-newest.
    //
    // They must not be the same array. Reordering the ring in place would
    // leave `_trailHead` pointing at something other than the oldest slot,
    // so every later write would land in the wrong place and interleave old
    // and new positions — which draws the line strip out to a long-stale
    // point and back on almost every segment, producing a fan of long
    // streaks across the level.
    this._ring = new Float32Array(this.trailLength * 3);
    this._draw = new Float32Array(this.trailLength * 3);
    this._trailHead = 0;
    this._trailFilled = 0;

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this._draw, 3));
    g.setDrawRange(0, 0);
    this.trail = new THREE.Line(g, new THREE.LineBasicMaterial({
      color: this.color, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.trail.frustumCulled = false;
  }

  /** Add the airframe (and its trail) to a scene. */
  addTo(scene) {
    scene.add(this.group);
    if (this.trail) scene.add(this.trail);
    return this;
  }

  /**
   * Sync the mesh to a physics body and animate the props.
   * @param {import('./DronePhysics.js').DronePhysics} body
   */
  update(body, dt) {
    this.group.position.copy(body.position);
    this.group.quaternion.copy(body.quaternion);

    const maxThrust = body.t.maxRotorThrust;
    for (let i = 0; i < 4; i++) {
      const prop = this.rotors[i];
      // RPM scales with the square root of thrust, as with a real rotor.
      const ratio = Math.sqrt(Math.max(0, body.rotorThrust[i]) / maxThrust);
      this._spin[i] += prop.userData.dir * ratio * 165 * dt;
      prop.rotation.y = this._spin[i];
      prop.userData.disc.material.opacity = Math.min(0.3, ratio * 0.34);
    }

    if (this.trail) this._pushTrail(body.position);
  }

  _pushTrail(p) {
    const i = this._trailHead * 3;
    this._ring[i] = p.x;
    this._ring[i + 1] = p.y - 0.05;
    this._ring[i + 2] = p.z;
    this._trailHead = (this._trailHead + 1) % this.trailLength;
    this._trailFilled = Math.min(this._trailFilled + 1, this.trailLength);

    // Copy the ring out in draw order. Until the ring has filled, the oldest
    // sample is at 0; afterwards it is wherever the head now points.
    const oldest = this._trailFilled === this.trailLength ? this._trailHead : 0;
    for (let k = 0; k < this._trailFilled; k++) {
      const src = ((oldest + k) % this.trailLength) * 3;
      const dst = k * 3;
      this._draw[dst] = this._ring[src];
      this._draw[dst + 1] = this._ring[src + 1];
      this._draw[dst + 2] = this._ring[src + 2];
    }

    this.trail.geometry.getAttribute('position').needsUpdate = true;
    this.trail.geometry.setDrawRange(0, this._trailFilled);
  }

  clearTrail() {
    if (!this.trail) return;
    this._trailHead = 0;
    this._trailFilled = 0;
    this._ring.fill(0);
    this._draw.fill(0);
    this.trail.geometry.getAttribute('position').needsUpdate = true;
    this.trail.geometry.setDrawRange(0, 0);
  }

  dispose() {
    this.group.removeFromParent();
    if (this.trail) {
      this.trail.removeFromParent();
      this.trail.geometry.dispose();
      this.trail.material.dispose();
    }
    this.accentMaterial.dispose();
  }
}
