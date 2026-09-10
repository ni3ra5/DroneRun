import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);

/**
 * The starting grid.
 *
 * Slots are `[lateral, vertical]` metres in the start heading's own frame, so
 * they fan the field out across the run-up regardless of which way the course
 * sets off. The course guarantees 8.5 m of clear air around the racing line,
 * so every slot here stays comfortably inside it.
 *
 * There are exactly as many slots as there are palette colours (and as the
 * relay's room capacity), because online each player's slot *is* their colour
 * index — the relay hands those out uniquely, so no two drones can share a
 * square without the server having made a mistake. Solo, the player takes
 * slot 0 and the bots take the rest, which is why slot 0 is the centre of the
 * grid rather than an edge of it.
 */
export const START_SLOTS = [
  [0, 0],
  [-2.6, 0], [2.6, 0],
  [-5.2, 0], [5.2, 0],
  [-1.3, 2.8], [1.3, 2.8],
  [0, -2.6],
];

/** @param {number} index @returns {[number, number]} */
export function startSlot(index) {
  const n = START_SLOTS.length;
  const i = Number.isInteger(index) ? ((index % n) + n) % n : 0;
  return START_SLOTS[i];
}

const _right = new THREE.Vector3();

/**
 * World position for a grid slot.
 * @param {{position: THREE.Vector3, yaw: number}} start the track's start
 * @param {number} index slot index
 * @param {THREE.Vector3} [out]
 */
export function gridPosition(start, index, out = new THREE.Vector3()) {
  const [lateral, vertical] = startSlot(index);
  _right.set(1, 0, 0).applyAxisAngle(UP, start.yaw);
  out.copy(start.position).addScaledVector(_right, lateral);
  out.y += vertical;
  return out;
}
