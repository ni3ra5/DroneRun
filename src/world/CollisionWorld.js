import * as THREE from 'three';

/**
 * Broad + narrow phase collision for the drone against the obstacle field.
 *
 * Obstacles are oriented boxes. Broad phase is a uniform grid keyed on each
 * box's world-space AABB; narrow phase is the standard sphere-vs-OBB closest
 * point test. The drone is the only dynamic body, so this stays cheap even at
 * the 240 Hz physics rate.
 */

const CELL = 26;

export class CollisionWorld {
  /** @param {Array} structures from the track generator */
  constructor(structures = [], groundY = 0) {
    this.structures = structures;
    this.groundY = groundY;
    this.cells = new Map();

    this._local = new THREE.Vector3();
    this._clamped = new THREE.Vector3();
    this._delta = new THREE.Vector3();
    this._mat = new THREE.Matrix4();
    this._seen = new Set();
    this._contacts = [];

    for (let i = 0; i < structures.length; i++) this._insert(structures[i], i);
  }

  static key(ix, iy, iz) { return `${ix},${iy},${iz}`; }

  _worldAabb(box) {
    // Project the box's half-extents through the absolute rotation matrix.
    this._mat.makeRotationFromQuaternion(box.quaternion);
    const e = this._mat.elements;
    const h = box.halfExtents;
    const ex = Math.abs(e[0]) * h.x + Math.abs(e[4]) * h.y + Math.abs(e[8]) * h.z;
    const ey = Math.abs(e[1]) * h.x + Math.abs(e[5]) * h.y + Math.abs(e[9]) * h.z;
    const ez = Math.abs(e[2]) * h.x + Math.abs(e[6]) * h.y + Math.abs(e[10]) * h.z;
    return { ex, ey, ez };
  }

  _insert(box, index) {
    const { ex, ey, ez } = this._worldAabb(box);
    const p = box.position;
    const x0 = Math.floor((p.x - ex) / CELL), x1 = Math.floor((p.x + ex) / CELL);
    const y0 = Math.floor((p.y - ey) / CELL), y1 = Math.floor((p.y + ey) / CELL);
    const z0 = Math.floor((p.z - ez) / CELL), z1 = Math.floor((p.z + ez) / CELL);

    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        for (let iz = z0; iz <= z1; iz++) {
          const k = CollisionWorld.key(ix, iy, iz);
          let list = this.cells.get(k);
          if (!list) this.cells.set(k, (list = []));
          list.push(index);
        }
      }
    }
  }

  /**
   * @returns {Array<{normal: THREE.Vector3, depth: number, kind: string}>}
   *          contacts, normals pointing out of the obstacle
   */
  query(center, radius) {
    const contacts = this._contacts;
    contacts.length = 0;

    // Ground.
    const groundDepth = radius - (center.y - this.groundY);
    if (groundDepth > 0) {
      contacts.push({ normal: new THREE.Vector3(0, 1, 0), depth: groundDepth, kind: 'ground' });
    }

    const seen = this._seen;
    seen.clear();
    const x0 = Math.floor((center.x - radius) / CELL), x1 = Math.floor((center.x + radius) / CELL);
    const y0 = Math.floor((center.y - radius) / CELL), y1 = Math.floor((center.y + radius) / CELL);
    const z0 = Math.floor((center.z - radius) / CELL), z1 = Math.floor((center.z + radius) / CELL);

    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        for (let iz = z0; iz <= z1; iz++) {
          const list = this.cells.get(CollisionWorld.key(ix, iy, iz));
          if (!list) continue;
          for (const idx of list) {
            if (seen.has(idx)) continue;
            seen.add(idx);
            const c = this._sphereBox(center, radius, this.structures[idx]);
            if (c) contacts.push(c);
          }
        }
      }
    }
    return contacts;
  }

  _sphereBox(center, radius, box) {
    const local = this._local.copy(center).sub(box.position).applyQuaternion(box.inverseQuaternion);
    const h = box.halfExtents;

    const outside = Math.abs(local.x) > h.x || Math.abs(local.y) > h.y || Math.abs(local.z) > h.z;

    if (outside) {
      const clamped = this._clamped.set(
        THREE.MathUtils.clamp(local.x, -h.x, h.x),
        THREE.MathUtils.clamp(local.y, -h.y, h.y),
        THREE.MathUtils.clamp(local.z, -h.z, h.z),
      );
      const delta = this._delta.subVectors(local, clamped);
      const dist = delta.length();
      if (dist >= radius || dist === 0) return null;
      const normal = delta.divideScalar(dist).clone().applyQuaternion(box.quaternion);
      return { normal, depth: radius - dist, kind: box.kind };
    }

    // Centre is inside the box: escape along the nearest face.
    const gapX = h.x - Math.abs(local.x);
    const gapY = h.y - Math.abs(local.y);
    const gapZ = h.z - Math.abs(local.z);
    const n = new THREE.Vector3();
    let depth;
    if (gapX <= gapY && gapX <= gapZ) {
      n.set(Math.sign(local.x) || 1, 0, 0);
      depth = gapX + radius;
    } else if (gapY <= gapZ) {
      n.set(0, Math.sign(local.y) || 1, 0);
      depth = gapY + radius;
    } else {
      n.set(0, 0, Math.sign(local.z) || 1);
      depth = gapZ + radius;
    }
    return { normal: n.applyQuaternion(box.quaternion), depth, kind: box.kind };
  }
}
