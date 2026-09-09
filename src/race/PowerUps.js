/**
 * Power-up catalogue and the per-racer effect state that applies them.
 *
 * Every power-up works by one of three routes, and none of them fake
 * anything:
 *
 *   · a timed modifier on the victim's or user's `body.mods`, which the
 *     flight controller then has to cope with;
 *   · an instantaneous change to the body (a hit that kills velocity and
 *     adds spin, exactly as the collision solver already does for impacts);
 *   · a flag the game or HUD reads (time dilation, collision off, a
 *     scrambled gate indicator).
 *
 * The interesting one is ROTOR_JAM. Because the simulation runs a real
 * four-rotor mixer under a PD attitude controller, degrading one rotor makes
 * the victim's own controller fight the asymmetry — the lurching wobble that
 * comes out is emergent, not animated.
 *
 * It is modelled as a *fluctuating* rotor rather than a constant loss, and
 * that is deliberate. A steady loss is not a usable dial: while the
 * controller has thrust headroom it compensates completely and nothing
 * happens, and the instant the loss exceeds what hovering needs the airframe
 * flips and never recovers. Oscillating the output keeps the controller
 * permanently a step behind, which both looks right and stays survivable.
 */

export const CATEGORY = { OFFENSIVE: 'offensive', SELF: 'self', TRAP: 'trap' };

/**
 * @typedef {object} PowerUpDef
 * @property {string} id
 * @property {string} name
 * @property {string} category
 * @property {number} color
 * @property {string} glyph      short label for the HUD slot
 * @property {string} blurb      one line, shown when picked up
 * @property {number} [duration] seconds, for effects that last
 * @property {boolean} [needsTarget] true if it does nothing without a victim
 */

/** @type {Record<string, PowerUpDef>} */
export const POWER_UPS = {
  MISSILE: {
    id: 'MISSILE',
    name: 'Homing missile',
    category: CATEGORY.OFFENSIVE,
    color: 0xff4d7e,
    glyph: '➤',
    blurb: 'Locks the racer ahead',
    needsTarget: true,
    duration: 1.6,          // how long the victim's controls stay degraded
  },
  ROTOR_JAM: {
    id: 'ROTOR_JAM',
    name: 'Rotor jam',
    category: CATEGORY.OFFENSIVE,
    color: 0xffb028,
    glyph: '✳',
    blurb: 'Kills one of their four rotors',
    needsTarget: true,
    duration: 2.4,
  },
  SCRAMBLER: {
    id: 'SCRAMBLER',
    name: 'Gate scrambler',
    category: CATEGORY.OFFENSIVE,
    color: 0xa46bff,
    glyph: '◇',
    blurb: 'Blinds them to their next gate',
    needsTarget: true,
    duration: 4,
  },
  OVERDRIVE: {
    id: 'OVERDRIVE',
    name: 'Overdrive',
    category: CATEGORY.SELF,
    color: 0x9fe339,
    glyph: '⚡',
    blurb: 'Boost reserve refilled',
  },
  AFTERBURNER: {
    id: 'AFTERBURNER',
    name: 'Afterburner',
    category: CATEGORY.SELF,
    color: 0xff7a45,
    glyph: '≫',
    blurb: 'Much faster, much worse at corners',
    duration: 5,
  },
  FOCUS: {
    id: 'FOCUS',
    name: 'Focus',
    category: CATEGORY.SELF,
    color: 0x35e6d0,
    glyph: '◉',
    blurb: 'The world slows down',
    duration: 2.4,
  },
  PHASE: {
    id: 'PHASE',
    name: 'Phase',
    category: CATEGORY.SELF,
    color: 0x3d9bff,
    glyph: '◍',
    blurb: 'Fly through anything',
    duration: 3,
  },
  MINE: {
    id: 'MINE',
    name: 'Mine',
    category: CATEGORY.TRAP,
    color: 0xff2f5e,
    glyph: '◆',
    blurb: 'Dropped behind you',
  },
};

