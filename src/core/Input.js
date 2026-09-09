/**
 * Keyboard input.
 *
 * Continuous actions are polled (`axis` / `isDown`); one-shot actions fire
 * callbacks registered through `on`.
 *
 * No flight control is bound to Cmd or Ctrl, which avoids an entire class of
 * platform problem: while Cmd is held macOS treats the keyboard as a
 * menu-shortcut context, making `keyup` unreliable *and* suppressing
 * auto-repeat `keydown` — between them there is no liveness signal left, so
 * nothing can verify whether a key is still down. Shift is a modifier too but
 * carries none of this behaviour, so boost is unaffected.
 *
 * The latching below is therefore defensive rather than load-bearing: if a
 * player happens to hold Cmd (reaching for Cmd-Tab, say), we stop trusting
 * `keyup` until it is released rather than letting keys strand.
 */

import { FEATURES } from '../config.js';

const HOLD_MAP = {
  // Left hand: translation, heading, strafe and boost.
  KeyW: 'forward',
  KeyS: 'back',
  KeyA: 'yawLeft',
  KeyD: 'yawRight',
  KeyQ: 'left',
  KeyE: 'right',
  ShiftLeft: 'boost',
  ShiftRight: 'boost',
  // Right hand: vertical.
  KeyK: 'up',
  KeyM: 'down',
};

/**
 * Mute is deliberately absent: M is the descend key, so muting is done with
 * the on-screen button instead. Restart and new-track have no keys either —
 * both live on buttons in the pause and finish screens.
 */
const TAP_MAP = {
  ...(FEATURES.powerUps ? { Space: 'usePowerUp' } : {}),
  Digit1: 'respawn',
  Escape: 'pause',
  Enter: 'confirm',
};

/**
 * Cmd and Ctrl. These are never stored in `pressed`: descend is derived from
 * the modifier *state* carried on every keyboard event, which survives a
 * missed keydown or keyup for the modifier key itself.
 */
const MODIFIER_CODES = new Set([
  'MetaLeft', 'MetaRight', 'ControlLeft', 'ControlRight',
]);

/**
 * Codes we swallow so the page never triggers a browser default.
 *
 * Space is only included while power-ups are enabled. When it is not a game
 * key we deliberately leave it alone, so a keyboard user can still activate
 * a focused button with it.
 */
const SWALLOW = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyK', 'KeyM',
  ...(FEATURES.powerUps ? ['Space'] : []),
]);

export class Input {
  constructor(target = window) {
    this.target = target;
    this.pressed = new Set();
    this.listeners = new Map();
    this.enabled = true;

    /** True while Cmd or Ctrl is held, per the modifier state on events. */
    this.modifierHeld = false;

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._flush = this._flush.bind(this);

    target.addEventListener('keydown', this._onKeyDown, { passive: false });
    target.addEventListener('keyup', this._onKeyUp);
    target.addEventListener('blur', this._flush);
    document.addEventListener('visibilitychange', this._flush);
  }

  /** Register a one-shot handler. Returns an unsubscribe function. */
  on(action, fn) {
    if (!this.listeners.has(action)) this.listeners.set(action, new Set());
    this.listeners.get(action).add(fn);
    return () => this.listeners.get(action).delete(fn);
  }

  isDown(action) {
    if (!this.enabled) return false;
    for (const code of this.pressed) {
      if (HOLD_MAP[code] === action) return true;
    }
    return false;
  }

  /** Bipolar axis in [-1, 1]. */
  axis(negative, positive) {
    return (this.isDown(positive) ? 1 : 0) - (this.isDown(negative) ? 1 : 0);
  }

  /**
   * Reconcile our view of Cmd/Ctrl with the state on this event.
   * A held -> released transition is the moment our latched key set becomes
   * untrustworthy, so that is where we flush.
   */
  _syncModifier(e) {
    const held = e.metaKey || e.ctrlKey;
    if (held === this.modifierHeld) return;
    this.modifierHeld = held;
    if (!held) this.pressed.clear();
  }

  _onKeyDown(e) {
    // Typing wins over flight controls, and this check has to come first:
    // suppressing the default before it would stop the character ever
    // reaching the field. Seeds are words, so several movement keys overlap
    // with letters the player needs to type.
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;

    if (SWALLOW.has(e.code)) e.preventDefault();
    if (MODIFIER_CODES.has(e.code)) e.preventDefault();

    // Read the modifier before latching, so a key pressed in the same event
    // as Cmd going down is treated as being under the modifier.
    this._syncModifier(e);

    if (HOLD_MAP[e.code]) this.pressed.add(e.code);

    // Only fire taps on the initial press, never on auto-repeat, and never
    // when a modifier is held (that's a browser/OS shortcut, not our input).
    if (!e.repeat && TAP_MAP[e.code] && !e.metaKey && !e.ctrlKey && !e.altKey) {
      this._emit(TAP_MAP[e.code]);
    }
  }

  _onKeyUp(e) {
    if (MODIFIER_CODES.has(e.code)) {
      // Cmd/Ctrl came up: descend stops and the latched set is discarded.
      this.modifierHeld = false;
      this.pressed.clear();
      return;
    }

    // While a modifier is held, keyup cannot be trusted — see the class note.
    // Latch the key and wait for the modifier to be released.
    if (this.modifierHeld) {
      this._syncModifier(e);
      return;
    }


    this._syncModifier(e);
    this.pressed.delete(e.code);
  }

  _flush() {
    this.pressed.clear();
    this.modifierHeld = false;
  }

  _emit(action) {
    const set = this.listeners.get(action);
    if (set) for (const fn of set) fn();
  }

  dispose() {
    this.target.removeEventListener('keydown', this._onKeyDown);
    this.target.removeEventListener('keyup', this._onKeyUp);
    this.target.removeEventListener('blur', this._flush);
    document.removeEventListener('visibilitychange', this._flush);
  }
}
