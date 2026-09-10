import * as THREE from 'three';

import { makeRng } from '../core/rng.js';
import { DronePhysics, stepFixed } from '../drone/DronePhysics.js';
import { DroneModel } from '../drone/DroneModel.js';
import { Boost } from '../drone/Boost.js';
import { crossedGate } from './Race.js';
import { Effects } from './PowerUps.js';
import { gridPosition } from './Grid.js';

/**
 * A computer-controlled racer.
 *
 * A bot is not a scripted mover: it owns a real DronePhysics body and a real
 * Boost reserve, and flies by pushing the same four stick values a player
 * does. So it obeys the same drag, the same tilt limits, the same motor lag,
 * and it collides with the same buildings. Its gates are judged by the same
 * `crossedGate` rule as the player's.
 *
 * The controller is a two-stage pursuit:
 *
 *   · `lineup` — fly to a staging point on the gate's own axis, some way
 *     behind it, so the approach arrives square to the aperture.
 *   · `commit` — drive at a point beyond the gate, so it flies *through*
 *     rather than converging on the threshold and stopping.
 *
 * Overshooting a gate drops it back to `lineup` to go round again. Without
 * that, a bot that misses parks itself just past the gate forever.
 *
 * Steering is velocity control, not position control: a proportional
 * controller on position alone has no damping term and simply orbits its
 * target.
 *
 * ── Missing gates ──────────────────────────────────────────────────────
 *
 * A bot that never fluffs a gate is both unbeatable and obviously mechanical.
 * Rather than making a bot *decide* to skip a gate — which would mean judging
 * it by different rules than the player — a fumble is produced by pushing its
 * aim off the gate axis and then letting the physics and the ordinary
 * `crossedGate` test settle what happens. Sometimes a shoved approach still
 * clips the ring and counts, which is exactly the near-miss you want; when it
 * doesn't, the existing overshoot recovery sends the bot round for another
 * attempt and the lost seconds are real.
 *
 * Every bot also carries a small permanent aim offset per gate, so even clean
 * approaches are not laser-straight.
 *
 * Randomness is seeded from the track, so a given seed reproduces the same
 * race — which the networking plan depends on.
 */

const NAMES = ['Vex', 'Kite', 'Rook', 'Mako', 'Piper', 'Wisp', 'Talon'];

const UP = new THREE.Vector3(0, 1, 0);

/** Per-bot skill, so a field spreads out instead of flying as one block. */
function skillFor(index, count) {
  // Spread evenly across the range rather than randomly, so a 3-bot field
  // still contains a fast one and a slow one.
  const t = count > 1 ? index / (count - 1) : 0.5;
  return {
    cruise: THREE.MathUtils.lerp(13.2, 9.4, t),      // m/s target speed
    lineupBack: THREE.MathUtils.lerp(13, 17, t),     // staging distance
    commitLead: THREE.MathUtils.lerp(16, 12, t),
    gain: THREE.MathUtils.lerp(4.4, 5.6, t),         // velocity error -> stick
    usesBoost: t < 0.7,
    // Chance of fumbling any given gate, and how sloppy a clean approach is.
    missChance: THREE.MathUtils.lerp(0.03, 0.13, t),
    aimSlop: THREE.MathUtils.lerp(0.18, 0.42, t),    // fraction of gate radius
  };
}

export class Bot {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {object} o.track
   * @param {import('../world/CollisionWorld.js').CollisionWorld} o.collision
   * @param {number} o.index
   * @param {number} o.count
   * @param {number} o.color
   */
  constructor({ scene, track, collision, index, count, color }) {
    this.id = `bot-${index}`;
    this.rng = makeRng(`bot-${track.seed}-${index}`);
    this.name = NAMES[index % NAMES.length];
    this.color = color;
    this.track = track;
    this.collision = collision;
    this.skill = skillFor(index, count);

    this.body = new DronePhysics();
    this.boost = new Boost();
    this.effects = new Effects(this.body);
    this.model = new DroneModel(color).addTo(scene);

    this.gate = 0;
    this.splits = [];
    this.finished = false;
    this.finishTime = null;
    this.misses = 0;

    this._cmd = { forward: 0, right: 0, yaw: 0, vertical: 0, boost: 0 };
    this._phase = 'lineup';
    this._watchGate = -1;
    this._sinceProgress = 0;
    this._aimOffset = new THREE.Vector3();
    this._fumbling = false;

    /**
     * This bot's own fixed-step remainder.
     *
     * Bots are integrated on exactly the same 240 Hz step as the player, not
     * once per rendered frame. The attitude controller's gains are only
     * stable at that step; driven at a variable ~1/60 it rings instead of
     * settling, which is invisible from behind your own drone and glaringly
     * obvious the moment a spectate camera sits on a bot. Each bot carries
     * its own remainder so they do not share a phase.
     */
    this._clock = { accum: 0 };

    this._prevPos = new THREE.Vector3();
    this._aim = new THREE.Vector3();
    this._to = new THREE.Vector3();
    this._want = new THREE.Vector3();
    this._local = new THREE.Vector3();
    this._scratch = new THREE.Vector3();
    this._q = new THREE.Quaternion();

    // Starting grid. Slot 0 belongs to the player, so the bots fill the rest
    // of the same shared grid the online field uses — see race/Grid.js.
    this.startSlot = index + 1;
    this.reset();
  }

