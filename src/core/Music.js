/**
 * Background music.
 *
 * Uses a plain HTMLAudioElement rather than WebAudio: the track is a 2 MB
 * MP3 that only ever needs to loop at one volume, so streaming it costs
 * nothing and avoids decoding the whole file into memory up front.
 *
 * Two things browsers make awkward, both handled here:
 *
 *   · Autoplay is blocked unless playback begins inside a user gesture. A
 *     round always starts from a click or a keypress, so the normal path is
 *     fine — but if `play()` is ever rejected we arm a one-shot listener and
 *     retry on the player's next interaction rather than silently staying mute.
 *   · Cutting audio dead is jarring, so volume changes ramp. The ramp is
 *     driven from the game loop via `update`.
 */

const STORAGE_KEY = 'dronerun.muted';

export class Music {
  constructor(src, { volume = 0.5 } = {}) {
    this.maxVolume = volume;
    this.muted = this._loadMuted();

    this._target = 0;
    this._current = 0;
    this._fadeRate = 2.2;    // volume units per second
    this._armed = false;
    this._retry = null;

    this.el = new window.Audio(src);
    this.el.loop = true;
    this.el.preload = 'auto';
    this.el.volume = 0;
    // A looping track that fails to load should never break the game.
    this.el.addEventListener('error', () => { this.failed = true; });
  }

  _loadMuted() {
    try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
  }

  _saveMuted() {
    try { localStorage.setItem(STORAGE_KEY, this.muted ? '1' : '0'); } catch { /* ignore */ }
  }

  /** Start (or restart) the track from the top. Call from a user gesture. */
  start() {
    if (this.failed) return;
    this._pauseWhenSilent = false;   // clear any earlier stop request
    this._target = this.muted ? 0 : this.maxVolume;
    try { this.el.currentTime = 0; } catch { /* not seekable yet */ }
    this._attemptPlay();
  }

  _attemptPlay() {
    const p = this.el.play();
    if (!p || typeof p.catch !== 'function') return;
    p.catch(() => {
      // Blocked by the autoplay policy. Retry on the next real interaction.
      if (this._armed) return;
      this._armed = true;
      this._retry = () => {
        this._armed = false;
        window.removeEventListener('pointerdown', this._retry);
        window.removeEventListener('keydown', this._retry);
        this.el.play().catch(() => { /* give up quietly */ });
      };
      window.addEventListener('pointerdown', this._retry, { once: true });
      window.addEventListener('keydown', this._retry, { once: true });
    });
  }

  /** Ramp down and stop once silent. */
  fadeOut() { this._target = 0; }

  pause() {
    this._target = 0;
    this._pauseWhenSilent = true;
  }

  resume() {
    if (this.failed) return;
    this._pauseWhenSilent = false;
    this._target = this.muted ? 0 : this.maxVolume;
    if (this.el.paused) this._attemptPlay();
  }

  toggleMute() {
    this.muted = !this.muted;
    this._saveMuted();
    this._target = this.muted ? 0 : (this.el.paused ? 0 : this.maxVolume);
    return this.muted;
  }

  /** Drive the volume ramp. Safe to call every frame. */
  update(dt) {
    if (this.failed) return;
    if (this._current === this._target) {
      if (this._target === 0 && this._pauseWhenSilent && !this.el.paused) this.el.pause();
      return;
    }
    const step = this._fadeRate * dt;
    if (Math.abs(this._target - this._current) <= step) this._current = this._target;
    else this._current += Math.sign(this._target - this._current) * step;

    this.el.volume = Math.max(0, Math.min(1, this._current));
    if (this._current === 0 && this._pauseWhenSilent && !this.el.paused) this.el.pause();
  }

  dispose() {
    this.el.pause();
    this.el.src = '';
    if (this._retry) {
      window.removeEventListener('pointerdown', this._retry);
      window.removeEventListener('keydown', this._retry);
    }
  }
}
