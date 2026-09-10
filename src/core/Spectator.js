import * as THREE from 'three';

/**
 * A network peer, presented as something the chase camera can follow.
 *
 * Bots carry a real `DronePhysics`, so the camera can chase them directly.
 * Network peers do not: all that arrives over the wire is position and
 * orientation, interpolated into a `THREE.Group` by RemoteFleet. This wrapper
 * supplies the rest of the interface CameraRig depends on — notably velocity,
 * which it differentiates from successive positions, because the camera leads
 * its look-at point along the velocity and would otherwise sit dead-centred
 * on a peer that is moving at 90 km/h.
 */
export class PeerView {
  /** @param {THREE.Object3D} group the peer's interpolated drone */
  constructor(group) {
    this.group = group;
    this.position = new THREE.Vector3().copy(group.position);
    this.velocity = new THREE.Vector3();
    this._prev = new THREE.Vector3().copy(group.position);
    this._euler = new THREE.Euler();
  }

  get speed() { return this.velocity.length(); }

  attitude() {
    this._euler.setFromQuaternion(this.group.quaternion, 'YXZ');
    return { pitch: this._euler.x, yaw: this._euler.y, roll: this._euler.z };
  }

  /** Call once per frame, after the fleet has interpolated. */
  update(dt) {
    this.position.copy(this.group.position);
    if (dt > 1e-5) {
      // Snapshots arrive at 20 Hz and are interpolated, so this difference is
      // already smooth; no extra filtering is needed.
      this.velocity.subVectors(this.position, this._prev).divideScalar(dt);
    }
    this._prev.copy(this.position);
    return this;
  }
}
