/**
 * Boost: a limited reserve that drains while held and refills when not.
 *
 * Kept separate from DronePhysics deliberately. The physics stays a pure
 * function of (state, command) — it just reads a boost amount in the command
 * and raises its tilt and thrust limits accordingly. All the resource
 * bookkeeping lives here, which makes it testable on its own and keeps the
 * flight model free of game rules.
 *
 * Two anti-stutter rules matter more than they look:
 *   · a short delay before refill starts, so tapping the key repeatedly is
 *     not strictly better than holding it;
 *   · after a full drain the key must be released AND the reserve must climb
 *     back to a usable level before it will fire again, so an empty meter
 *     cannot be machine-gunned for a series of useless micro-boosts.
 */

export const BOOST_DEFAULTS = {
  seconds: 2.8,        // continuous boost available from full
  refillSeconds: 6,    // time to go from empty to full
  refillDelay: 0.6,    // pause before refill begins after releasing
  reengageAt: 0.25,    // fraction needed to fire again after a full drain
};

export class Boost {
  constructor(opts = {}) {
    this.cfg = { ...BOOST_DEFAULTS, ...opts };
    this.reset();
  }

  reset() {
    this.level = 1;          // 0..1
    this.active = false;
    this.locked = false;     // drained; awaiting release + recharge
    this._delay = 0;
    this._heldSinceLock = false;
  }

  /**
   * @param {number} dt seconds
   * @param {boolean} wanted is the boost key held this frame?
   */
  update(dt, wanted) {
    if (!wanted) this._heldSinceLock = false;

    const usable = wanted && !this.locked && this.level > 0 && !this._heldSinceLock;
    this.active = usable;

    if (usable) {
      this.level = Math.max(0, this.level - dt / this.cfg.seconds);
      this._delay = this.cfg.refillDelay;
      if (this.level === 0) {
        // Drained. Require a release before this key can fire again.
        this.locked = true;
        this.active = false;
        this._heldSinceLock = wanted;
      }
      return;
    }

    if (this._delay > 0) {
      this._delay = Math.max(0, this._delay - dt);
      return;
    }
    this.level = Math.min(1, this.level + dt / this.cfg.refillSeconds);
    // `locked` has to keep meaning "will not fire". Clearing it purely on
    // recharge would turn the HUD meter amber again while the key is still
    // held down from the drain, even though boost is still inhibited.
    if (this.locked && this.level >= this.cfg.reengageAt && !this._heldSinceLock) {
      this.locked = false;
    }
  }

  /** 0..1, for the HUD meter. */
  get fraction() { return this.level; }
}
