import * as THREE from 'three';

/**
 * Race rules, checkpoint validation and timing.
 *
 * Checkpoints are validated by testing the segment the drone travelled this
 * frame against the gate's plane, rather than by testing proximity to the
 * gate centre. That means a gate can never be missed by flying through it
 * fast (no tunnelling), and — because we require the crossing to go from the
 * negative to the positive side of the plane — it also can't be claimed by
 * reversing back through a gate.
 */

/**
 * The one and only checkpoint rule, shared by the player and every bot so
 * nobody is judged on different terms.
 *
 * Tests the segment travelled this frame against the gate's plane rather than
 * proximity to its centre: a gate therefore cannot be missed by flying
 * through it fast, and — because the crossing must run from the negative to
 * the positive side — cannot be claimed by reversing back through it.
 *
 * @param {{position: THREE.Vector3, normal: THREE.Vector3, radius: number}} cp
 * @param {THREE.Vector3} prevPos position at the previous frame
 * @param {THREE.Vector3} pos position now
 * @param {THREE.Vector3} scratch reusable vector, avoids allocating per frame
 */
export function crossedGate(cp, prevPos, pos, scratch) {
  const d0 = scratch.copy(prevPos).sub(cp.position).dot(cp.normal);
  const d1 = scratch.copy(pos).sub(cp.position).dot(cp.normal);
  if (!(d0 <= 0 && d1 > 0)) return false;

  const t = d0 / (d0 - d1);
  scratch.lerpVectors(prevPos, pos, t);
  return scratch.distanceTo(cp.position) <= cp.radius;
}

export const RaceState = {
  IDLE: 'idle',
  COUNTDOWN: 'countdown',
  RACING: 'racing',
  FINISHED: 'finished',
};

const COUNTDOWN_FROM = 3;

export class Race {
  constructor(track) {
    this.track = track;
    this.state = RaceState.IDLE;
    this.currentIndex = 0;
    this.elapsed = 0;
    this.countdown = COUNTDOWN_FROM;
    this.splits = [];
    this.paused = false;

    this.onGate = null;      // (index, splitTime, deltaToBest|null) => void
    this.onFinish = null;    // (totalTime, isRecord, previousBest) => void
    this.onTick = null;      // (secondsRemaining) => void
    this.onMiss = null;      // () => void, wrong-way / skipped gate feedback

    this._hit = new THREE.Vector3();
    this._seg = new THREE.Vector3();

    this.best = this._loadBest();
    this._lastTickShown = null;
  }

  get storageKey() {
    return `dronerun.best.${this.track.seed}.${this.track.checkpoints.length}`;
  }

  _loadBest() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;   // private browsing, quota, disabled storage — all fine
    }
  }

  _saveBest(record) {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(record));
    } catch { /* not worth interrupting a race over */ }
  }

  get nextCheckpoint() {
    return this.track.checkpoints[this.currentIndex] ?? null;
  }

  get total() { return this.track.checkpoints.length; }
  get isRunning() { return this.state === RaceState.RACING && !this.paused; }

  reset() {
    this.state = RaceState.IDLE;
    this.currentIndex = 0;
    this.elapsed = 0;
    /**
     * Clock for the *field*, as against `elapsed`, which is the player's own
     * time and stops the moment they cross the line.
     *
     * The two have to be separate. A race is not over when the player
     * finishes — the rest of the field is still out on course, and you can
     * now sit in their cameras and watch them come home. Bots stamp their
     * splits from the race clock, so that clock has to keep running; but
     * running `elapsed` on would overwrite the time on the player's own
     * results card with however long they then spent spectating.
     */
    this.fieldElapsed = 0;
    this.countdown = COUNTDOWN_FROM;
    this.splits = [];
    this.paused = false;
    this._lastTickShown = null;
  }

  begin() {
    this.reset();
    this.state = RaceState.COUNTDOWN;
  }

  /**
   * @param {number} dt seconds
   * @param {THREE.Vector3} prevPos drone position at the previous frame
   * @param {THREE.Vector3} pos drone position now
   */
  update(dt, prevPos, pos) {
    if (this.paused) return;

    if (this.state === RaceState.COUNTDOWN) {
      this.countdown -= dt;
      const shown = Math.ceil(this.countdown);
      if (shown !== this._lastTickShown) {
        this._lastTickShown = shown;
        if (this.onTick) this.onTick(Math.max(0, shown));
      }
      if (this.countdown <= 0) {
        this.state = RaceState.RACING;
        this.elapsed = 0;
        this.fieldElapsed = 0;
      }
      return;
    }

    // The field's clock runs from GO until the race is reset — including
    // after the player has finished, while their rivals are still flying.
    if (this.state === RaceState.RACING || this.state === RaceState.FINISHED) {
      this.fieldElapsed += dt;
    }

    if (this.state !== RaceState.RACING) return;

    this.elapsed += dt;
    this._checkGate(prevPos, pos);
  }

  _checkGate(prevPos, pos) {
    const cp = this.nextCheckpoint;
    if (!cp) return;
    if (crossedGate(cp, prevPos, pos, this._hit)) this._passGate();
  }

  _passGate() {
    const index = this.currentIndex;
    const split = this.elapsed;
    this.splits.push(split);

    const bestSplit = this.best?.splits?.[index];
    const delta = bestSplit != null ? split - bestSplit : null;
    if (this.onGate) this.onGate(index, split, delta);

    this.currentIndex++;
    if (this.currentIndex >= this.total) this._finish();
  }

  _finish() {
    this.state = RaceState.FINISHED;
    const time = this.elapsed;

    // Hold on to the standing best before overwriting it. Without this, a
    // record run is compared against itself and every split delta reads
    // +0.00, which is worse than useless.
    const previousBest = this.best;
    const isRecord = !previousBest || time < previousBest.time;
    if (isRecord) {
      this.best = { time, splits: [...this.splits] };
      this._saveBest(this.best);
    }
    if (this.onFinish) this.onFinish(time, isRecord, previousBest);
  }

  /** Straight-line distance to the gate the player currently needs. */
  distanceToNext(pos) {
    const cp = this.nextCheckpoint;
    return cp ? pos.distanceTo(cp.position) : 0;
  }
}

/** mm:ss.mmm */
export function formatTime(seconds) {
  if (seconds == null || !isFinite(seconds)) return '--:--.---';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/** +0.42 / -1.10, for split comparison against a personal best. */
export function formatDelta(delta) {
  if (delta == null) return '';
  const sign = delta >= 0 ? '+' : '-';
  return `${sign}${Math.abs(delta).toFixed(2)}`;
}
