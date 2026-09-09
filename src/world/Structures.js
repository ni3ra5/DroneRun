import * as THREE from 'three';

/**
 * Renders the obstacle field. Everything is drawn with two instanced meshes —
 * one for the building masses, one for their emissive light strips — so the
 * whole city is two draw calls regardless of how many structures the seed
 * produced.
 */

/**
 * Per-theme palettes. Night buildings are dark blue-greys lit mostly by their
 * own light strips; daylight ones are concrete and glass, and the strips are
 * pulled back so they read as coloured cladding rather than neon.
 */
const PALETTES = {
  night: {
    body: [0x28344a, 0x30405c, 0x394a68, 0x2b374d, 0x3a3350],
    arch: 0x28313f,
    strip: [0x35e6d0, 0x3d9bff, 0xff4d7e, 0xffb028, 0xa46bff],
    lift: 0.28,
  },
  day: {
    body: [0x9ba7b5, 0xb3bfc9, 0x8d99a7, 0xa8b3bf, 0x9aa3b3],
    arch: 0x8d97a3,
    strip: [0x1f8f84, 0x2f6ea8, 0xc03a5f, 0xc4861f, 0x6f4bb0],
    lift: 0.12,
  },
};

export class Structures {
  constructor(scene, structures, theme = 'night') {
    this.scene = scene;
    this.meshes = [];
    this.specs = structures;
    this.stripSpecs = [];
    this.theme = theme;
    if (structures.length === 0) return;

    const unit = new THREE.BoxGeometry(2, 2, 2); // scaled by half-extents

    // ── building masses ───────────────────────────────────────────────
    // NOTE: no `vertexColors: true` here, deliberately.
    //
    // `vertexColors` defines USE_COLOR, which makes the shader multiply by the
    // geometry's `color` attribute — and this geometry has none, so WebGL
    // supplies zero for the missing attribute and every instance renders
    // black. Per-instance tinting comes from `instanceColor`, which three.js
    // wires up on its own (USE_INSTANCING_COLOR) as soon as setColorAt has
    // been called. The two mechanisms are independent.
    const bodyMat = new THREE.MeshStandardMaterial({
      roughness: 0.78, metalness: 0.22,
    });
    const bodies = new THREE.InstancedMesh(unit, bodyMat, structures.length);
    bodies.castShadow = true;
    bodies.receiveShadow = true;

    const m = new THREE.Matrix4();
    const stripSpecs = this.stripSpecs;

    structures.forEach((s, i) => {
      m.compose(s.position, s.quaternion, s.halfExtents);
      bodies.setMatrixAt(i, m);
      if (s.kind === 'tower' || s.kind === 'slab') stripSpecs.push(s);
    });

    bodies.instanceMatrix.needsUpdate = true;
    scene.add(bodies);
    this.meshes.push(bodies);
    this.bodies = bodies;

    // ── emissive strips ───────────────────────────────────────────────
    if (stripSpecs.length > 0) {
      // Same as above: instanceColor only, no vertexColors flag.
      const stripMat = new THREE.MeshBasicMaterial({
        toneMapped: false, fog: true,
      });
      const strips = new THREE.InstancedMesh(unit, stripMat, stripSpecs.length);
      const offset = new THREE.Vector3();
      const scale = new THREE.Vector3();
      const pos = new THREE.Vector3();

      stripSpecs.forEach((s, i) => {
        const h = s.halfExtents;
        const isTower = s.kind === 'tower';
        // Sit the strip just proud of the +Z face in the box's own frame.
        offset.set(0, 0, h.z + 0.12).applyQuaternion(s.quaternion);
        pos.copy(s.position).add(offset);
        if (isTower) scale.set(Math.min(h.x * 0.16, 0.7), h.y * 0.84, 0.1);
        else scale.set(h.x * 0.9, 0.09, 0.1);

        m.compose(pos, s.quaternion, scale);
        strips.setMatrixAt(i, m);
      });

      strips.instanceMatrix.needsUpdate = true;
      scene.add(strips);
      this.meshes.push(strips);
      this.strips = strips;
    }

    this.setTheme(theme);
  }

  /**
   * Recolour every instance for a lighting theme. Only the instance colour
   * buffers change — geometry and transforms are untouched, so switching is
   * a couple of buffer uploads rather than a rebuild.
   *
   * @param {'day'|'night'} theme
   */
  setTheme(theme) {
    const p = PALETTES[theme] ?? PALETTES.night;
    this.theme = PALETTES[theme] ? theme : 'night';
    const color = new THREE.Color();

    if (this.bodies) {
      this.specs.forEach((s, i) => {
        const tint = s.kind === 'arch'
          ? p.arch
          : p.body[Math.floor(s.tint * p.body.length) % p.body.length];
        color.setHex(tint);
        // Taller structures read slightly lighter, which helps depth perception.
        const lift = THREE.MathUtils.clamp(s.halfExtents.y / 70, 0, 1) * p.lift;
        color.offsetHSL(0, 0, lift);
        this.bodies.setColorAt(i, color);
      });
      if (this.bodies.instanceColor) this.bodies.instanceColor.needsUpdate = true;
    }

    if (this.strips) {
      this.stripSpecs.forEach((s, i) => {
        color.setHex(p.strip[Math.floor(s.tint * p.strip.length) % p.strip.length]);
        this.strips.setColorAt(i, color);
      });
      if (this.strips.instanceColor) this.strips.instanceColor.needsUpdate = true;
    }
  }

  dispose() {
    // Both instanced meshes share the one unit box, so the geometry is
    // disposed once rather than per mesh.
    const geometries = new Set();
    for (const mesh of this.meshes) {
      mesh.removeFromParent();
      geometries.add(mesh.geometry);
      mesh.material.dispose();
      mesh.dispose();
    }
    for (const g of geometries) g.dispose();
    this.meshes.length = 0;
  }
}