  reset() {
    this.effects?.clear();
    if (this._clock) this._clock.accum = 0;
    const s = this.track.start;
    this.body.reset(gridPosition(s, this.startSlot, this._scratch), s.yaw);
    this.boost.reset();
    this.model.clearTrail();
    this.model.update(this.body, 1 / 60);

    this.gate = 0;
    this.splits = [];
    this.finished = false;
    this.finishTime = null;
    this.misses = 0;
    this._phase = 'lineup';
    this._watchGate = -1;
    this._sinceProgress = 0;
    this._aimOffset.set(0, 0, 0);
    this._fumbling = false;
    this._prevPos.copy(this.body.position);
  }

  get progress() {
    return {
      id: this.id,
      name: this.name,
      color: this.color,
      gate: this.gate,
      splits: this.splits,
      finished: this.finished,
      finishTime: this.finishTime,
      misses: this.misses,
    };
  }

  /**
   * @param {number} dt seconds
   * @param {number} raceElapsed shared race clock, so splits are comparable
   * @param {boolean} racing false during the countdown and after the finish
   */
  update(dt, raceElapsed, racing) {
    this.effects.update(dt);
    const collision = this.effects.collisionOff ? null : this.collision;

    if (this.finished) {
      // Hold a hover so a finished bot does not fall out of the sky.
      this._zero();
      this.boost.update(dt, false);
      stepFixed(this.body, this._clock, dt, this._cmd, collision);
      this.model.update(this.body, dt);
      return;
    }

    if (!racing) {
      this._zero();
      this.boost.update(dt, false);
      stepFixed(this.body, this._clock, dt, this._cmd, collision);
      this.model.update(this.body, dt);
      this._prevPos.copy(this.body.position);
      return;
    }

    this._steer(dt);
    this.boost.update(dt, this._cmd.boost > 0);
    this._cmd.boost = this.boost.active ? 1 : 0;

    this._prevPos.copy(this.body.position);
    stepFixed(this.body, this._clock, dt, this._cmd, collision);
    this.model.update(this.body, dt);

    this._checkGate(raceElapsed);
    this._watchdog(dt);
  }

  _zero() {
    const c = this._cmd;
    c.forward = c.right = c.yaw = c.vertical = c.boost = 0;
  }

  _steer(dt) {
    const cp = this.track.checkpoints[this.gate];
    if (!cp) { this._zero(); return; }

    if (this.gate !== this._watchGate) {
      this._watchGate = this.gate;
      this._phase = 'lineup';
      this._pickAim(cp);
    }

    const s = this.skill;
    const pos = this.body.position;
    const ahead = this._scratch.copy(pos).sub(cp.position).dot(cp.normal);

    this._aim.copy(cp.position).addScaledVector(
      cp.normal, this._phase === 'lineup' ? -s.lineupBack : s.commitLead,
    );

    // Only the committing run is thrown off. Staging still happens on the
    // axis, so a fumble looks like a botched final approach rather than a bot
    // wandering off toward nothing.
    if (this._phase === 'commit') this._aim.add(this._aimOffset);

    if (this._phase === 'lineup') {
      if (pos.distanceTo(this._aim) < 5.5) this._phase = 'commit';
    } else if (ahead > 5) {
      // Overshot without scoring. Go round again — and drop the bad aim, so
      // the retry is a clean attempt and cannot loop forever.
      this._phase = 'lineup';
      if (this._fumbling) {
        this.misses++;
        this._fumbling = false;
        this._aimOffset.set(0, 0, 0);
      }
    }

    this._to.copy(this._aim).sub(pos);
    const dist = this._to.length();

    // Point the nose where we are going.
    const yaw = this.body.attitude().yaw;
    let yawErr = Math.atan2(-this._to.x, -this._to.z) - yaw;
    while (yawErr > Math.PI) yawErr -= Math.PI * 2;
    while (yawErr < -Math.PI) yawErr += Math.PI * 2;

    // Desired velocity, eased down as we arrive.
    this._want.copy(this._to).normalize()
      .multiplyScalar(Math.min(s.cruise, dist * 0.85))
      .sub(this.body.velocity);

    this._q.setFromAxisAngle(UP, -yaw);
    this._local.copy(this._want).applyQuaternion(this._q);

    const c = this._cmd;
    c.yaw = THREE.MathUtils.clamp(yawErr * 2, -1, 1);
    c.forward = THREE.MathUtils.clamp(-this._local.z / s.gain, -1, 1);
    c.right = THREE.MathUtils.clamp(this._local.x / s.gain, -1, 1);
    c.vertical = THREE.MathUtils.clamp(this._want.y / 3, -1, 1);

    // Boost down long straights, once lined up — not into a corner.
    const aligned = Math.abs(yawErr) < 0.35;
    c.boost = s.usesBoost && aligned && dist > 26 && this.boost.level > 0.3 ? 1 : 0;
  }