export const POWER_UP_IDS = Object.keys(POWER_UPS);

/** Drop weights. Offensive items are useless solo, so the pool adapts. */
export function rollPowerUp(rng, hasOpponents) {
  const pool = hasOpponents
    ? ['MISSILE', 'ROTOR_JAM', 'SCRAMBLER', 'MINE', 'OVERDRIVE', 'AFTERBURNER', 'FOCUS', 'PHASE']
    : ['OVERDRIVE', 'AFTERBURNER', 'FOCUS', 'PHASE'];
  return pool[Math.floor(rng() * pool.length)];
}

/** Time dilation factor while FOCUS is running. */
export const FOCUS_TIME_SCALE = 0.6;

/**
 * Timed effects on one racer.
 *
 * `update` rebuilds `body.mods` from the active set every frame rather than
 * incrementally adding and removing, so an effect expiring can never leave a
 * modifier stuck on.
 */
export class Effects {
  /** @param {import('../drone/DronePhysics.js').DronePhysics} body */
  constructor(body) {
    this.body = body;
    /** @type {Map<string, {remaining: number, data: any}>} */
    this.active = new Map();
    this._phase = 0;
  }

  clear() {
    this.active.clear();
    this._phase = 0;
    this.body.resetMods();
  }

  /** @param {string} id @param {number} duration seconds @param {any} [data] */
  add(id, duration, data = null) {
    this.active.set(id, { remaining: duration, data });
  }

  has(id) { return this.active.has(id); }
  remaining(id) { return this.active.get(id)?.remaining ?? 0; }

  /** Effects tick on the real clock, so time dilation cannot extend itself. */
  update(realDt) {
    this._phase += realDt;
    for (const [id, e] of this.active) {
      e.remaining -= realDt;
      if (e.remaining <= 0) this.active.delete(id);
    }

    const m = this.body.mods;
    this.body.resetMods();

    if (this.active.has('ROTOR_JAM')) {
      const which = this.active.get('ROTOR_JAM').data?.rotor ?? 0;
      // Swings between roughly 0.15 and 0.95 of commanded thrust. The dips
      // go below what a hover needs, so the craft genuinely lurches; the
      // recoveries stop it becoming an unrecoverable flip.
      m.rotorScale[which] = 0.55 + 0.4 * Math.sin(this._phase * 15);
    }
    if (this.active.has('STUNNED')) {
      m.authority = 0.3;
    }
    if (this.active.has('AFTERBURNER')) {
      // Less drag, not more thrust: a genuinely higher top speed bought with
      // much lazier deceleration and cornering.
      m.dragScale = 0.4;
    }
    if (this.active.has('FOCUS')) {
      // Extra tilt authority so the slowed world is actually usable for
      // threading a gate rather than just pretty.
      m.tiltScale = 1.12;
    }
  }

  get timeScale() { return this.active.has('FOCUS') ? FOCUS_TIME_SCALE : 1; }
  get collisionOff() { return this.active.has('PHASE'); }
  get scrambled() { return this.active.has('SCRAMBLER'); }

  /** For the HUD: active effects with the time left on each. */
  list() {
    const out = [];
    for (const [id, e] of this.active) {
      out.push({ id, remaining: e.remaining });
    }
    return out;
  }
}

/**
 * Land a hit on a racer. Mirrors what the collision solver does on a hard
 * impact — kill the velocity, add a spin kick — plus a spell of degraded
 * control authority so recovery takes a moment.
 *
 * @param {{body: object, effects: Effects}} victim
 * @param {number} stunDuration
 * @param {() => number} rng
 */
export function applyHit(victim, stunDuration, rng = Math.random) {
  victim.body.velocity.set(0, 0, 0);
  victim.body.omega.set(
    (rng() - 0.5) * 9,
    (rng() - 0.5) * 6,
    (rng() - 0.5) * 9,
  );
  victim.effects.add('STUNNED', stunDuration);
}
