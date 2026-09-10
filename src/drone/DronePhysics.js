import * as THREE from 'three';

/**
 * Quadcopter flight model.
 *
 * This is a real rigid-body simulation rather than a kinematic "arcade" mover:
 *
 *   1. Four rotors each produce a thrust along the body's +Y axis. Their
 *      offsets from the centre of mass turn thrust differences into pitch and
 *      roll torque; their alternating spin directions turn them into yaw
 *      torque via reaction drag.
 *   2. Motors have first-order spool-up lag, so commands are never instant.
 *   3. A cascaded controller sits on top, exactly like a real flight
 *      controller in "angle"/self-levelling mode:
 *        outer loop  — stick input becomes a target attitude + climb rate
 *        inner loop  — quaternion PD drives attitude error to zero
 *        mixer       — desired thrust + torque is distributed to four rotors
 *   4. Rigid-body integration uses the full Euler equation, including the
 *      ω × Iω gyroscopic term, so fast yaw genuinely couples into pitch/roll.
 *
 * Body axes follow three.js convention: +X right, +Y up, −Z forward.
 */

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const SQRT1_2 = Math.SQRT1_2;

export const TUNING = {
  mass: 1.15,                 // kg
  gravity: 9.81,              // m/s²
  arm: 0.26,                  // m, centre to rotor hub
  inertia: [0.021, 0.036, 0.021], // kg·m² about body X (pitch), Y (yaw), Z (roll)

  maxRotorThrust: 8.4,        // N each -> thrust-to-weight ≈ 3.0
  motorTau: 0.045,            // s, spool-up time constant
  yawTorqueCoeff: 0.055,      // N·m of reaction torque per N of thrust

  // Outer loop authority.
  maxTilt: THREE.MathUtils.degToRad(38),
  // Boost multipliers. Tilt and thrust have to rise together: leaning harder
  // is what produces the extra horizontal acceleration, and holding altitude
  // at a steeper lean costs more thrust (mg / cos θ). Raising tilt alone
  // would just make the drone sink while it accelerated.
  // Boost widens the envelope: 38° -> 63° of lean roughly doubles both
  // acceleration and top speed (21 -> 47 km/h at one second, 57 -> 120 km/h
  // flat out), and the thrust multiplier keeps it able to hold altitude there.
  boostTilt: 1.65,
  boostThrust: 2.3,           // enough headroom to hold height at that lean
  maxYawRate: 2.6,            // rad/s
  maxClimbRate: 6.5,          // m/s
  climbKp: 3.2,               // (m/s²) per (m/s) of climb-rate error
  climbKi: 2.4,               // integral term — see the note in step()
  // Anti-windup bound on the vertical integrator. This, not thrust, is what
  // limits whether the craft can hold altitude at full boost lean: the
  // controller can only ask for g + climbKi * climbIClamp of vertical
  // acceleration, so raising maxRotorThrust alone changes nothing at all.
  climbIClamp: 9,

  // Inner loop: gains are in angular-acceleration terms (rad/s² per rad).
  // ωn ≈ 10.5 rad/s, ζ ≈ 0.76 — snappy but without overshoot ringing.
  attitudeKp: 110,
  attitudeKd: 16,

  // Aerodynamics. Quadratic drag is per body axis: a quad has more drag
  // across the rotor disc than along its flight direction.
  //
  // The body-Y figure is deliberately moderate. Because drag is evaluated in
  // the body frame, a steep lean puts a large slice of *horizontal* airspeed
  // onto this axis — at 55° and 24 m/s that is ~20 m/s on body-Y — so an
  // aggressive coefficient here does not model a diving drone, it models a
  // craft that cannot hold altitude while accelerating. Descent rate is
  // regulated by the climb controller, not by this term.
  dragQuad: [0.045, 0.06, 0.032],
  dragLinear: 0.16,
  angularDrag: 0.035,

  // Collision.
  radius: 0.36,               // m, collision sphere
  restitution: 0.28,
  friction: 0.45,
  spinKick: 0.55,             // how much a scrape tumbles the airframe
};

/**
 * Rotor layout, X configuration, in body space (y is always 0).
 * Index order and spin direction alternate so the mixer below stays simple:
 *   0 front-right (CW)   1 rear-right (CCW)   2 rear-left (CW)   3 front-left (CCW)
 */
const ROTORS = [
  { x: +SQRT1_2, z: -SQRT1_2, spin: +1 },
  { x: +SQRT1_2, z: +SQRT1_2, spin: -1 },
  { x: -SQRT1_2, z: +SQRT1_2, spin: +1 },
  { x: -SQRT1_2, z: -SQRT1_2, spin: -1 },
];

