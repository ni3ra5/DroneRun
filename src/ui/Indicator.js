import * as THREE from 'three';

/**
 * Off-screen indicator for the next checkpoint.
 *
 * When the gate is on screen the highlighted amber ring is the cue and this
 * stays hidden. When it isn't — behind you, above you, around a corner — a
 * chevron pins to the screen edge in its direction with the distance in
 * metres, so you always know where to point the drone.
 */

const MARGIN = 74;         // px inset from the left and bottom edges
// The top and right edges need deeper insets so the chevron never parks on
// top of another instrument: the compass tape and checkpoint counter run
// along the top, and the altitude tape down the right-hand side.
const MARGIN_TOP = 150;
const MARGIN_RIGHT = 132;

export class Indicator {
  constructor() {
    this._camSpace = new THREE.Vector3();
    this._ndc = new THREE.Vector3();
  }

  /**
   * @param {THREE.Vector3} target world position of the next gate
   * @param {THREE.Camera} camera
   * @param {{width:number, height:number}} size viewport in CSS pixels
   * @returns {{visible:boolean, x:number, y:number, angle:number, distance:number}}
   */
  compute(target, camera, size) {
    const halfW = size.width / 2;
    const halfH = size.height / 2;
    const distance = camera.position.distanceTo(target);

    // Safe rectangle in screen coordinates, inset per edge.
    const left = MARGIN;
    const right = size.width - MARGIN_RIGHT;
    const top = MARGIN_TOP;
    const bottom = size.height - MARGIN;

    // Work in camera space first: it tells us unambiguously whether the
    // target is in front of the lens, which NDC alone cannot after the
    // perspective divide flips signs behind the camera.
    const v = this._camSpace.copy(target).applyMatrix4(camera.matrixWorldInverse);

    let dirX;
    let dirY;
    let offScreen;

    if (v.z > -0.05) {
      // Behind the camera. Steer toward whichever side it sits on.
      dirX = v.x;
      dirY = -v.y;
      offScreen = true;
    } else {
      const ndc = this._ndc.copy(target).project(camera);
      const sx = ndc.x * halfW;
      const sy = -ndc.y * halfH;
      const px = halfW + sx;
      const py = halfH + sy;
      offScreen = px < left || px > right || py < top || py > bottom;
      dirX = sx;
      dirY = sy;
    }

    if (!offScreen) return { visible: false, x: 0, y: 0, angle: 0, distance };

    const len = Math.hypot(dirX, dirY);
    if (len < 1e-4) { dirX = 0; dirY = -1; }
    else { dirX /= len; dirY /= len; }

    // Push out from the centre along that direction until we meet the safe
    // rectangle. Each edge is tested separately because the insets differ.
    let t = Infinity;
    if (dirX > 1e-5) t = Math.min(t, (right - halfW) / dirX);
    else if (dirX < -1e-5) t = Math.min(t, (left - halfW) / dirX);
    if (dirY > 1e-5) t = Math.min(t, (bottom - halfH) / dirY);
    else if (dirY < -1e-5) t = Math.min(t, (top - halfH) / dirY);
    if (!Number.isFinite(t)) t = 0;

    return {
      visible: true,
      x: halfW + dirX * t,
      y: halfH + dirY * t,
      // The SVG chevron points at 12 o'clock; rotate it onto the direction.
      angle: Math.atan2(dirY, dirX) + Math.PI / 2,
      distance,
    };
  }
}
