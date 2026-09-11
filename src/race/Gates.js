import * as THREE from 'three';

/**
 * Checkpoint gate visuals plus the racing-line guide.
 *
 * The gate you have to fly through next is the single most important thing on
 * screen, so it gets three redundant cues: it is full amber, it pulses, and a
 * cone on its axis shows which way through it counts.
 *
 * The one after it is green: a different signal, not a weaker version of the
 * same one. That matters most at speed — by the time the amber ring fills the
 * screen it is too late to plan the line into it, so you need to have already
 * found the one behind it. Picking it out of a field of identical teal rings
 * took a deliberate look, and a paler amber invited the opposite mistake of
 * reading two rings as both being "the target". Green cannot be confused with
 * amber at a glance, so it answers "and then that one" without ever competing
 * to be "this one".
 */

const COL_DONE = 0x21405c;
const COL_NEXT = 0xffc247;
const COL_SOON = 0x54de62;
const COL_AHEAD = 0x1f7d86;
const FORWARD_Z = new THREE.Vector3(0, 0, 1);

/**
 * Gate geometry is shared and unit-sized, scaled per gate by its radius.
 * Allocating a torus and a disc per gate instead would mean 30-odd
 * geometries per track that all have to be disposed on regeneration — and
 * missing any of them leaks GPU memory every time a new track is generated.
 * Module scope keeps them alive for the app's lifetime, like DroneModel's.
 */
const GATE_GEO = {
  // Unit radius, so tube thickness scales with the gate — a 5.6 m gate gets a
  // slightly chunkier ring than a 4.2 m one, which reads fine.
  ring: new THREE.TorusGeometry(1, 0.048, 10, 40),
  film: new THREE.CircleGeometry(1, 32),
  cone: new THREE.ConeGeometry(0.55, 1.7, 12),
};

function makeLabel(text) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.font = 'bold 74px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, size / 2, size / 2 + 4);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, opacity: 0.9,
  }));
  sprite.scale.setScalar(2.6);
  return sprite;
}

export class Gates {
  constructor(scene, track) {
    this.scene = scene;
    this.track = track;
    this.gates = [];
    this._t = 0;

    track.checkpoints.forEach((cp) => {
      const group = new THREE.Group();
      group.position.copy(cp.position);
      group.quaternion.setFromUnitVectors(FORWARD_Z, cp.normal);

      // Ring. Torus normal is +Z, which we've just aligned to the gate axis,
      // so the aperture faces along the direction of travel.
      const ringMat = new THREE.MeshStandardMaterial({
        color: COL_AHEAD, emissive: COL_AHEAD, emissiveIntensity: 0.9,
        roughness: 0.35, metalness: 0.4,
      });
      const ring = new THREE.Mesh(GATE_GEO.ring, ringMat);
      ring.scale.setScalar(cp.radius);
      ring.castShadow = true;
      group.add(ring);

      // A faint disc across the aperture makes the gate readable head-on
      // when the ring itself is nearly edge-on.
      const filmMat = new THREE.MeshBasicMaterial({
        color: COL_AHEAD, transparent: true, opacity: 0.055,
        side: THREE.DoubleSide, depthWrite: false,
      });
      const film = new THREE.Mesh(GATE_GEO.film, filmMat);
      film.scale.setScalar(cp.radius);
      group.add(film);

      // Direction cone, sitting just past the gate on its axis.
      const coneMat = new THREE.MeshBasicMaterial({ color: COL_AHEAD, transparent: true, opacity: 0.7 });
      const cone = new THREE.Mesh(GATE_GEO.cone, coneMat);
      cone.position.set(0, 0, 1.5);
      cone.rotation.x = Math.PI / 2;   // cone +Y -> group +Z
      group.add(cone);

      // The label is deliberately NOT a child of `group`. The group is
      // oriented with setFromUnitVectors, which is free to choose any
      // perpendicular axis when the gate normal is antiparallel to +Z — so
      // the group's local "up" is not dependable, and a label parented to it
      // flips underneath the ring on roughly half the gates. The ring and
      // cone only care about the Z axis, so they are unaffected; the label
      // just gets placed in world space instead. Sprites always face the
      // camera, so it needs no orientation of its own.
      const label = makeLabel(String(cp.index + 1));
      label.position.copy(cp.position).setY(cp.position.y + cp.radius + 1.7);
      scene.add(label);

      scene.add(group);
      this.gates.push({ group, ring, ringMat, filmMat, coneMat, label, cp });
    });

    this._scrambled = false;
    this._buildRaceLine();
    this.setNext(0);
  }

