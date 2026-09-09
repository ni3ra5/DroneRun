import { formatTime, formatDelta } from '../race/Race.js';
import { PLAYER_COLORS } from '../drone/DroneModel.js';
import { Compass } from './Compass.js';
import { AltitudeTape } from './AltitudeTape.js';
import { Scoreboard } from './Scoreboard.js';
import { FEATURES } from '../config.js';

/**
 * DOM heads-up display and the modal screens. Kept in DOM rather than drawn
 * into the canvas so text stays crisp at any device pixel ratio and remains
 * selectable/accessible.
 */

const KEYMAP_ROWS = [
  ['<kbd>W</kbd><kbd>S</kbd>', 'Move forward / backward'],
  ['<kbd>A</kbd><kbd>D</kbd>', 'Rotate (yaw) left / right'],
  ['<kbd>Q</kbd><kbd>E</kbd>', 'Move left / right'],
  ['<kbd>K</kbd><kbd>M</kbd>', 'Fly up / down'],
  ['<kbd>Shift</kbd>', 'Boost &mdash; limited, refills when released'],
  ...(FEATURES.powerUps
    ? [['<kbd>Space</kbd>', 'Use the power-up you are carrying']] : []),
  ['<kbd>1</kbd>', 'Return to last gate'],
  ['<kbd>Esc</kbd>', 'Pause / main menu'],
];

const EFFECT_LABELS = {
  STUNNED: { label: 'Hit', color: '#ff4d7e' },
  ROTOR_JAM: { label: 'Rotor jam', color: '#ffb028' },
  SCRAMBLER: { label: 'Scrambled', color: '#a46bff' },
  AFTERBURNER: { label: 'Afterburner', color: '#ff7a45' },
  FOCUS: { label: 'Focus', color: '#35e6d0' },
  PHASE: { label: 'Phase', color: '#3d9bff' },
};

function ordinal(n) {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th'
    : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}

export class HUD {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <div class="panel" id="hud-timer">
        <div class="label">Elapsed</div>
        <div class="value" data-time>00:00.000</div>
        <div class="sub">
          <span>Best <b data-best>--:--.---</b></span>
          <span data-delta></span>
        </div>
      </div>

      <canvas id="hud-compass"></canvas>

      <div class="panel hidden" id="hud-board">
        <div class="label">Standings</div>
        <div class="sb-rows"></div>
      </div>

      <div id="hud-alt"><canvas></canvas></div>

      <div class="panel" id="hud-gate">
        <div class="label">Checkpoint</div>
        <div class="value"><b data-gate>1</b><small> / <span data-total>0</span></small></div>
        <div class="dist" data-dist>0 m</div>
        <div id="hud-pips"></div>
      </div>

      <div class="panel" id="hud-flight">
        <div class="stack">
          <div class="label">Ground speed</div>
          <div class="value" data-speed>0<span class="unit">km/h</span></div>
        </div>
        <div class="stack">
          <div class="label">Altitude</div>
          <div class="value" data-alt>0<span class="unit">m</span></div>
        </div>
        <div class="stack" style="min-width:auto">
          <div class="label">Thr</div>
          <div class="gauge"><i data-throttle></i></div>
        </div>
        <div class="stack" style="min-width:auto">
          <div class="label">V/S</div>
          <div class="gauge centred"><i data-vsi></i></div>
        </div>
        <div class="stack" style="min-width:96px">
          <div class="label">Boost <kbd>Shift</kbd></div>
          <div class="bar" data-boostbar><i data-boost></i></div>
        </div>
      </div>

      <div class="panel" id="hud-keys">
        <div><b>W S</b> move &nbsp;·&nbsp; <b>A D</b> rotate</div>
        <div><b>Q E</b> strafe &nbsp;·&nbsp; <b>K M</b> up / down</div>
        <div><b>Shift</b> boost${FEATURES.powerUps ? ' &nbsp;·&nbsp; <b>Space</b> power-up' : ''}</div>
        <div><b>1</b> last gate &nbsp;·&nbsp; <b>Esc</b> pause</div>
      </div>