/**
 * The integration step, and the cap on how many of them one frame may run.
 *
 * These live with the physics rather than with any one caller because they
 * are a property of the integrator, not of the game loop: the attitude
 * controller's gains (attitudeKp ~110) are only stable at a step this small,
 * and anything that advances a body — the player, a bot, a headless test —
 * has to use the same one or the craft rings instead of settling.
 */
export const FIXED_DT = 1 / 240;
export const MAX_SUBSTEPS = 30;

/**
 * Advance a body to `dt` in fixed steps, carrying the remainder.
 *
 * @param {DronePhysics} body
 * @param {{accum: number}} clock caller-owned remainder, so each body keeps
 *        its own phase rather than sharing a global one
 * @param {number} dt frame delta, seconds
 * @param {object} cmd control command, held constant across the substeps
 * @param {?{query: Function}} collision
 * @returns {number} substeps actually run
 */
export function stepFixed(body, clock, dt, cmd, collision) {
  clock.accum += dt;
  let steps = 0;
  while (clock.accum >= FIXED_DT && steps < MAX_SUBSTEPS) {
    body.step(FIXED_DT, cmd, collision);
    clock.accum -= FIXED_DT;
    steps++;
  }
  // A backgrounded tab or a stall can hand us a delta worth hundreds of
  // steps. Drop the backlog rather than spending the next few seconds
  // catching up in slow motion.
  if (steps === MAX_SUBSTEPS) clock.accum = 0;
  return steps;
}

export class DronePhysics {
  constructor(tuning = {}) {
    this.t = { ...TUNING, ...tuning };

    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.omega = new THREE.Vector3();       // body-frame angular velocity
    this.rotorThrust = [0, 0, 0, 0];        // actual (post-lag) thrust, N
    this._vertI = 0;                        // vertical-hold integrator

    /**
     * External modifiers, owned by the power-up system (race/PowerUps.js).
     * All default to no-ops, so nothing here changes unless something is
     * deliberately applied.
     *
     * `rotorScale` scales what each rotor actually *delivers*, not its
     * ceiling. That distinction matters: capping a rotor's maximum does
     * nothing at all while the controller still has headroom to command
     * more from it, and then flips the airframe outright the moment the cap
     * drops below what hovering needs — a cliff, not a dial. Scaling the
     * delivered thrust instead gives a proportional disturbance the attitude
     * controller must genuinely fight.
     */
    this.mods = {
      rotorScale: [1, 1, 1, 1],
      dragScale: 1,
      tiltScale: 1,
      authority: 1,        // scales the attitude PD gains
    };

    this.targetYaw = 0;                     // heading the controller holds
    this.lastImpactSpeed = 0;
    this.impacts = 0;
    this.grounded = false;

    // Scratch objects — physics runs at 240 Hz, so we never allocate in-step.
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._force = new THREE.Vector3();
    this._torque = new THREE.Vector3();
    this._vUp = new THREE.Vector3();
    this._q1 = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
  }

  reset(position, yaw = 0) {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.omega.set(0, 0, 0);
    this.targetYaw = yaw;
    this._euler.set(0, yaw, 0);
    this.quaternion.setFromEuler(this._euler);
    const hover = (this.t.mass * this.t.gravity) / 4;
    this.rotorThrust = [hover, hover, hover, hover];
    this._vertI = 0;
    this.resetMods();
    this.lastImpactSpeed = 0;
    this.impacts = 0;
  }

  /** Clear every external modifier back to its neutral value. */
  resetMods() {
    const m = this.mods;
    m.rotorScale[0] = m.rotorScale[1] = m.rotorScale[2] = m.rotorScale[3] = 1;
    m.dragScale = 1;
    m.tiltScale = 1;
    m.authority = 1;
  }

  // ── frame helpers ──────────────────────────────────────────────────────
  // These allocate deliberately: they are read by render/HUD code that holds
  // the result across calls, so handing out shared scratch would alias.
  get bodyUp() { return new THREE.Vector3(0, 1, 0).applyQuaternion(this.quaternion); }
  get forward() { return new THREE.Vector3(0, 0, -1).applyQuaternion(this.quaternion); }
  get right() { return new THREE.Vector3(1, 0, 0).applyQuaternion(this.quaternion); }
  get speed() { return this.velocity.length(); }
  get throttle() {
    const max = this.t.maxRotorThrust * 4;
    return (this.rotorThrust[0] + this.rotorThrust[1] + this.rotorThrust[2] + this.rotorThrust[3]) / max;
  }

  /** Bank/pitch/heading in radians, for HUD and camera use. */
  attitude() {
    this._euler.setFromQuaternion(this.quaternion, 'YXZ');
    return { pitch: this._euler.x, yaw: this._euler.y, roll: this._euler.z };
  }

