import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BLOOM_LAYER } from '../config.js';

/**
 * Visual airframe, modelled on a folding camera drone: a tapered two-tone
 * fuselage, four booms angled out to the motors, tall rear landing legs and a
 * gimbal camera slung under the nose.
 *
 * Every player flies the identical shape — only the colour of the top shell
 * changes — so nobody gets a readability advantage. The shell is the coloured
 * part deliberately: the chase camera looks down at the drone from behind, so
 * the top surface is what you actually see, and it is what makes eight racers
 * distinguishable at distance.
 *
 * ── Draw calls ─────────────────────────────────────────────────────────────
 *
 * A detailed airframe built as one mesh per part would be ruinous with a full
 * grid: the previous flat X-frame was already 14 meshes, and eight of those
 * accounted for most of a 350-call frame. So parts are merged by material at
 * module load into four shared geometries, leaving 8 meshes per drone:
 *
 *   shell · body · dark trim · 4 spinning props · 1 merged blur disc
 *
 * The geometry is identical for every drone, so it is built once and shared;
 * only the materials are per-instance.
 */

const SQRT1_2 = Math.SQRT1_2;
const ARM = 0.26;                    // must match DronePhysics' rotor arm
const HUB = SQRT1_2 * ARM;           // rotor offset on each axis, ≈0.184

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

// ── geometry helpers ───────────────────────────────────────────────────────

/** Position/rotate/scale a geometry, returning a transformed clone. */
function placed(geo, { pos = [0, 0, 0], quat = null, euler = null, scale = null } = {}) {
  const g = geo.clone();
  const m = new THREE.Matrix4();
  const q = quat ?? (euler
    ? new THREE.Quaternion().setFromEuler(new THREE.Euler(...euler))
    : new THREE.Quaternion());
  m.compose(
    new THREE.Vector3(...pos), q,
    new THREE.Vector3(...(scale ?? [1, 1, 1])),
  );
  g.applyMatrix4(m);
  return g;
}

/**
 * A box narrowed toward its front face, giving the fuselage its wedge.
 * BoxGeometry keeps separate vertices per face, so moving the corners in and
 * recomputing normals leaves the surface faceted rather than smoothed.
 */
function taperedBox(w, h, d, frontScaleX, frontScaleY) {
  const g = new THREE.BoxGeometry(w, h, d);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i);
    const t = (z + d / 2) / d;                 // 0 at the nose, 1 at the tail
    const sx = THREE.MathUtils.lerp(frontScaleX, 1, t);
    const sy = THREE.MathUtils.lerp(frontScaleY, 1, t);
    p.setX(i, p.getX(i) * sx);
    p.setY(i, p.getY(i) * sy);
  }
  g.computeVertexNormals();
  return g;
}

/** A boom spanning two points, e.g. an arm or a landing leg. */
function boom(from, to, width, height) {
  const a = new THREE.Vector3(...from);
  const b = new THREE.Vector3(...to);
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const g = new THREE.BoxGeometry(width, height, len);
  const quat = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1), dir.clone().normalize(),
  );
  return placed(g, { pos: a.clone().addScaledVector(dir, 0.5).toArray(), quat });
}

/** Rotor positions in the X configuration the physics mixer assumes. */
const ROTOR_AT = [
  [+HUB, -HUB],   // 0 front-right
  [+HUB, +HUB],   // 1 rear-right
  [-HUB, +HUB],   // 2 rear-left
  [-HUB, -HUB],   // 3 front-left
];

// ── shared geometry, built once ────────────────────────────────────────────

function buildShell() {
  const parts = [
    // Upper shell: broad and low, inset from the lower body so the fuselage
    // reads as two-tone rather than as a coloured brick sitting on a box.
    placed(taperedBox(0.176, 0.044, 0.315, 0.5, 0.45), { pos: [0, 0.056, -0.012] }),
    // Battery pack proud of the tail.
    placed(taperedBox(0.13, 0.03, 0.115, 0.9, 0.8), { pos: [0, 0.082, 0.108] }),
  ];
  return mergeGeometries(parts, false);
}