  /**
   * Decide how this gate will be approached: a little off-axis normally, or
   * far enough off to sail past the ring when this one is going to be fumbled.
   */
  _pickAim(cp) {
    const s = this.skill;
    const fumble = this.rng.next() < s.missChance;
    this._fumbling = fumble;

    // Any direction in the gate's own plane.
    const lateral = this._scratch.crossVectors(UP, cp.normal);
    if (lateral.lengthSq() < 1e-4) lateral.set(1, 0, 0);
    lateral.normalize();
    const vertical = new THREE.Vector3().crossVectors(cp.normal, lateral).normalize();
    const angle = this.rng.float(0, Math.PI * 2);

    // A fumble aims outside the ring; ordinary slop stays inside it.
    //
    // The fumble magnitude has to overshoot the ring radius by a good margin.
    // The drone crosses the gate plane roughly midway between the on-axis
    // staging point (~15 m back) and the aim point (~14 m beyond), so only
    // about half the lateral offset has been realised by the time it gets
    // there. An offset of merely 1.2x the radius therefore sails straight
    // through the middle. The aim point itself must stay well beyond the
    // gate, or `ahead` never passes the overshoot threshold and the bot hangs
    // beside the ring instead of going round again.
    const magnitude = fumble
      ? cp.radius * this.rng.float(2.3, 3.2)
      : cp.radius * this.rng.float(0, s.aimSlop);

    this._aimOffset
      .copy(lateral).multiplyScalar(Math.cos(angle) * magnitude)
      .addScaledVector(vertical, Math.sin(angle) * magnitude);
  }

  _checkGate(raceElapsed) {
    const cp = this.track.checkpoints[this.gate];
    if (!cp) return;
    if (!crossedGate(cp, this._prevPos, this.body.position, this._scratch)) return;

    this.splits.push(raceElapsed);
    this.gate++;
    this._sinceProgress = 0;
    this._aimOffset.set(0, 0, 0);
    if (this.gate >= this.track.checkpoints.length) {
      this.finished = true;
      this.finishTime = raceElapsed;
    }
  }

  /**
   * A bot wedged in geometry would otherwise sit there for the whole race.
   * Put it back on the racing line at its last gate, exactly as the player's
   * own recovery key does.
   */
  _watchdog(dt) {
    this._sinceProgress += dt;
    if (this._sinceProgress < 14) return;
    this._sinceProgress = 0;

    const prev = this.gate > 0 ? this.track.checkpoints[this.gate - 1] : null;
    const next = this.track.checkpoints[this.gate];
    if (prev) {
      const p = prev.position.clone().addScaledVector(prev.normal, 3.5);
      const aim = next
        ? this._scratch.copy(next.position).sub(p)
        : this._scratch.copy(prev.normal);
      this.body.reset(p, Math.atan2(-aim.x, -aim.z));
    } else {
      this.reset();
    }
    this.boost.reset();
    this.model.clearTrail();
    this._phase = 'lineup';
    this._aimOffset.set(0, 0, 0);
    this._fumbling = false;
    this._prevPos.copy(this.body.position);
  }

  dispose() {
    this.model.dispose();
  }
}

/** Colours for a field of bots, avoiding the player's own. */
export function botColors(palette, playerColorIndex, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const idx = (playerColorIndex + 1 + i) % palette.length;
    out.push(palette[idx].hex);
  }
  return out;
}
