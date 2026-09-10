import { formatTime, formatDelta } from '../race/Race.js';
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

/** Length of the boost ring's arc: a semicircle of radius 40 in user units. */
const ARC_LENGTH = Math.PI * 40;

const EFFECT_LABELS = {
  STUNNED: { label: 'Hit', color: '#ff4d7e' },
  ROTOR_JAM: { label: 'Rotor jam', color: '#ffb028' },
  SCRAMBLER: { label: 'Scrambled', color: '#a46bff' },
  AFTERBURNER: { label: 'Afterburner', color: '#ff7a45' },
  FOCUS: { label: 'Focus', color: '#35e6d0' },
  PHASE: { label: 'Phase', color: '#3d9bff' },
};

/** Names come from other players, so they are escaped before display. */
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

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

      <div id="boostring">
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <path class="track" d="M 50 90 A 40 40 0 0 0 50 10"/>
          <path class="fill" d="M 50 90 A 40 40 0 0 0 50 10"/>
        </svg>
      </div>

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

      <div id="spectate" class="hidden">
        <button type="button" data-spec-prev aria-label="Previous drone">&#9664;</button>
        <span class="spec-body">
          <span class="label">Watching <i data-spec-pos></i></span>
          <span class="spec-who">
            <i class="sb-dot" data-spec-dot></i>
            <b data-spec-name></b>
            <span data-spec-state></span>
          </span>
        </span>
        <button type="button" data-spec-next aria-label="Next drone">&#9654;</button>
        <button type="button" class="primary" data-spec-exit>Results <kbd>Esc</kbd></button>
      </div>

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
      boostRing: q('#boostring'),
      boostArc: q('#boostring .fill'),
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
      spectate: q('#spectate'),
      specDot: q('[data-spec-dot]'),
      specName: q('[data-spec-name]'),
      specState: q('[data-spec-state]'),
      specPos: q('[data-spec-pos]'),
    };

    /** Assigned by Game; the mute control is button-only (M is descend). */
    this.onMute = null;
    this.el.muteButton.addEventListener('click', () => this.onMute?.());

    /**
     * Spectate controls. Bound once here rather than per-render: the bar is a
     * persistent element that only has its text rewritten, so rebinding it
     * every frame would be pure churn.
     */
    this.onSpectateStep = null;
    this.onSpectateExit = null;
    q('[data-spec-prev]').addEventListener('click', () => this.onSpectateStep?.(-1));
    q('[data-spec-next]').addEventListener('click', () => this.onSpectateStep?.(1));
    q('[data-spec-exit]').addEventListener('click', () => this.onSpectateExit?.());

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

  /**
   * Show or hide the spectate bar.
   *
   * @param {?{name:string, color:number, gate:number, total:number,
   *           finished:boolean, position:number, count:number}} info
   *        null hides the bar.
   */
  setSpectate(info) {
    const el = this.el.spectate;
    el.classList.toggle('hidden', !info);
    // Every instrument in the corners reads the *player's* drone, which is
    // not the one on screen while spectating. Rather than feed them somebody
    // else's telemetry, stand them down and leave the clock and the
    // standings, which are about the race rather than about one craft.
    this.root.classList.toggle('spectating', Boolean(info));
    if (!info) return;
    const hex = `#${info.color.toString(16).padStart(6, '0')}`;
    // Called several times a second while the field is still flying, so each
    // write is guarded — the bar is otherwise re-laid-out for nothing.
    const set = (node, key, value) => {
      if (this[key] === value) return;
      this[key] = value;
      node.textContent = value;
    };
    if (this._specHex !== hex) {
      this._specHex = hex;
      this.el.specDot.style.background = hex;
      this.el.specName.style.color = hex;
    }
    set(this.el.specName, '_specName', info.name);
    set(this.el.specPos, '_specPos', `${info.position} / ${info.count}`);
    set(this.el.specState, '_specState',
      info.finished ? 'finished' : `gate ${Math.min(info.gate + 1, info.total)} of ${info.total}`);
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

  /**
   * The boost reserve, drawn as a half ring around the drone itself.
   *
   * It lives beside the drone rather than in the instrument cluster because
   * boost is the one resource you spend while looking at the gate ahead —
   * having to flick down to the bottom-left corner to check it is exactly
   * when you cannot afford to. The arc fills from the bottom up.
   *
   * @param {{visible:boolean, x?:number, y?:number, fraction?:number,
   *          active?:boolean, locked?:boolean}} o
   */
  setBoostRing({ visible, x, y, fraction = 0, active = false, locked = false }) {
    const el = this.el.boostRing;
    // Same rule as the chevron: never write a non-finite value into the DOM.
    const ok = visible && Number.isFinite(x) && Number.isFinite(y);
    el.style.opacity = ok ? '1' : '0';
    if (!ok) return;
    el.style.transform = `translate(${x}px, ${y}px)`;
    const f = Math.max(0, Math.min(1, fraction));
    // The arc is a 40-unit radius semicircle, so its length is 40π.
    this.el.boostArc.style.strokeDashoffset = String(ARC_LENGTH * (1 - f));
    const cls = locked ? 'locked' : active ? 'active' : '';
    if (el.className !== cls) el.className = cls;
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

  /**
   * A segmented radio group. Buttons carry `data-<key>` so one delegated
   * handler per group can find them again after a re-render.
   */
  static _segmented(key, options, current) {
    return `<div class="segmented" role="radiogroup">${options.map(({ value, label }) => `
      <button role="radio" data-${key}="${value}"
              aria-checked="${String(value) === String(current)}">${label}</button>
    `).join('')}</div>`;
  }

  /** Wire a segmented group built by _segmented. */
  static _bindSegmented(modal, key, handler) {
    const all = modal.querySelectorAll(`[data-${key}]`);
    all.forEach((btn) => {
      btn.onclick = () => {
        all.forEach((o) => o.setAttribute('aria-checked', 'false'));
        btn.setAttribute('aria-checked', 'true');
        handler(btn.dataset[key]);
      };
    });
  }

  /**
   * The start screen.
   *
   * Solo or online is the first thing asked, because it decides whether the
   * rest of the settings are even this player's to make: online, the course,
   * its length and the lighting all belong to the host, so showing those
   * controls here would be offering choices the room will overrule.
   */
  showStart({
    mode, theme, botCount, gateCount, gateChoices, online, name, seedIsExplicit,
    onMode, onStart, onTheme, onBots, onGates, onHost, onJoin, onName, onStartRandom,
  }) {
    const keymap = KEYMAP_ROWS.map(([k, d]) => `<div>${k}</div><b>${d}</b>`).join('');
    const solo = mode !== 'online';

    const modeField = `
      <div class="field">
        <div class="label">How are you racing?</div>
        ${HUD._segmented('mode', [
          { value: 'solo', label: 'Solo' },
          { value: 'online', label: 'Online' },
        ], solo ? 'solo' : 'online')}
        ${online ? '' : `
          <div class="sub-note">Online play needs a relay URL in
          <span style="font-family:var(--mono)">src/config.js</span></div>`}
      </div>
    `;

    const soloFields = `
      <div class="field">
        <div class="label">Bots in the lobby</div>
        ${HUD._segmented('bots', [0, 3, 5, 7].map((n) => ({ value: n, label: n || 'None' })), botCount)}
      </div>

      <div class="field">
        <div class="label">Checkpoints</div>
        ${HUD._segmented('gates', gateChoices.map((n) => ({ value: n, label: n })), gateCount)}
      </div>

      <div class="field">
        <div class="label">Lighting</div>
        ${HUD._segmented('theme', [
          { value: 'night', label: 'Night' },
          { value: 'day', label: 'Day' },
        ], theme)}
      </div>
    `;

    const onlineFields = `
      <div class="field">
        <div class="label">Room</div>
        <div class="row">
          <button data-host>Create a race</button>
          <input type="text" data-joincode placeholder="ROOM CODE" maxlength="5"
                 style="width:120px;text-transform:uppercase" spellcheck="false" />
          <button data-join>Join</button>
        </div>
        <div class="sub-note">
          Up to 8 pilots, each given their own colour and grid square. The host
          picks the course, its length and the lighting for everyone.
        </div>
      </div>
    `;

    const soloActions = seedIsExplicit
      ? `<button class="primary" data-start>Race the shared course &nbsp;&rarr;</button>
         <button data-random>New course instead</button>`
      : '<button class="primary" data-start>Start race &nbsp;&rarr;</button>';

    const modal = this._openModal(`
      <div class="card">
        <h1>Drone<span>Run</span></h1>
        <div class="tag">Procedural time trial</div>

        <p>
          A new course every race. Gates are placed so you have to climb, dive,
          turn back on yourself and thread gaps — not just hold forward. Pass
          them in order; the amber ring is always your next one.
        </p>

        ${modeField}

        <div class="field">
          <div class="label">Pilot name</div>
          <div class="row">
            <input type="text" data-name value="${escapeHtml(name ?? '')}"
                   maxlength="16" spellcheck="false" />
            <span style="font-size:11px;color:var(--dim)">Shown to other players</span>
          </div>
        </div>

        ${solo ? soloFields : onlineFields}

        <div class="label">Controls</div>
        <div class="keymap">${keymap}</div>

        <div class="note">
          Left hand flies, right hand holds altitude on <b>K</b> and <b>M</b>.
          Nothing is bound to <b>&#8984;</b> or Ctrl, so no OS or browser
          shortcut can fire mid-flight. Music is muted with the speaker button,
          since <b>M</b> is the descend key.
        </div>

        ${solo ? `<div class="row">${soloActions}</div>` : ''}
      </div>
    `);

    const nameInput = modal.querySelector('[data-name]');
    // Commit the name on the way out of the field, so it is set before any
    // button that sends it to the relay is clicked.
    nameInput.onchange = () => onName(nameInput.value);
    nameInput.onkeydown = (e) => e.stopPropagation();
    const commitName = () => onName(nameInput.value);

    // Switching mode re-renders this whole screen, so the name in the field
    // has to be committed first or it is lost.
    HUD._bindSegmented(modal, 'mode', (m) => {
      commitName();
      onMode(m);
    });

    if (solo) {
      modal.querySelector('[data-start]').onclick = () => {
        commitName();
        onStart();
      };
      // Only shown when a specific seed arrived from a link.
      modal.querySelector('[data-random]')?.addEventListener('click', () => {
        commitName();
        onStartRandom();
      });
      HUD._bindSegmented(modal, 'bots', (v) => onBots(Number(v)));
      HUD._bindSegmented(modal, 'gates', (v) => onGates(Number(v)));
      HUD._bindSegmented(modal, 'theme', (v) => onTheme(v));
      return;
    }

    modal.querySelector('[data-host]').onclick = () => {
      commitName();
      onHost();
    };
    const codeInput = modal.querySelector('[data-joincode]');
    const join = () => {
      commitName();
      const code = codeInput.value.trim().toUpperCase();
      if (code) onJoin(code);
    };
    modal.querySelector('[data-join]').onclick = join;
    codeInput.onkeydown = (e) => {
      if (e.key === 'Enter') join();
      e.stopPropagation();
    };
  }

  /**
   * The online lobby.
   *
   * Re-rendered wholesale on every roster change. That is fine here and not
   * in the scoreboard: this screen updates a handful of times a minute rather
   * than several times a second, and it owns focusable controls whose handlers
   * are simpler to rebind than to reconcile.
   */
  showLobby({
    room, seed, players, selfId, isHost, status, canStart, theme, gates, gateChoices,
    onReady, onStartRace, onNewCourse, onCopyInvite, onLeave, onTheme, onGates,
  }) {
    const me = players.find((p) => p.id === selfId);
    const rows = players.map((p) => `
      <div class="lobby-row${p.id === selfId ? ' me' : ''}">
        <span class="sb-dot" style="background:#${p.color.toString(16).padStart(6, '0')}"></span>
        <span class="lobby-name">${escapeHtml(p.name)}${p.host ? ' <i>host</i>' : ''}</span>
        <span class="lobby-state ${p.ready ? 'on' : ''}">${p.ready ? 'Ready' : 'Waiting'}</span>
      </div>
    `).join('');

    const statusText = {
      connecting: 'Connecting…',
      reconnecting: 'Reconnecting…',
      connected: `${players.length} of 8 in the lobby`,
      disconnected: 'Connection lost — retrying',
      failed: 'Could not reach the relay',
      rejected: 'That room is full',
    }[status] ?? status;

    const modal = this._openModal(`
      <div class="card">
        <div class="tag">Online lobby</div>
        <h2>Room <span style="color:var(--accent);font-family:var(--mono)">${escapeHtml(room)}</span></h2>
        <p style="margin-bottom:14px">${statusText}</p>

        <div class="field">
          <div class="label">Invite link</div>
          <div class="row"><button data-invite>Copy invite link</button></div>
        </div>

        <div class="field">
          <div class="label">Course</div>
          <div class="row">
            ${isHost
              ? '<button data-newcourse>Roll a new course</button>'
              : '<span style="font-size:11.5px;color:var(--dim)">Chosen by the host</span>'}
          </div>
        </div>

        <div class="field">
          <div class="label">Checkpoints</div>
          ${isHost
            ? HUD._segmented('gates', gateChoices.map((n) => ({ value: n, label: n })), gates)
            : `<div class="lobby-fixed">${gates} &mdash; set by the host</div>`}
        </div>

        <div class="field">
          <div class="label">Lighting</div>
          ${isHost
            ? HUD._segmented('theme', [
              { value: 'night', label: 'Night' },
              { value: 'day', label: 'Day' },
            ], theme)
            : `<div class="lobby-fixed">${theme === 'day' ? 'Day' : 'Night'} &mdash; set by the host</div>`}
        </div>

        <div class="label">Pilots</div>
        <div class="lobby-rows">${rows}</div>

        <div class="row">
          ${isHost
            ? `<button class="primary" data-startrace ${canStart ? '' : 'disabled'}>
                 Start race${canStart ? '' : ' — waiting for everyone'}
               </button>`
            : `<button class="primary" data-ready>${me?.ready ? 'Not ready' : "I'm ready"}</button>`}
          <button data-leave>Leave</button>
        </div>
      </div>
    `);

    modal.querySelector('[data-invite]').onclick = async (e) => {
      const copied = await onCopyInvite();
      e.target.textContent = copied ? 'Copied' : 'Copy failed';
      setTimeout(() => { e.target.textContent = 'Copy invite link'; }, 1600);
    };
    modal.querySelector('[data-leave]').onclick = onLeave;

    if (isHost) {
      modal.querySelector('[data-newcourse]').onclick = () => onNewCourse();
      HUD._bindSegmented(modal, 'gates', (v) => onGates(Number(v)));
      HUD._bindSegmented(modal, 'theme', (v) => onTheme(v));
      const startBtn = modal.querySelector('[data-startrace]');
      if (canStart) startBtn.onclick = onStartRace;
    } else {
      modal.querySelector('[data-ready]').onclick = () => onReady(!me?.ready);
    }
  }

  /**
   * @param {object} o
   * @param {?object} o.compare the best that stood *before* this run, so a
   *        record run is measured against what it beat rather than itself
   */
  showFinish({
    time, isRecord, splits, best, compare, seed, position, fieldSize,
    canSpectate, onSpectate, onRestart, onNewTrack, onMainMenu,
  }) {
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
          ${place}${splits.length} gates. ${verdict}
        </p>
        <div class="splits">${rows}</div>
        <div class="row">
          <button class="primary" data-restart>Same track</button>
          <button data-new>New track</button>
          ${canSpectate ? '<button data-watch>Watch the field</button>' : ''}
          <button data-menu>Main menu</button>
        </div>
        ${canSpectate ? `
          <div class="sub-note">
            Watching puts you in another pilot's chase camera. Step through the
            field with the arrows or <b>Enter</b>, and <b>Esc</b> brings these
            results back.
          </div>` : ''}
      </div>
    `);
    modal.querySelector('[data-restart]').onclick = onRestart;
    modal.querySelector('[data-new]').onclick = onNewTrack;
    modal.querySelector('[data-watch]')?.addEventListener('click', () => onSpectate());
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