function buildBody() {
  // Proportions are taken from the reference airframe rather than invented:
  // its body is roughly two thirds of its motor-to-motor diagonal, and about
  // 0.38 of it wide. The physics fixes that diagonal at 2 x ARM = 0.52 m, so
  // the fuselage has to be ~0.36 x 0.20 to sit right. Built smaller, the arms
  // stop reading as stubby booms and start looking like spider legs.
  const parts = [
    placed(taperedBox(0.20, 0.078, 0.36, 0.52, 0.62), { pos: [0, 0.012, 0] }),
    // A lip along the nose, which is where the reference has its sensor bar.
    placed(taperedBox(0.11, 0.016, 0.05, 0.75, 0.7), { pos: [0, 0.0, -0.19] }),
  ];

  for (let i = 0; i < 4; i++) {
    const [x, z] = ROTOR_AT[i];
    const front = z < 0;
    // Booms leave the fuselage flanks close to the motors, so they are short
    // and flat like folding arms rather than long radiating spokes.
    const rootX = Math.sign(x) * 0.088;
    const rootZ = front ? -0.125 : 0.125;
    parts.push(boom([rootX, 0.014, rootZ], [x, 0.008, z], 0.052, 0.032));

    // Motor housing; the bell on top belongs to the dark trim.
    parts.push(placed(new THREE.CylinderGeometry(0.029, 0.033, 0.036, 14),
      { pos: [x, 0.026, z] }));

    if (front) {
      // Short front feet.
      parts.push(boom([x, 0.004, z], [x * 1.02, -0.062, z * 1.01], 0.026, 0.026));
      parts.push(placed(new THREE.BoxGeometry(0.042, 0.011, 0.042),
        { pos: [x * 1.03, -0.066, z * 1.02] }));
    } else {
      // Tall rear legs, which is what the real airframe stands on.
      parts.push(boom([x, 0.004, z], [x * 1.07, -0.118, z * 1.05], 0.03, 0.03));
      parts.push(placed(new THREE.BoxGeometry(0.05, 0.012, 0.058),
        { pos: [x * 1.09, -0.123, z * 1.06] }));
    }
  }
  return mergeGeometries(parts, false);
}

function buildDark() {
  const parts = [
    // Gimbal yoke and camera body slung under the nose.
    placed(new THREE.BoxGeometry(0.042, 0.04, 0.03), { pos: [0, -0.042, -0.135] }),
    placed(new THREE.BoxGeometry(0.07, 0.058, 0.062), { pos: [0, -0.066, -0.168] }),
    // Lens, facing forward along -Z.
    placed(new THREE.CylinderGeometry(0.022, 0.025, 0.02, 16),
      { pos: [0, -0.066, -0.202], euler: [Math.PI / 2, 0, 0] }),
    // Sensor bar on the nose lip.
    placed(new THREE.BoxGeometry(0.072, 0.011, 0.008), { pos: [0, 0.004, -0.209] }),
    // Vent slots along the tail.
    placed(new THREE.BoxGeometry(0.09, 0.014, 0.008), { pos: [0, 0.03, 0.178] }),
  ];
  for (let i = 0; i < 4; i++) {
    const [x, z] = ROTOR_AT[i];
    parts.push(placed(new THREE.CylinderGeometry(0.032, 0.03, 0.019, 14),
      { pos: [x, 0.05, z] }));
  }
  return mergeGeometries(parts, false);
}

/**
 * One propeller: two broad blades with lighter tips.
 *
 * Tip colour is baked into a vertex-colour attribute so the whole prop stays
 * a single material. Note that `vertexColors: true` requires the geometry to
 * actually carry a `color` attribute -- without one, WebGL supplies zero for
 * the missing attribute and the mesh renders black.
 */