  /** Faint line through the whole course, plus a bright active leg. */
  _buildRaceLine() {
    const pts = this.track.curve.getPoints(700);
    const full = new THREE.BufferGeometry().setFromPoints(pts);
    this.fullLine = new THREE.Line(full, new THREE.LineBasicMaterial({
      color: 0x2e5f7a, transparent: true, opacity: 0.35,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.fullLine.frustumCulled = false;
    this.scene.add(this.fullLine);

    this.legPositions = new Float32Array(64 * 3);
    const legGeo = new THREE.BufferGeometry();
    legGeo.setAttribute('position', new THREE.BufferAttribute(this.legPositions, 3));
    this.legLine = new THREE.Line(legGeo, new THREE.LineBasicMaterial({
      color: COL_NEXT, transparent: true, opacity: 0.75,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.legLine.frustumCulled = false;
    this.scene.add(this.legLine);
  }

  /**
   * Highlight the stretch of racing line running into gate `index`.
   * Each checkpoint carries the curve parameter it was sampled at, so the
   * active leg is simply the span between the previous gate and this one.
   */
  _updateLeg(index) {
    const cps = this.track.checkpoints;
    if (index < 0 || index >= cps.length) {
      this.legLine.visible = false;
      return;
    }
    this.legLine.visible = true;
    const t0 = index === 0 ? 0 : cps[index - 1].t;
    const t1 = cps[index].t;
    const segs = 63;
    const v = new THREE.Vector3();
    for (let i = 0; i <= segs; i++) {
      this.track.curve.getPoint(t0 + ((t1 - t0) * i) / segs, v);
      this.legPositions[i * 3] = v.x;
      this.legPositions[i * 3 + 1] = v.y;
      this.legPositions[i * 3 + 2] = v.z;
    }
    this.legLine.geometry.getAttribute('position').needsUpdate = true;
    this.legLine.geometry.setDrawRange(0, segs + 1);
    this.legLine.geometry.computeBoundingSphere();
  }

  /** Per-state appearance, so the tiers are defined in one place. */
  static STATES = {
    done:  { col: COL_DONE,  emissive: 0.25, film: 0.02,  cone: 0.15, label: 0.25 },
    next:  { col: COL_NEXT,  emissive: 2.1,  film: 0.12,  cone: 0.9,  label: 1 },
    soon:  { col: COL_SOON,  emissive: 1.15, film: 0.085, cone: 0.65, label: 0.8 },
    ahead: { col: COL_AHEAD, emissive: 0.8,  film: 0.055, cone: 0.5,  label: 0.6 },
  };

  /** Recolour gates around the new target. */
  setNext(index) {
    this.nextIndex = index;
    this.gates.forEach((g, i) => {
      const key = i < index ? 'done'
        : i === index ? 'next'
        : i === index + 1 ? 'soon'
        : 'ahead';
      const s = Gates.STATES[key];

      g.ringMat.color.setHex(s.col);
      g.ringMat.emissive.setHex(s.col);
      g.ringMat.emissiveIntensity = s.emissive;
      g.filmMat.color.setHex(s.col);
      g.filmMat.opacity = s.film;
      g.coneMat.color.setHex(s.col);
      g.coneMat.opacity = s.cone;
      g.label.material.opacity = s.label;

      // Only the next gate and its successor need to be legible; dimming the
      // rest keeps a 16-gate course from turning into visual soup.
      const dist = i - index;
      // The scrambled target is hidden outright; everything else is culled
      // by distance so a 16-gate course does not become visual soup.
      const shown = dist >= -1 && dist <= 4
        && !(this._scrambled && i === index);
      g.group.visible = shown;
      g.label.visible = shown;
    });
    this._updateLeg(index);
    if (this._scrambled) this.legLine.visible = false;
  }

  /**
   * Hide every cue for the next gate. Cheap, because the highlight already
   * lives in one place — but on a course that doubles back on itself, losing
   * the amber ring is genuinely disorienting.
   *
   * Re-applies through setNext rather than poking meshes directly, so the
   * flag survives the target advancing to the next gate while it is active.
   */
  setScrambled(scrambled) {
    if (scrambled === this._scrambled) return;
    this._scrambled = scrambled;
    this.setNext(this.nextIndex);
  }

  update(dt) {
    if (this._scrambled) return;
    this._t += dt;
    const g = this.gates[this.nextIndex];
    if (!g) return;
    const pulse = 1 + Math.sin(this._t * 4.2) * 0.045;
    g.ring.scale.setScalar(g.cp.radius * pulse);
    g.ringMat.emissiveIntensity = 1.7 + Math.sin(this._t * 4.2) * 0.55;
  }

  dispose() {
    // GATE_GEO is module-scoped and shared across every track, so it is
    // deliberately not disposed here. Everything allocated per gate is.
    for (const g of this.gates) {
      g.group.removeFromParent();
      g.label.removeFromParent();
      g.ringMat.dispose();
      g.filmMat.dispose();
      g.coneMat.dispose();
      // Guarded rather than assumed: a dispose path should not throw if
      // something upstream has swapped a material out.
      g.label.material?.map?.dispose();
      g.label.material?.dispose();
    }
    this.gates.length = 0;
    for (const line of [this.fullLine, this.legLine]) {
      line.removeFromParent();
      line.geometry.dispose();
      line.material.dispose();
    }
  }
}