      <button id="hud-mute" type="button" aria-pressed="false">
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path class="horn" d="M3 8h3l4-3.5v11L6 12H3z"/>
          <path class="wave wave-1" d="M12.6 7.4a3.4 3.4 0 0 1 0 5.2"/>
          <path class="wave wave-2" d="M14.8 5.4a6.2 6.2 0 0 1 0 9.2"/>
          <path class="slash" d="M13 7l5 6M18 7l-5 6"/>
        </svg>
        <span data-mute>Music</span>
      </button>

      <div id="chevron">
        <svg viewBox="0 0 62 62">
          <circle class="ring" cx="31" cy="31" r="20"/>
          <polygon class="tri" points="31,4 38,17 24,17"/>
          <text class="txt" x="31" y="35" data-chevdist></text>
        </svg>
      </div>

      <div class="panel hidden" id="hud-item">
        <div class="label">Power-up <kbd>Space</kbd></div>
        <div class="item-body">
          <span class="item-glyph"></span>
          <span class="item-text">
            <b class="item-name"></b>
            <i class="item-blurb"></i>
          </span>
        </div>
      </div>

      <div id="hud-effects"></div>

      <div id="speedfx"></div>
      <div id="centre"><div id="countdown"></div></div>
      <div id="toast"></div>
      <div id="modal" class="hidden"></div>
    `;

    const q = (sel) => root.querySelector(sel);
    this.el = {
      time: q('[data-time]'),
      best: q('[data-best]'),
      delta: q('[data-delta]'),
      gate: q('[data-gate]'),
      total: q('[data-total]'),
      dist: q('[data-dist]'),
      pips: q('#hud-pips'),
      speed: q('[data-speed]'),
      alt: q('[data-alt]'),
      throttle: q('[data-throttle]'),
      vsi: q('[data-vsi]'),
      boost: q('[data-boost]'),
      boostBar: q('[data-boostbar]'),
      chevron: q('#chevron'),
      chevronDist: q('[data-chevdist]'),
      countdown: q('#countdown'),
      toast: q('#toast'),
      modal: q('#modal'),
      speedfx: q('#speedfx'),
      item: q('#hud-item'),
      itemGlyph: q('#hud-item .item-glyph'),
      itemName: q('#hud-item .item-name'),
      itemBlurb: q('#hud-item .item-blurb'),
      effects: q('#hud-effects'),
      mute: q('[data-mute]'),
      muteButton: q('#hud-mute'),
    };

    /** Assigned by Game; the mute control is button-only (M is descend). */
    this.onMute = null;
    this.el.muteButton.addEventListener('click', () => this.onMute?.());

    this.compass = new Compass(q('#hud-compass'));
    this.altitude = new AltitudeTape(q('#hud-alt canvas'));
    this.scoreboard = new Scoreboard(q('#hud-board .sb-rows'));

    this._toastTimer = null;
    this._deltaTimer = null;
    this._pipCount = 0;
  }

  buildPips(total) {
    if (this._pipCount === total) return;
    this._pipCount = total;
    this.el.pips.innerHTML = Array.from({ length: total }, () => '<i class="pip"></i>').join('');
    this._pips = [...this.el.pips.children];
  }

  update(s) {
    const el = this.el;
    el.time.textContent = formatTime(s.time);
    el.best.textContent = s.best != null ? formatTime(s.best) : '--:--.---';
    el.gate.textContent = String(Math.min(s.gateIndex + 1, s.total));
    el.total.textContent = String(s.total);
    el.dist.textContent = `${s.distance.toFixed(0)} m`;
    el.speed.firstChild.textContent = String(Math.round(s.speed * 3.6));
    el.alt.firstChild.textContent = String(Math.round(s.altitude));
    el.throttle.style.height = `${Math.round(Math.min(1, s.throttle) * 100)}%`;

    // Vertical speed sits on a centred gauge: up grows above the midline,
    // down below it.
    const vs = Math.max(-1, Math.min(1, s.verticalSpeed / 7));
    el.vsi.style.height = `${Math.abs(vs) * 50}%`;
    el.vsi.style.bottom = vs >= 0 ? '50%' : `${50 - Math.abs(vs) * 50}%`;
    el.vsi.style.background = vs >= 0 ? '#35e6d0' : '#ff4d7e';

    this.compass.draw(Compass.headingFromYaw(s.yaw));
    this.altitude.draw(s.altitude, s.verticalSpeed);

    // Screen-space rush to back up the 3D streaks. Kept subtle: it should
    // read as peripheral motion, not as a filter over the whole image.
    const fx = (s.boostIntensity ?? 0) * 0.85;
    el.speedfx.style.opacity = fx.toFixed(3);

    if (s.effects) this.setEffects(s.effects);

    el.boost.style.width = `${Math.round(s.boost * 100)}%`;
    const boostCls = s.boostLocked ? 'bar locked' : s.boostActive ? 'bar active' : 'bar';
    if (el.boostBar.className !== boostCls) el.boostBar.className = boostCls;

    if (this._pips) {
      for (let i = 0; i < this._pips.length; i++) {
        const cls = i < s.gateIndex ? 'pip done' : i === s.gateIndex ? 'pip next' : 'pip';
        if (this._pips[i].className !== cls) this._pips[i].className = cls;
      }
    }
  }

  /**
   * Show the power-up in hand, or clear the slot.
   * @param {?import('../race/PowerUps.js').PowerUpDef} def
   */
  setHeld(def) {
    if (!FEATURES.powerUps) return;
    const el = this.el.item;
    el.classList.toggle('hidden', !def);
    if (!def) return;
    const hex = `#${def.color.toString(16).padStart(6, '0')}`;
    this.el.itemGlyph.textContent = def.glyph;
    this.el.itemGlyph.style.color = hex;
    this.el.itemGlyph.style.borderColor = hex;
    this.el.itemName.textContent = def.name;
    this.el.itemBlurb.textContent = def.blurb;
    el.style.borderColor = hex;
  }

  /**
   * Active effect pips with their remaining time. Rows are created and
   * removed as effects come and go, and only the countdown text is rewritten
   * on the frames in between.
   */
  setEffects(list) {
    if (!FEATURES.powerUps) return;
    if (!this._effectRows) this._effectRows = new Map();
    const seen = new Set();

    for (const e of list) {
      seen.add(e.id);
      let row = this._effectRows.get(e.id);
      if (!row) {
        const el = document.createElement('div');
        el.className = 'fx-pip';
        const meta = EFFECT_LABELS[e.id] ?? { label: e.id, color: '#e8f1ff' };
        el.style.setProperty('--fx', meta.color);
        el.innerHTML = `<b>${meta.label}</b><i></i>`;
        this.el.effects.appendChild(el);
        row = { el, time: el.querySelector('i'), last: '' };
        this._effectRows.set(e.id, row);
      }
      const text = `${e.remaining.toFixed(1)}s`;
      if (row.last !== text) { row.last = text; row.time.textContent = text; }
    }

    for (const [id, row] of this._effectRows) {
      if (seen.has(id)) continue;
      row.el.remove();
      this._effectRows.delete(id);
    }
  }

  /** @param {Array} standings @param {number} total gates on the course */
  setStandings(standings, total) {
    if (!standings || standings.length < 2) {
      this.scoreboard.setVisible(false);
      this.scoreboard.clear();
      return;
    }
    this.scoreboard.setVisible(true);
    this.scoreboard.render(standings, total);
  }

  /** Flash the split delta against the personal best after a gate. */
  showDelta(delta) {
    const el = this.el.delta;
    if (delta == null) {
      el.textContent = '';
      return;
    }
    el.textContent = formatDelta(delta);
    el.className = delta <= 0 ? 'delta-good' : 'delta-bad';
    clearTimeout(this._deltaTimer);
    this._deltaTimer = setTimeout(() => { el.textContent = ''; }, 2600);
  }

  showCountdown(n) {
    this.el.countdown.textContent = n > 0 ? String(n) : 'GO';
    this.el.countdown.style.color = n > 0 ? '#e8f1ff' : '#35e6d0';
    if (n === 0) setTimeout(() => { this.el.countdown.textContent = ''; }, 550);
  }

  hideCountdown() { this.el.countdown.textContent = ''; }

  setMuted(muted) {
    this.el.muteButton.classList.toggle('muted', muted);
    this.el.muteButton.setAttribute('aria-pressed', String(muted));
    this.el.muteButton.title = muted ? 'Unmute music' : 'Mute music';
  }

  toast(text, color = '#35e6d0') {
    const el = this.el.toast;
    el.textContent = text;
    el.style.color = color;
    el.style.opacity = '1';
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 1300);
  }

  /** Position the off-screen indicator. See Indicator.js for the projection. */
  setChevron({ visible, x, y, angle, distance }) {
    const el = this.el.chevron;
    // Refuse to write non-finite values into the DOM. Nothing upstream should
    // produce them, but an SVG transform of "rotate(NaN)" is a hard parse
    // error the browser logs on every single frame, which buries anything
    // else in the console.
    const ok = visible
      && Number.isFinite(x) && Number.isFinite(y)
      && Number.isFinite(angle) && Number.isFinite(distance);
    el.style.opacity = ok ? '1' : '0';
    if (!ok) return;
    el.style.transform = `translate(${x}px, ${y}px) rotate(${angle}rad)`;
    // Counter-rotate the label so the number stays upright.
    this.el.chevronDist.setAttribute('transform', `rotate(${-angle * 180 / Math.PI} 31 31)`);
    this.el.chevronDist.textContent = `${Math.round(distance)}`;
  }

  // ── modals ─────────────────────────────────────────────────────────────

  _openModal(html) {
    this.el.modal.innerHTML = html;
    this.el.modal.classList.remove('hidden');
    this.root.classList.add('modal-open');
    return this.el.modal;
  }

  hideModal() {
    this.el.modal.classList.add('hidden');
    this.el.modal.innerHTML = '';
    this.root.classList.remove('modal-open');
  }

  showStart({ seed, colorIndex, theme, botCount, onStart, onSeed, onColor, onTheme, onBots, onCopyLink }) {
    const swatches = PLAYER_COLORS.map((c, i) => `
      <div class="sw" role="radio" tabindex="0" data-color="${i}"
           aria-checked="${i === colorIndex}" title="${c.name}"
           style="background:#${c.hex.toString(16).padStart(6, '0')}"></div>
    `).join('');

    const keymap = KEYMAP_ROWS.map(([k, d]) => `<div>${k}</div><b>${d}</b>`).join('');

    const modal = this._openModal(`
      <div class="card">
        <h1>Drone<span>Run</span></h1>
        <div class="tag">Procedural time trial</div>

        <p>
          Every seed builds a different course. Gates are placed so you have to
          climb, dive, turn back on yourself and thread gaps — not just hold
          forward. Pass them in order; the amber ring is always your next one.
        </p>

        <div class="field">
          <div class="label">Track seed</div>
          <div class="row">
            <input type="text" data-seed value="${seed}" spellcheck="false" />
            <button data-reseed>Randomise</button>
            <button data-copy>Copy link</button>
          </div>
        </div>

        <div class="field">
          <div class="label">Drone colour</div>
          <div class="swatches">${swatches}</div>
        </div>

        <div class="field">
          <div class="label">Bots in the lobby</div>
          <div class="segmented" role="radiogroup">
            ${[0, 3, 5, 7].map((n) => `
              <button role="radio" data-bots="${n}" aria-checked="${n === botCount}">${n || 'None'}</button>
            `).join('')}
          </div>
        </div>

        <div class="field">
          <div class="label">Lighting</div>
          <div class="segmented" role="radiogroup">
            <button role="radio" data-theme="night" aria-checked="${theme === 'night'}">Night</button>
            <button role="radio" data-theme="day" aria-checked="${theme === 'day'}">Day</button>
          </div>
        </div>

        <div class="label">Controls</div>
        <div class="keymap">${keymap}</div>

        <div class="note">
          Left hand flies, right hand holds altitude on <b>K</b> and <b>M</b>.
          Nothing is bound to <b>&#8984;</b> or Ctrl, so no OS or browser
          shortcut can fire mid-flight. Music is muted with the speaker button,
          since <b>M</b> is the descend key.
        </div>

        <div class="row">
          <button class="primary" data-start>Start race &nbsp;&rarr;</button>
        </div>
      </div>
    `);

    const seedInput = modal.querySelector('[data-seed]');
    modal.querySelector('[data-start]').onclick = () => onStart(seedInput.value.trim() || seed);
    modal.querySelector('[data-reseed]').onclick = () => { seedInput.value = onSeed(); };
    modal.querySelector('[data-copy]').onclick = async (e) => {
      const ok = await onCopyLink(seedInput.value.trim() || seed);
      e.target.textContent = ok ? 'Copied' : 'Copy failed';
      setTimeout(() => { e.target.textContent = 'Copy link'; }, 1600);
    };
    modal.querySelectorAll('[data-bots]').forEach((btn) => {
      btn.onclick = () => {
        modal.querySelectorAll('[data-bots]').forEach((o) => o.setAttribute('aria-checked', 'false'));
        btn.setAttribute('aria-checked', 'true');
        onBots(Number(btn.dataset.bots));
      };
    });
    modal.querySelectorAll('[data-theme]').forEach((btn) => {
      btn.onclick = () => {
        modal.querySelectorAll('[data-theme]').forEach((o) => o.setAttribute('aria-checked', 'false'));
        btn.setAttribute('aria-checked', 'true');
        onTheme(btn.dataset.theme);
      };
    });
    modal.querySelectorAll('[data-color]').forEach((sw) => {
      const pick = () => {
        modal.querySelectorAll('[data-color]').forEach((o) => o.setAttribute('aria-checked', 'false'));
        sw.setAttribute('aria-checked', 'true');
        onColor(Number(sw.dataset.color));
      };
      sw.onclick = pick;
      sw.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
    });
    seedInput.onkeydown = (e) => {
      if (e.key === 'Enter') onStart(seedInput.value.trim() || seed);
      e.stopPropagation();
    };
  }

  /**
   * @param {object} o
   * @param {?object} o.compare the best that stood *before* this run, so a
   *        record run is measured against what it beat rather than itself
   */
  showFinish({ time, isRecord, splits, best, compare, seed, position, fieldSize, onRestart, onNewTrack, onMainMenu }) {
    const rows = splits.map((t, i) => {
      const prev = i === 0 ? 0 : splits[i - 1];
      const refSplit = compare?.splits?.[i];
      const delta = refSplit != null ? t - refSplit : null;
      const cls = delta == null ? '' : delta <= 0 ? 'delta-good' : 'delta-bad';
      return `<div>
        <span>Gate ${i + 1}</span>
        <span>${formatTime(t)} &nbsp;<i style="color:#7d8ba6">+${(t - prev).toFixed(2)}</i>
        &nbsp;<i class="${cls}">${formatDelta(delta)}</i></span>
      </div>`;
    }).join('');

    const verdict = isRecord
      ? (compare
        ? `${(compare.time - time).toFixed(2)} s faster than your previous best.`
        : 'First completed run on this track — that is the time to beat.')
      : `Best here is ${formatTime(best?.time)}, ${formatDelta(time - best.time)} s off.`;

    const place = position && fieldSize > 1
      ? `<b style="color:${position === 1 ? '#35e6d0' : '#e8f1ff'}">
           ${position === 1 ? 'Won' : `Finished ${ordinal(position)}`} of ${fieldSize}
         </b> &nbsp;·&nbsp; `
      : '';

    const modal = this._openModal(`
      <div class="card">
        <div class="tag">${isRecord ? 'New personal best' : 'Race complete'}</div>
        <h2 style="font-family:ui-monospace,Menlo,monospace;font-size:44px">${formatTime(time)}</h2>
        <p style="margin-bottom:14px">
          ${place}${splits.length} gates on seed <b style="color:#e8f1ff">${seed}</b>. ${verdict}
        </p>
        <div class="splits">${rows}</div>
        <div class="row">
          <button class="primary" data-restart>Same track</button>
          <button data-new>New track</button>
          <button data-menu>Main menu</button>
        </div>
      </div>
    `);
    modal.querySelector('[data-restart]').onclick = onRestart;
    modal.querySelector('[data-new]').onclick = onNewTrack;
    modal.querySelector('[data-menu]').onclick = onMainMenu;
  }

  showPause({ onResume, onRestart, onNewTrack, onMainMenu }) {
    const modal = this._openModal(`
      <div class="card">
        <div class="tag">Paused</div>
        <h2>Holding position</h2>
        <p>The clock is stopped.</p>
        <div class="row">
          <button class="primary" data-resume>Resume &nbsp;<kbd>Esc</kbd></button>
          <button data-restart>Restart</button>
          <button data-new>New track</button>
          <button data-menu>Main menu</button>
        </div>
      </div>
    `);
    modal.querySelector('[data-resume]').onclick = onResume;
    modal.querySelector('[data-restart]').onclick = onRestart;
    modal.querySelector('[data-new]').onclick = onNewTrack;
    modal.querySelector('[data-menu]').onclick = onMainMenu;
  }
}