  /**
   * Advance the simulation.
   * @param {number} dt seconds (caller should keep this <= ~1/120)
   * @param {{forward:number,right:number,yaw:number,vertical:number}} cmd
   *        each component in [-1, 1]
   * @param {?{query:Function}} collision world to resolve against
   */
  step(dt, cmd, collision) {
    const t = this.t;

    // Boost widens the envelope rather than adding a magic shove, so the
    // craft still obeys the same dynamics — it can simply lean further and
    // has the thrust to support it.
    const mods = this.mods;
    const boost = cmd.boost ? THREE.MathUtils.clamp(cmd.boost, 0, 1) : 0;
    const tiltLimit = t.maxTilt * (1 + (t.boostTilt - 1) * boost) * mods.tiltScale;
    const rotorLimit = t.maxRotorThrust * (1 + (t.boostThrust - 1) * boost);

    // ── outer loop: sticks -> target attitude ──────────────────────────
    this.targetYaw += cmd.yaw * t.maxYawRate * dt;
    // Keep the accumulator bounded so it never loses float precision.
    if (this.targetYaw > Math.PI) this.targetYaw -= Math.PI * 2;
    else if (this.targetYaw < -Math.PI) this.targetYaw += Math.PI * 2;

    // Negative pitch tilts body-up toward −Z (forward); negative roll tilts it
    // toward +X (right). See the axis derivation in the header comment.
    const targetPitch = -cmd.forward * tiltLimit;
    const targetRoll = -cmd.right * tiltLimit;

    this._euler.set(targetPitch, this.targetYaw, targetRoll);
    const qTarget = this._q1.setFromEuler(this._euler);

    // ── inner loop: quaternion attitude PD ────────────────────────────
    // qErr rotates the current attitude onto the target, expressed in world space.
    const qErr = this._q2.copy(this.quaternion).invert().premultiply(qTarget);
    if (qErr.w < 0) { qErr.x = -qErr.x; qErr.y = -qErr.y; qErr.z = -qErr.z; qErr.w = -qErr.w; }

    const sinHalf = Math.hypot(qErr.x, qErr.y, qErr.z);
    const errWorld = this._v3.set(0, 0, 0);
    if (sinHalf > 1e-6) {
      const angle = 2 * Math.atan2(sinHalf, qErr.w);
      errWorld.set(qErr.x, qErr.y, qErr.z).multiplyScalar(angle / sinHalf);
    }
    // Attitude error must act in the body frame, where the rotors live.
    const errBody = errWorld.applyQuaternion(this._q1.copy(this.quaternion).invert());

    const I = t.inertia;
    const kp = t.attitudeKp * mods.authority;
    const kd = t.attitudeKd * mods.authority;
    const tqX = I[0] * (kp * errBody.x - kd * this.omega.x);
    const tqY = I[1] * (kp * errBody.y - kd * this.omega.y);
    const tqZ = I[2] * (kp * errBody.z - kd * this.omega.z);

    // ── vertical: climb-rate hold ─────────────────────────────────────
    // Zero stick means "hold this altitude", which is what makes the craft
    // feel like a camera drone instead of a helicopter.
    //
    // The integral term is not decoration. In fast forward flight the
    // airframe is pitched ~38°, so a large slice of the (horizontal)
    // airspeed lies along the body's vertical axis and generates several
    // newtons of drag pushing the craft down. A proportional-only controller
    // settles with a standing error against that and sinks steadily while you
    // hold W. The integrator is exactly the altitude-hold term a real flight
    // controller uses, and it is clamped and frozen while thrust is saturated
    // so it cannot wind up.
    const targetVy = cmd.vertical * t.maxClimbRate;
    const vErr = targetVy - this.velocity.y;
    const accelVert = t.gravity + t.climbKp * vErr + t.climbKi * this._vertI;
    // Thrust points along body-up, so tilting costs vertical authority.
    const tiltFactor = Math.max(0.4, this._vUp.set(0, 1, 0).applyQuaternion(this.quaternion).dot(WORLD_UP));
    const demand = (t.mass * accelVert) / tiltFactor;
    const totalThrust = THREE.MathUtils.clamp(demand, 0, rotorLimit * 4);
    if (totalThrust === demand) {
      this._vertI = THREE.MathUtils.clamp(
        this._vertI + vErr * dt, -t.climbIClamp, t.climbIClamp,
      );
    }

    // ── mixer: (thrust, torque) -> four rotor commands ────────────────
    // Inverting the torque matrix for the X layout above gives these signs.
    const lever = t.arm * SQRT1_2;
    const kT = 1 / (4 * lever);
    const kY = 1 / (4 * t.yawTorqueCoeff);
    const base = totalThrust / 4;
    const cmdThrust = [
      base + kT * tqX + kT * tqZ + kY * tqY,
      base - kT * tqX + kT * tqZ - kY * tqY,
      base - kT * tqX - kT * tqZ + kY * tqY,
      base + kT * tqX - kT * tqZ - kY * tqY,
    ];

    // ── motor lag, then recompute the forces the rotors *actually* make ──
    const alpha = 1 - Math.exp(-dt / t.motorTau);
    this._force.set(0, 0, 0);
    this._torque.set(0, 0, 0);

    for (let i = 0; i < 4; i++) {
      const target = THREE.MathUtils.clamp(cmdThrust[i], 0, rotorLimit) * mods.rotorScale[i];
      this.rotorThrust[i] += (target - this.rotorThrust[i]) * alpha;
      const T = this.rotorThrust[i];
      const r = ROTORS[i];
      // r × (0, T, 0) = (−r.z·T, 0, r.x·T)
      this._torque.x += -r.z * t.arm * T;
      this._torque.z += r.x * t.arm * T;
      this._torque.y += r.spin * t.yawTorqueCoeff * T;
      this._force.y += T;
    }

    // Rotor thrust is a body-frame force; take it to world space.
    this._force.applyQuaternion(this.quaternion);
    this._force.y -= t.mass * t.gravity;

    // ── aerodynamic drag, evaluated per body axis ─────────────────────
    const vBody = this._v1.copy(this.velocity).applyQuaternion(this._q1.copy(this.quaternion).invert());
    const dq = t.dragQuad;
    const ds = mods.dragScale;
    const dl = t.dragLinear * ds;
    this._v2.set(
      -dq[0] * ds * vBody.x * Math.abs(vBody.x) - dl * vBody.x,
      -dq[1] * ds * vBody.y * Math.abs(vBody.y) - dl * vBody.y,
      -dq[2] * ds * vBody.z * Math.abs(vBody.z) - dl * vBody.z,
    );
    this._force.add(this._v2.applyQuaternion(this.quaternion));

    // Rotational damping.
    this._torque.x -= t.angularDrag * this.omega.x;
    this._torque.y -= t.angularDrag * this.omega.y;
    this._torque.z -= t.angularDrag * this.omega.z;

    // ── integrate linear motion (semi-implicit Euler) ─────────────────
    this.velocity.addScaledVector(this._force, dt / t.mass);
    this.position.addScaledVector(this.velocity, dt);

    // ── integrate angular motion: I·ω̇ = τ − ω × (I·ω) ─────────────────
    const Iw = this._v1.set(I[0] * this.omega.x, I[1] * this.omega.y, I[2] * this.omega.z);
    const gyro = this._v2.copy(this.omega).cross(Iw);
    this.omega.x += ((this._torque.x - gyro.x) / I[0]) * dt;
    this.omega.y += ((this._torque.y - gyro.y) / I[1]) * dt;
    this.omega.z += ((this._torque.z - gyro.z) / I[2]) * dt;

    // q̇ = ½ · q ⊗ (0, ω)
    const spin = this._q1.set(this.omega.x, this.omega.y, this.omega.z, 0);
    spin.premultiply(this.quaternion);
    this.quaternion.x += 0.5 * spin.x * dt;
    this.quaternion.y += 0.5 * spin.y * dt;
    this.quaternion.z += 0.5 * spin.z * dt;
    this.quaternion.w += 0.5 * spin.w * dt;
    this.quaternion.normalize();

    if (collision) this._resolve(collision);
  }

