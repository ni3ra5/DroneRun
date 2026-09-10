import * as THREE from 'three';

/**
 * Chase camera.
 *
 * It follows the drone's heading but deliberately ignores its pitch and roll:
 * inheriting bank makes a quadcopter almost unflyable in third person, since
 * the horizon tips every time you translate.
 *
 * All smoothing is framerate-independent: `1 - exp(-rate·dt)` gives the same
 * response at 30 fps and 144 fps, unlike a raw `lerp(a, b, 0.1)`.
 */

const CHASE_OFFSET = new THREE.Vector3(0, 1.4, 4.7);
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Response rates, per subject.
 *
 * Flying your own drone, the camera should feel welded on — you are the one
 * commanding the heading, so tracking it immediately reads as control rather
 * than as jitter. Spectating, the opposite: you did not ask for any of those
 * inputs, and two things make a followed craft's pose noisy in a way your own
 * never is. A bot corners with hard, oscillating yaw commands; and a network
 * peer's transform is interpolated between 20 Hz snapshots, so its
 * differentiated velocity is a step function. Following either one tightly
 * puts that noise straight into the frame, so the spectate camera trades
 * responsiveness for a steady horizon — including damping the subject's
 * heading itself, which the chase offset is built from.
 */
const RESPONSE = {
  own:      { pos: 9,   look: 13,  yaw: null, lead: 0.12 },
  spectate: { pos: 4.5, look: 6.5, yaw: 3.4,  lead: 0.05 },
};

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.baseFov = 62;
    this._yaw = 0;

    this._pos = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._desiredLook = new THREE.Vector3();
    this._yawQuat = new THREE.Quaternion();
    this._tmp = new THREE.Vector3();
    this._initialised = false;
  }

  /**
   * Snap straight to the ideal pose, e.g. after a restart or when cutting to
   * another pilot's camera.
   */
  reset(body, opts = {}) {
    this._initialised = false;
    this.update(body, 1 / 60, null, opts);
  }

  /**
   * Follow an angle the short way round.
   *
   * Damping raw yaw would send the camera the long way round every time the
   * subject crosses ±π, which on a course that doubles back on itself is
   * often — so the error is wrapped into (-π, π] before it is applied.
   */
  _damp(current, target, rate, dt) {
    let d = target - current;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return current + d * (1 - Math.exp(-rate * dt));
  }

  /**
   * @param {import('../drone/DronePhysics.js').DronePhysics} body
   * @param {number} dt
   * @param {?import('../world/CollisionWorld.js').CollisionWorld} collision
   * @param {{spectate?: boolean}} opts following someone else's drone rather
   *        than the player's own, which needs a gentler response — see
   *        RESPONSE above
   */
  update(body, dt, collision, opts = {}) {
    const k = opts.spectate ? RESPONSE.spectate : RESPONSE.own;
    const { yaw } = body.attitude();

    // Own drone: take the heading raw, so the camera is welded to it.
    // Spectating: damp it, so a bot's cornering does not swing the camera
    // around the craft.
    if (!this._initialised || k.yaw == null) this._yaw = yaw;
    else this._yaw = this._damp(this._yaw, yaw, k.yaw, dt);
    this._yawQuat.setFromAxisAngle(UP, this._yaw);

    this._desired.copy(CHASE_OFFSET).applyQuaternion(this._yawQuat).add(body.position);

    // Lead the camera along the velocity so fast flight opens up the view
    // ahead instead of burying the horizon.
    this._desiredLook.copy(body.position)
      .addScaledVector(this._tmp.set(0, 0, -1).applyQuaternion(this._yawQuat), 4.5)
      .addScaledVector(body.velocity, k.lead);

    if (!this._initialised) {
      this._pos.copy(this._desired);
      this._look.copy(this._desiredLook);
      this._initialised = true;
    } else {
      this._pos.lerp(this._desired, 1 - Math.exp(-k.pos * dt));
      this._look.lerp(this._desiredLook, 1 - Math.exp(-k.look * dt));
    }

    if (collision) this._avoidGeometry(collision, body.position);

    this.camera.position.copy(this._pos);
    this.camera.up.copy(UP);
    this.camera.lookAt(this._look);

    const target = this.baseFov + Math.min(16, body.speed * 0.55);
    this.camera.fov += (target - this.camera.fov) * (1 - Math.exp(-5 * dt));
    this.camera.updateProjectionMatrix();
  }

  /** Keep the camera out of walls, and never below the ground. */
  _avoidGeometry(collision, dronePos) {
    const contacts = collision.query(this._pos, 0.7);
    for (const c of contacts) this._pos.addScaledVector(c.normal, c.depth);
    if (this._pos.y < 0.6) this._pos.y = 0.6;

    // If pushing out shoved the camera absurdly far, fall back to close-in.
    if (this._pos.distanceToSquared(dronePos) > 14 * 14) this._pos.copy(this._desired);
  }
}
