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

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.baseFov = 62;

    this._pos = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._desiredLook = new THREE.Vector3();
    this._yawQuat = new THREE.Quaternion();
    this._tmp = new THREE.Vector3();
    this._initialised = false;
  }

  /** Snap straight to the ideal pose, e.g. after a restart. */
  reset(body) {
    this._initialised = false;
    this.update(body, 1 / 60, null);
  }

  /**
   * @param {import('../drone/DronePhysics.js').DronePhysics} body
   * @param {number} dt
   * @param {?import('../world/CollisionWorld.js').CollisionWorld} collision
   */
  update(body, dt, collision) {
    const { yaw } = body.attitude();
    this._yawQuat.setFromAxisAngle(UP, yaw);

    this._desired.copy(CHASE_OFFSET).applyQuaternion(this._yawQuat).add(body.position);

    // Lead the camera along the velocity so fast flight opens up the view
    // ahead instead of burying the horizon.
    this._desiredLook.copy(body.position)
      .addScaledVector(this._tmp.set(0, 0, -1).applyQuaternion(this._yawQuat), 4.5)
      .addScaledVector(body.velocity, 0.12);

    if (!this._initialised) {
      this._pos.copy(this._desired);
      this._look.copy(this._desiredLook);
      this._initialised = true;
    } else {
      this._pos.lerp(this._desired, 1 - Math.exp(-9 * dt));
      this._look.lerp(this._desiredLook, 1 - Math.exp(-13 * dt));
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