  _resolve(collision) {
    const t = this.t;
    const contacts = collision.query(this.position, t.radius);
    this.grounded = false;
    if (contacts.length === 0) return;

    for (const c of contacts) {
      const n = c.normal;
      // Push out of penetration.
      this.position.addScaledVector(n, c.depth);
      if (n.y > 0.7) this.grounded = true;

      const vn = this.velocity.dot(n);
      if (vn >= 0) continue; // already separating

      this.lastImpactSpeed = Math.max(this.lastImpactSpeed, -vn);
      if (-vn > 1.5) this.impacts++;

      // Normal impulse with restitution.
      this.velocity.addScaledVector(n, -vn * (1 + t.restitution));

      // Tangential friction.
      const vt = this._v1.copy(this.velocity).addScaledVector(n, -this.velocity.dot(n));
      this.velocity.addScaledVector(vt, -t.friction);

      // A scrape imparts spin, which the controller then has to fight back.
      const kick = this._v2.copy(n).cross(vt).multiplyScalar(t.spinKick);
      this.omega.add(kick.applyQuaternion(this._q1.copy(this.quaternion).invert()));
    }

    // Keep the airframe recoverable — an unbounded tumble is just frustrating.
    const maxSpin = 12;
    if (this.omega.lengthSq() > maxSpin * maxSpin) this.omega.setLength(maxSpin);
  }
}