function buildProp() {
  const blade = () => {
    const g = new THREE.BoxGeometry(0.112, 0.006, 0.042);
    g.translate(0.066, 0, 0);
    return g;
  };
  const tip = () => {
    const g = new THREE.BoxGeometry(0.024, 0.006, 0.036);
    g.translate(0.133, 0, 0);
    return g;
  };
  const parts = [
    placed(new THREE.CylinderGeometry(0.015, 0.018, 0.014, 12), { pos: [0, 0, 0] }),
    blade(), tip(),
    placed(blade(), { euler: [0, Math.PI, 0] }),
    placed(tip(), { euler: [0, Math.PI, 0] }),
  ];
  const tinted = [0x24282e, 0x24282e, 0xff7a3d, 0x24282e, 0xff7a3d];

  parts.forEach((g, i) => {
    const c = new THREE.Color(tinted[i]);
    const count = g.attributes.position.count;
    const colors = new Float32Array(count * 3);
    for (let v = 0; v < count; v++) {
      colors[v * 3] = c.r;
      colors[v * 3 + 1] = c.g;
      colors[v * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  });
  return mergeGeometries(parts, false);
}

/** All four blur discs in one geometry: their opacity animates together. */
function buildDiscs() {
  const parts = ROTOR_AT.map(([x, z]) => placed(
    new THREE.CircleGeometry(0.15, 22),
    { pos: [x, 0.066, z], euler: [-Math.PI / 2, 0, 0] },
  ));
  return mergeGeometries(parts, false);
}

const GEO = {
  shell: buildShell(),
  body: buildBody(),
  dark: buildDark(),
  prop: buildProp(),
  discs: buildDiscs(),
};

// Shared materials for the parts that never change colour.
const MAT = {
  body: new THREE.MeshStandardMaterial({ color: 0xd2d6dc, roughness: 0.52, metalness: 0.18 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x1d2025, roughness: 0.45, metalness: 0.5 }),
  prop: new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.4, metalness: 0.35,
    transparent: true, opacity: 0.9, side: THREE.DoubleSide,
  }),
};

export class DroneModel {
  /**
   * @param {number} colorHex the player's identifying colour
   * @param {{trail?: boolean}} opts
   */
  constructor(colorHex = PLAYER_COLORS[0].hex, opts = {}) {
    this.color = new THREE.Color(colorHex);
    this.group = new THREE.Group();
    this.rotors = [];
    this._spin = [0, 0, 0, 0];

    // The one per-drone material: the top shell carries the player's colour
    // and glows. Metalness is kept low — a metallic surface takes its colour
    // from reflections, which would mute the emissive underneath it.
    this.accentMaterial = new THREE.MeshStandardMaterial({
      color: colorHex, roughness: 0.4, metalness: 0.05,
      emissive: colorHex, emissiveIntensity: 0.9,
    });

    const shell = new THREE.Mesh(GEO.shell, this.accentMaterial);
    const body = new THREE.Mesh(GEO.body, MAT.body);
    const dark = new THREE.Mesh(GEO.dark, MAT.dark);
    shell.castShadow = true;
    body.castShadow = true;
    // The shell is the only thing in the game that glows, so it is the only
    // thing placed on the bloom layer. `enable` rather than `set`, so it
    // still renders in the ordinary pass as well.
    shell.layers.enable(BLOOM_LAYER);
    this.shell = shell;
    this.group.add(shell, body, dark);

    for (let i = 0; i < 4; i++) {
      const [x, z] = ROTOR_AT[i];
      const prop = new THREE.Mesh(GEO.prop, MAT.prop);
      prop.position.set(x, 0.066, z);
      // Alternating spin, matching the physics mixer's rotor directions.
      prop.userData.dir = i === 0 || i === 2 ? 1 : -1;
      this.group.add(prop);
      this.rotors.push(prop);
    }

    // Motion blur across all four rotors, driven by mean thrust.
    this._discMaterial = new THREE.MeshBasicMaterial({
      color: 0x9fb3c8, transparent: true, opacity: 0,
      side: THREE.DoubleSide, depthWrite: false,
    });
    this._discs = new THREE.Mesh(GEO.discs, this._discMaterial);
    this.group.add(this._discs);

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
    let mean = 0;
    for (let i = 0; i < 4; i++) {
      const prop = this.rotors[i];
      // RPM scales with the square root of thrust, as with a real rotor.
      const ratio = Math.sqrt(Math.max(0, body.rotorThrust[i]) / maxThrust);
      mean += ratio;
      this._spin[i] += prop.userData.dir * ratio * 165 * dt;
      prop.rotation.y = this._spin[i];
    }
    this._discMaterial.opacity = Math.min(0.28, (mean / 4) * 0.32);

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
    // GEO and MAT are module-scoped and shared across every drone, so they
    // are deliberately not disposed here. Only per-drone material is.
    this.group.removeFromParent();
    if (this.trail) {
      this.trail.removeFromParent();
      this.trail.geometry.dispose();
      this.trail.material.dispose();
    }
    this.accentMaterial.dispose();
    this._discMaterial.dispose();
  }
}
