import * as THREE from 'three';

import { Input } from './Input.js';
import { CameraRig } from './CameraRig.js';
import { randomSeed, randomPilotName } from './rng.js';
import { readSeed, writeSeed, readRoom, writeRoom, inviteUrl } from './link.js';

import { DronePhysics } from '../drone/DronePhysics.js';
import { DroneModel, PLAYER_COLORS } from '../drone/DroneModel.js';
import { Boost } from '../drone/Boost.js';
import { BoostEffect } from '../drone/BoostEffect.js';
import { Music } from './Music.js';

import { generateTrack } from '../world/TrackGenerator.js';
import { CollisionWorld } from '../world/CollisionWorld.js';
import { Structures } from '../world/Structures.js';
import { Environment, THEMES } from '../world/Environment.js';

import { Race, RaceState } from '../race/Race.js';
import { Bot, botColors } from '../race/Bot.js';
import { computeStandings } from '../race/Standings.js';
import { Pickups } from '../race/Pickups.js';
import { Projectiles } from '../race/Projectiles.js';
import { POWER_UPS, Effects, rollPowerUp, applyHit } from '../race/PowerUps.js';
import { makeRng } from './rng.js';
import { FEATURES, relayUrl, relayConfigured } from '../config.js';
import { Gates } from '../race/Gates.js';

import { HUD } from '../ui/HUD.js';
import { Indicator } from '../ui/Indicator.js';

import { LocalAdapter, RemoteFleet, SEND_HZ, makeStatePacket } from '../net/Network.js';
import { CloudflareAdapter, makeRoomCode } from '../net/CloudflareAdapter.js';

/**
 * Physics runs on a fixed 240 Hz step, decoupled from the render rate. A
 * flight controller with gains this stiff is not stable at a variable 60 Hz
 * step, and a fixed step is also what makes replays and multiplayer agree.
 */
const FIXED_DT = 1 / 240;
const MAX_SUBSTEPS = 30;

const SOFT_BOUND = 520;   // metres from origin: warn
const HARD_BOUND = 820;   // metres from origin: return to last gate

export class Game {
  constructor({ canvas, overlay, seed, colorIndex = 0, theme = 'night', botCount = 0, name = null }) {
    this.canvas = canvas;
    this.seed = seed || randomSeed();
    this.colorIndex = colorIndex;
    this.theme = THEMES[theme] ? theme : 'night';
    /**
     * Whether the current seed was deliberately chosen — from a link, or
     * typed into the seed field — as opposed to generated for us.
     *
     * Starting a solo race normally rolls a brand new course, so no two runs
     * are the same. But a seed someone went to the trouble of sharing should
     * still be raceable, so an explicit one is honoured for its first start.
     */
    this._seedIsExplicit = Boolean(readSeed());
    this.botCount = Math.max(0, Math.min(7, botCount | 0));
    this.bots = [];

    this._buildRenderer();

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 2400);
    this._onResize();
    this.environment = new Environment(this.scene, this.renderer, this.theme);
    this.rig = new CameraRig(this.camera);

    this.body = new DronePhysics();
    this.boost = new Boost();
    this.effects = new Effects(this.body);
    this.projectiles = FEATURES.powerUps ? new Projectiles(this.scene) : null;
    this.held = null;            // power-up in hand, one at a time
    this._pickupRng = makeRng('pickup-rolls').next;
    this.boostFx = new BoostEffect(this.scene, 0xbfefff);
    this.music = new Music('/BG.mp3', { volume: 0.5 });
    this.model = new DroneModel(PLAYER_COLORS[this.colorIndex].hex).addTo(this.scene);

    this.hud = new HUD(overlay);
    this.indicator = new Indicator();
    this.input = new Input();

    // Networking seam — a no-op adapter today, see net/Network.js.
    // The name is what other players see, in the lobby and above their
    // drones. The local scoreboard still says "You" — that is clearer
    // mid-race than reading your own callsign back at you.
    this.identity = {
      id: Math.random().toString(36).slice(2, 10),
      name: name || randomPilotName(),
      color: PLAYER_COLORS[this.colorIndex].hex,
    };
    this.local = new LocalAdapter();
    this.net = this.local;                 // the active adapter
    this.online = null;                    // set while in an online room
    this.lobby = null;                     // latest lobby snapshot for the UI
    /**
     * Race progress for network peers, keyed by id.
     *
     * State packets carry a peer's current gate, and their gate/finish events
     * carry the split times — so standings can rank humans on exactly the
     * same terms as the local player and the bots, rather than leaving them
     * off the board.
     */
    this.peerProgress = new Map();
    this.fleet = new RemoteFleet(this.scene).attach(this.net);
    this.net.connect(this.seed, this.identity);
    this._sendAccum = 0;

    this._prevPos = new THREE.Vector3();
    this._accum = 0;
    this._lastFrame = performance.now();
    this._cmd = { forward: 0, right: 0, yaw: 0, vertical: 0, boost: 0 };
    this._boostVisual = false;
    this._boundWarned = false;
    this._paused = false;
    this._boardAccum = 0;

    this._bindInput();
    this.loadTrack(this.seed);

    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);

    // `resize` alone is not enough: it does not fire when the page is laid
    // out for the first time after load, which is exactly the case that
    // leaves the camera with a NaN aspect. Observing the canvas covers it.
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this._onResize());
      this._resizeObserver.observe(this.canvas.parentElement ?? this.canvas);
    }

    // Pasting a link into an already-open tab only changes the hash, which
    // does not reload the page. Pick it up anyway, or the link silently does
    // nothing for anyone who already has the game open.
    //
    // The room has to be handled as well as the seed: an invite carries both,
    // and looking only at the seed meant pasting a *different* invite loaded
    // that course but left you sitting in the previous room.
    //
    // Note that writeSeed and writeRoom use replaceState, which does not fire
    // hashchange — so this cannot loop back on itself.
    this._onHashChange = () => {
      const room = readRoom();
      if (room && room !== this.online?.room) {
        this.goOnline(room, { create: false });
        return;
      }
      const seed = readSeed();
      if (!seed || seed === this.seed) return;
      this._seedIsExplicit = true;
      this.loadTrack(seed);
      this.showStart();
    };
    window.addEventListener('hashchange', this._onHashChange);

    this.renderer.setAnimationLoop(() => this._frame());
    this.showStart();
  }

  // ── setup ──────────────────────────────────────────────────────────────

  _buildRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const { width, height } = this._viewport();
    this.renderer.setSize(width, height, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
  }

  /**
   * Current drawing size, guarded against a degenerate viewport.
   *
   * A page that is laid out late — a hidden tab or iframe, a panel that sizes
   * itself after load — can report 0x0 here. Feeding that straight into the
   * camera gives `aspect = 0 / 0 = NaN`, which poisons the projection matrix
   * and renders an entirely blank canvas. Worse, `window.resize` does not
   * necessarily fire afterwards to correct it, so the blank canvas is
   * permanent. Fall back to a sane ratio and let the ResizeObserver below
   * fix it up the moment real layout arrives.
   */
  _viewport() {
    const w = window.innerWidth || this.canvas.clientWidth || 0;
    const h = window.innerHeight || this.canvas.clientHeight || 0;
    if (w > 0 && h > 0) return { width: w, height: h };
    return { width: 1280, height: 720 };
  }

  _onResize() {
    const { width, height } = this._viewport();
    this.renderer.setSize(width, height, false);
    const aspect = width / height;
    // Belt and braces: never let a non-finite aspect reach the camera.
    this.camera.aspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
    this.camera.updateProjectionMatrix();
  }

  _bindInput() {
    this.input.on('usePowerUp', () => this.usePowerUp());
    this.input.on('respawn', () => this.respawn());
    this.input.on('pause', () => this.togglePause());
    this.input.on('confirm', () => {
      if (this.race?.state === RaceState.IDLE) this.begin();
    });

    // Mute has no key binding — M is the descend control — so it is driven
    // entirely by the on-screen button.
    this.hud.onMute = () => {
      const muted = this.music.toggleMute();
      this.hud.setMuted(muted);
    };
  }

  // ── track lifecycle ────────────────────────────────────────────────────

  loadTrack(seed) {
    this.seed = seed;

    this.gates?.dispose();
    this.structures?.dispose();

    this.track = generateTrack(seed);
    this.track.seed = seed;
    this.collision = new CollisionWorld(this.track.structures);
    this.structures = new Structures(this.scene, this.track.structures, this.theme);
    this.gates = new Gates(this.scene, this.track);

    this.race = new Race(this.track);
    this.race.onGate = (index, split, delta) => this._onGate(index, split, delta);
    this.race.onFinish = (time, isRecord, prevBest) => this._onFinish(time, isRecord, prevBest);
    this.race.onTick = (n) => this.hud.showCountdown(n);

    this.pickups?.dispose();
    this.pickups = FEATURES.powerUps ? new Pickups(this.scene, this.track) : null;

    this.hud.buildPips(this.track.checkpoints.length);
    this._buildBots();
    this._resetDrone();

    // Keep the seed in the URL so the page is shareable and reloadable.
    writeSeed(seed);
  }

  /**
   * (Re)create the bot field for the current track. Bots hold references to
   * the track and its collision world, so they cannot outlive either.
   */
  _buildBots() {
    for (const bot of this.bots) bot.dispose();
    this.bots = [];
    // Online, the humans in the lobby are the field. Mixing in bots would
    // also mean every client stamping bot splits on its own race clock, so
    // the standings would disagree between players.
    if (this.botCount === 0 || this.online) return;

    const colors = botColors(PLAYER_COLORS, this.colorIndex, this.botCount);
    for (let i = 0; i < this.botCount; i++) {
      this.bots.push(new Bot({
        scene: this.scene,
        track: this.track,
        collision: this.collision,
        index: i,
        count: this.botCount,
        color: colors[i],
      }));
    }
  }

  setBotCount(n) {
    const count = Math.max(0, Math.min(7, n | 0));
    if (count === this.botCount) return;
    this.botCount = count;
    this._buildBots();
    try { localStorage.setItem('dronerun.bots', String(count)); } catch { /* ignore */ }
  }

  _peerProgress(id) {
    let p = this.peerProgress.get(id);
    if (!p) {
      p = { gate: 0, splits: [], finished: false, finishTime: null };
      this.peerProgress.set(id, p);
    }
    return p;
  }

  /** Everyone racing: the local player, any bots, and any network peers. */
  _standings() {
    const entries = [{
      id: 'player',
      name: 'You',
      color: PLAYER_COLORS[this.colorIndex].hex,
      gate: this.race.currentIndex,
      splits: this.race.splits,
      finished: this.race.state === RaceState.FINISHED,
      finishTime: this.race.state === RaceState.FINISHED ? this.race.elapsed : null,
      isPlayer: true,
    }];
    for (const bot of this.bots) entries.push(bot.progress);
    for (const [id, peer] of this.fleet.peers) {
      const p = this._peerProgress(id);
      entries.push({
        id,
        name: peer.name ?? 'Pilot',
        color: peer.model.color.getHex(),
        gate: p.gate,
        splits: p.splits,
        finished: p.finished,
        finishTime: p.finishTime,
      });
    }
    return computeStandings(entries);
  }

  _resetDrone() {
    this.body.reset(this.track.start.position, this.track.start.yaw);
    this.boost.reset();
    this.boostFx?.reset();
    this.effects.clear();
    this.projectiles?.clear();
    this.pickups?.reset();
    this.held = null;
    this.hud.setHeld(null);
    for (const bot of this.bots) bot.reset();
    this._prevPos.copy(this.body.position);
    this.model.clearTrail();
    this.rig.reset(this.body);
    this._boundWarned = false;
  }

  /** @param {'day'|'night'} theme */
  setTheme(theme) {
    if (!THEMES[theme] || theme === this.theme) return;
    this.theme = theme;
    this.environment.setTheme(theme);
    this.structures?.setTheme(theme);
    try { localStorage.setItem('dronerun.theme', theme); } catch { /* ignore */ }
  }

  setName(name) {
    const clean = String(name ?? '').trim().slice(0, 16);
    if (!clean || clean === this.identity.name) return;
    this.identity.name = clean;
    try { localStorage.setItem('dronerun.name', clean); } catch { /* ignore */ }
  }

  setColor(index) {
    this.colorIndex = index;
    const hex = PLAYER_COLORS[index].hex;
    this.identity.color = hex;
    this.model.accentMaterial.color.setHex(hex);
    this.model.accentMaterial.emissive.setHex(hex);
    if (this.model.trail) this.model.trail.material.color.setHex(hex);
    try { localStorage.setItem('dronerun.color', String(index)); } catch { /* ignore */ }
  }

  // ── flow ───────────────────────────────────────────────────────────────

  // ── online play ────────────────────────────────────────────────────────

  /**
   * Join or create an online room.
   *
   * The adapter swap is the whole mechanism: `this.net` becomes the relay,
   * the fleet re-attaches to it, and every existing call site — state sent at
   * a fixed rate, gate and finish events, peer drones rendered and
   * interpolated — keeps working untouched.
   */
  async goOnline(code, { create = false, seed = null } = {}) {
    const base = relayUrl();
    if (!base) {
      this.hud.toast('No relay configured', '#ff4d7e');
      return;
    }

    this.online?.disconnect();
    const adapter = new CloudflareAdapter(base);
    this.online = adapter;
    this.net = adapter;
    this.fleet.attach(adapter);

    this.peerProgress.clear();
    this._buildBots();          // clears any bots: online fields are human
    this.lobby = { room: code, status: 'connecting', players: [], selfId: null, isHost: false, seed: seed ?? this.seed };
    this._bindLobby(adapter);
    this._renderLobby();

    try {
      const welcome = await adapter.connect(code, this.identity, { seed: seed ?? this.seed });
      // The room's seed wins: everyone must be on the same course.
      if (welcome.seed && welcome.seed !== this.seed) this.loadTrack(welcome.seed);
      writeRoom(code, welcome.seed ?? this.seed);
      this._renderLobby();
    } catch {
      this._renderLobby();
    }
  }

  _bindLobby(adapter) {
    const refresh = () => this._renderLobby();

    adapter.on('roster', ({ players, selfId, isHost }) => {
      Object.assign(this.lobby, { players, selfId, isHost });
      // Drop progress for anyone no longer in the room, so a departed racer
      // cannot linger on the scoreboard.
      const present = new Set(players.map((p) => p.id));
      for (const id of [...this.peerProgress.keys()]) {
        if (!present.has(id)) this.peerProgress.delete(id);
      }
      refresh();
    });
    adapter.on('status', ({ state }) => {
      this.lobby.status = state;
      refresh();
    });
    adapter.on('seed', ({ seed }) => {
      this.lobby.seed = seed;
      // Never swap the course mid-race; the relay only sends this in a lobby.
      if (this.race.state === RaceState.IDLE && seed !== this.seed) this.loadTrack(seed);
      refresh();
    });
    adapter.on('start', () => {
      // Each client runs its own countdown from here, which is what begin()
      // already does — so the relay's signal maps straight onto it.
      this.begin();
    });
    adapter.on('lobby', () => {
      this.race.reset();
      this._resetDrone();
      this.gates.setNext(0);
      this.music.pause();
      this._renderLobby();
    });
    adapter.on('state', ({ id, gate }) => {
      if (gate == null) return;
      const p = this._peerProgress(id);
      if (gate > p.gate) p.gate = gate;
    });
    adapter.on('event', ({ id, kind, payload }) => {
      const p = this._peerProgress(id);
      if (kind === 'gate' && Number.isFinite(payload?.split)) {
        p.splits[payload.index] = payload.split;
        p.gate = Math.max(p.gate, payload.index + 1);
        return;
      }
      if (kind === 'finish') {
        p.finished = true;
        p.finishTime = payload?.time ?? null;
        const peer = this.fleet.peers.get(id);
        this.hud.toast(`${peer?.name ?? 'A rival'} finished`, '#35e6d0');
      }
    });
    adapter.on('leave', ({ id }) => this.peerProgress.delete(id));
  }

  _renderLobby() {
    if (!this.online || this.race.state !== RaceState.IDLE) return;
    const l = this.lobby;
    const others = l.players.filter((p) => p.id !== l.selfId);
    // A solo host can start whenever; otherwise everyone else must be ready.
    const canStart = l.isHost && others.every((p) => p.ready);

    this.input.enabled = false;
    this.hud.showLobby({
      room: l.room,
      seed: l.seed ?? this.seed,
      players: l.players,
      selfId: l.selfId,
      isHost: l.isHost,
      status: l.status,
      canStart,
      onReady: (ready) => this.online.setReady(ready),
      onStartRace: () => this.online.startRace(),
      onNewCourse: () => this.online.setSeed(randomSeed()),
      onCopyInvite: async () => {
        try {
          await navigator.clipboard.writeText(inviteUrl(l.room, l.seed ?? this.seed));
          return true;
        } catch {
          return false;
        }
      },
      onLeave: () => this.leaveOnline(),
    });
  }

  /** Drop out of the room and go back to solo play. */
  leaveOnline() {
    this.online?.disconnect();
    this.online = null;
    this.lobby = null;
    this.net = this.local;
    this.fleet.attach(this.local);
    this.peerProgress.clear();
    this._buildBots();          // bots come back for solo play
    writeSeed(this.seed);
    this.race.reset();
    this._resetDrone();
    this.gates.setNext(0);
    this.showStart();
  }

  /** Leave a race and return to the start screen. */
  mainMenu() {
    this._paused = false;
    this.hud.setStandings(null, 0);
    if (this.online) {
      // Online, the host controls when everyone comes back, so this is a
      // request rather than a local decision.
      this.race.reset();
      this._resetDrone();
      this.gates.setNext(0);
      this.music.pause();
      if (this.online.isHost) this.online.returnToLobby();
      this._renderLobby();
      return;
    }
    this.race.paused = false;
    this.race.reset();
    this._resetDrone();
    this.gates.setNext(0);
    this.showStart();
  }

  showStart() {
    this.input.enabled = false;
    // The menu is silent; the track starts again with the next round.
    this.music.pause();
    this.hud.setMuted(this.music.muted);
    this.hud.showStart({
      colorIndex: this.colorIndex,
      theme: this.theme,
      botCount: this.botCount,
      online: relayConfigured(),
      name: this.identity.name,
      onName: (n) => this.setName(n),
      onHost: () => this.goOnline(makeRoomCode(), { create: true, seed: this.seed }),
      onJoin: (code) => this.goOnline(code, { create: false }),
      seedIsExplicit: this._seedIsExplicit,
      onStart: () => this.beginFresh(),
      onStartRandom: () => {
        this._seedIsExplicit = false;
        this.loadTrack(randomSeed());
        this.begin();
      },

      onColor: (i) => this.setColor(i),
      onTheme: (t) => this.setTheme(t),
      onBots: (n) => this.setBotCount(n),
    });
  }

  /**
   * Start a solo race, generating a new course unless the seed was chosen
   * deliberately. Online races never come through here — the room's seed is
   * shared, so re-rolling it would put players on different tracks.
   */
  beginFresh() {
    if (!this.online && !this._seedIsExplicit) this.loadTrack(randomSeed());
    // An explicit seed is honoured once; the next start is random again.
    this._seedIsExplicit = false;
    this.begin();
  }

  begin() {
    this.hud.hideModal();
    this.input.enabled = true;
    this._paused = false;
    this._resetDrone();
    for (const p of this.peerProgress.values()) {
      Object.assign(p, { gate: 0, splits: [], finished: false, finishTime: null });
    }
    this.race.begin();
    this.gates.setNext(0);
    // A round always starts from a click or a keypress, so this call sits
    // inside a user gesture and the autoplay policy lets it through.
    this.music.start();
    this.hud.setMuted(this.music.muted);
  }

  restart() {
    this.begin();
  }

  newTrack() {
    this.loadTrack(randomSeed());
    this.begin();
  }

  togglePause() {
    if (this.race.state === RaceState.IDLE || this.race.state === RaceState.FINISHED) return;

    this._paused = !this._paused;
    this.race.paused = this._paused;
    this.input.enabled = !this._paused;

    if (this._paused) {
      this.music.pause();
      this.hud.showPause({
        onResume: () => this.togglePause(),
        onRestart: () => this.restart(),
        onNewTrack: () => this.newTrack(),
        onMainMenu: () => this.mainMenu(),
      });
    } else {
      this.music.resume();
      this.hud.hideModal();
    }
  }

  /**
   * All racers as uniform records, so pickups, projectiles and standings can
   * treat the player and the bots identically.
   */
  _racers() {
    const list = [{
      id: 'player',
      name: 'You',
      body: this.body,
      effects: this.effects,
      prevPos: this._prevPos,
      finished: this.race.state === RaceState.FINISHED,
      gate: this.race.currentIndex,
    }];
    for (const bot of this.bots) {
      list.push({
        id: bot.id,
        name: bot.name,
        body: bot.body,
        effects: bot.effects,
        prevPos: bot._prevPos,
        finished: bot.finished,
        gate: bot.gate,
      });
    }
    return list;
  }

  /** The racer immediately ahead on the course, for target-seeking items. */
  _targetAhead() {
    let best = null;
    let bestGate = -1;
    for (const bot of this.bots) {
      if (bot.finished) continue;
      // Ahead means further along the course; ties broken by proximity.
      if (bot.gate > this.race.currentIndex
        || (bot.gate === this.race.currentIndex && bot.gate > bestGate)) {
        const d = bot.body.position.distanceTo(this.body.position);
        if (!best || bot.gate > bestGate || d < best.body.position.distanceTo(this.body.position)) {
          best = bot;
          bestGate = bot.gate;
        }
      }
    }
    if (best) {
      return {
        id: best.id, name: best.name, body: best.body,
        effects: best.effects, finished: best.finished,
      };
    }
    return null;
  }

  /** Fire whatever is in hand. */
  usePowerUp() {
    if (!FEATURES.powerUps) return;
    if (this.race.state !== RaceState.RACING || this._paused || !this.held) return;
    const def = POWER_UPS[this.held];
    if (!def) { this.held = null; return; }

    const target = def.needsTarget ? this._targetAhead() : null;
    if (def.needsTarget && !target) {
      this.hud.toast('No target ahead', '#ff4d7e');
      return;
    }

    switch (def.id) {
      case 'MISSILE': {
        const dir = this.body.forward;
        this.projectiles.fireMissile(
          this.body.position, dir, target, 'player', def.duration,
        );
        this.hud.toast(`Missile away — ${target.name}`, '#ff4d7e');
        break;
      }
      case 'ROTOR_JAM':
        target.effects.add('ROTOR_JAM', def.duration,
          { rotor: Math.floor(this._pickupRng() * 4) });
        this.hud.toast(`${target.name}: rotor jammed`, '#ffb028');
        break;
      case 'SCRAMBLER':
        target.effects.add('SCRAMBLER', def.duration);
        this.hud.toast(`${target.name}: gate scrambled`, '#a46bff');
        break;
      case 'OVERDRIVE':
        this.boost.level = 1;
        this.boost.locked = false;
        this.hud.toast('Boost refilled', '#9fe339');
        break;
      case 'AFTERBURNER':
        this.effects.add('AFTERBURNER', def.duration);
        this.hud.toast('Afterburner', '#ff7a45');
        break;
      case 'FOCUS':
        this.effects.add('FOCUS', def.duration);
        this.hud.toast('Focus', '#35e6d0');
        break;
      case 'PHASE':
        this.effects.add('PHASE', def.duration);
        this.hud.toast('Phased', '#3d9bff');
        break;
      case 'MINE':
        // Drop it behind, so it threatens whoever is chasing.
        this.projectiles.dropMine(
          this.body.position.clone().addScaledVector(this.body.forward, -3.5),
          'player',
        );
        this.hud.toast('Mine dropped', '#ff2f5e');
        break;
      default:
        break;
    }

    this.held = null;
    this.hud.setHeld(null);
  }

  /** Recover from being wedged in geometry or lost off the map. */
  respawn() {
    if (this.race.state !== RaceState.RACING) return;

    const idx = this.race.currentIndex;
    const target = this.track.checkpoints[idx];

    if (idx === 0) {
      this.body.reset(this.track.start.position, this.track.start.yaw);
    } else {
      const prev = this.track.checkpoints[idx - 1];
      // Sit just past the last gate we cleared, facing the next one.
      const pos = prev.position.clone().addScaledVector(prev.normal, 3.5);
      const aim = target
        ? new THREE.Vector3().subVectors(target.position, pos)
        : prev.normal.clone();
      this.body.reset(pos, Math.atan2(-aim.x, -aim.z));
    }

    this._prevPos.copy(this.body.position);
    this.model.clearTrail();
    this.rig.reset(this.body);
    this._boundWarned = false;
    this.hud.toast('Returned to last gate', '#ffc247');
  }

  _onGate(index, split, delta) {
    this.gates.setNext(index + 1);
    this.hud.showDelta(delta);
    if (index + 1 < this.race.total) this.hud.toast(`Gate ${index + 1} clear`);
    this.net.sendEvent('gate', { index, split });
  }

  _onFinish(time, isRecord, prevBest) {
    this.input.enabled = false;
    this.hud.hideCountdown();
    this.music.fadeOut();

    // Anyone who has not finished by now has been beaten, so the player's
    // place is simply one behind however many already crossed the line.
    const standings = this._standings();
    const position = standings.findIndex((e) => e.isPlayer) + 1;
    this.hud.setStandings(standings, this.race.total);
    this.hud.showFinish({
      time,
      isRecord,
      splits: this.race.splits,
      best: this.race.best,
      compare: prevBest,
      seed: this.seed,
      position,
      fieldSize: standings.length,
      onRestart: () => this.restart(),
      onNewTrack: () => this.newTrack(),
      onMainMenu: () => this.mainMenu(),
    });
    this.net.sendEvent('finish', { time });
  }

  // ── frame ──────────────────────────────────────────────────────────────

  /**
   * Meter the boost reserve, then build this frame's command.
   * Boost is updated here rather than inside _readCommand so it advances on
   * the frame clock exactly once, regardless of how many physics substeps
   * the frame ends up running.
   */
  _readCommand(dt) {
    const c = this._cmd;
    const racing = this.race.state === RaceState.RACING && !this._paused;

    this.boost.update(dt, racing && this.input.isDown('boost'));

    if (!racing) {
      // Hold a stable hover during the countdown, on the menu and after the
      // finish. Zero command means the controller keeps altitude and heading.
      c.forward = c.right = c.yaw = c.vertical = c.boost = 0;
      return c;
    }

    c.forward = this.input.axis('back', 'forward');
    c.right = this.input.axis('left', 'right');
    c.yaw = this.input.axis('yawRight', 'yawLeft');   // ArrowLeft yaws left (+Y)
    c.vertical = this.input.axis('down', 'up');       // ArrowUp / ArrowDown
    c.boost = this.boost.active ? 1 : 0;
    return c;
  }

  /** Make boost legible on the airframe itself, not just on the HUD. */
  _applyBoostVisual() {
    const on = this.boost.active;
    if (on === this._boostVisual) return;
    this._boostVisual = on;
    this.model.accentMaterial.emissiveIntensity = on ? 1.5 : 0.45;
    if (this.model.trail) this.model.trail.material.opacity = on ? 0.9 : 0.5;
  }

  _frame() {
    const now = performance.now();
    let dt = (now - this._lastFrame) / 1000;
    this._lastFrame = now;
    // A backgrounded tab can hand us a multi-second delta; clamp it so the
    // drone doesn't teleport when the player comes back.
    dt = Math.min(dt, 0.1);

    if (!this._paused) this._tick(dt);
    this.renderer.render(this.scene, this.camera);
  }

  _tick(dt) {
    this._prevPos.copy(this.body.position);
    const cmd = this._readCommand(dt);
    this._applyBoostVisual();

    // Effects run on the real clock, so time dilation cannot extend its own
    // duration, and the HUD countdown stays honest.
    this.effects.update(dt);

    // Focus slows the simulation while input keeps arriving at full rate.
    // Scaling the accumulator is all it takes — the fixed step is untouched,
    // so the physics stays exactly as stable as it was.
    const scale = this.effects.timeScale;
    const worldDt = dt * scale;
    const collision = this.effects.collisionOff ? null : this.collision;

    this._accum += worldDt;
    let steps = 0;
    while (this._accum >= FIXED_DT && steps < MAX_SUBSTEPS) {
      this.body.step(FIXED_DT, cmd, collision);
      this._accum -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_SUBSTEPS) this._accum = 0;   // drop the backlog

    // Gate validation uses the whole frame's travel, so a gate can never be
    // tunnelled through no matter how fast the drone is moving.
    this.race.update(worldDt, this._prevPos, this.body.position);

    // Bots run the same physics on the same fixed frame delta, and their
    // splits are stamped from the shared race clock so standings compare
    // like with like.
    const racing = this.race.state === RaceState.RACING;
    for (const bot of this.bots) bot.update(worldDt, this.race.elapsed, racing);

    // Pickups and projectiles share the dilated clock so a slowed world
    // slows everything in it, not just the drone.
    if (FEATURES.powerUps) {
      this.pickups.update(worldDt);
      if (racing) {
        this._collectPickups();
        const hits = this.projectiles.update(worldDt, this._racers(), this._pickupRng);
        for (const hit of hits) this._announceHit(hit);
      }
    }

    this.gates.setScrambled(this.effects.scrambled);

    this.model.update(this.body, dt);
    this.boostFx.update(dt, this.body, this.boost.active);
    this.music.update(dt);
    this.gates.update(dt);
    this.fleet.update(dt);
    this.rig.update(this.body, dt, this.collision);
    this.environment.update(this.body.position);

    this._enforceBounds();
    this._broadcast(dt);
    this._updateHud();

    // Standings refresh at 8 Hz: gaps only move when somebody passes a gate,
    // so there is nothing to gain from doing this every frame. The board is
    // suppressed entirely on the menu — the loop keeps running behind it, and
    // without this guard the panel reappears over the start screen.
    this._boardAccum += dt;
    if (this._boardAccum >= 1 / 8) {
      this._boardAccum = 0;
      const onMenu = this.race.state === RaceState.IDLE;
      this.hud.setStandings(onMenu ? null : this._standings(), this.race.total);
    }
  }

  /** Give a crate to whoever swept through it this frame. */
  _collectPickups() {
    // The player only carries one item, so a crate is wasted if hands are
    // full — leave it standing rather than silently swallowing it.
    if (!this.held) {
      const got = this.pickups.collect(this._prevPos, this.body.position);
      if (got != null) {
        this.held = rollPowerUp(this._pickupRng, this.bots.length > 0);
        const def = POWER_UPS[this.held];
        this.hud.setHeld(def);
        this.hud.toast(`${def.name} — ${def.blurb}`, `#${def.color.toString(16).padStart(6, '0')}`);
      }
    }

    // Bots collect too, and immediately spend self-buffs. They do not fire
    // offensive items: a field that shoots back needs targeting rules of its
    // own, which is a separate piece of work.
    for (const bot of this.bots) {
      if (bot.finished) continue;
      const got = this.pickups.collect(bot._prevPos, bot.body.position);
      if (got == null) continue;
      const roll = rollPowerUp(this._pickupRng, false);
      if (roll === 'OVERDRIVE') { bot.boost.level = 1; bot.boost.locked = false; }
      else bot.effects.add(roll, POWER_UPS[roll].duration ?? 3);
    }
  }

  _announceHit(hit) {
    if (hit.id === 'player') {
      this.hud.toast(hit.kind === 'MINE' ? 'Mine!' : 'Hit!', '#ff4d7e');
      return;
    }
    const bot = this.bots.find((b) => b.id === hit.id);
    if (bot) this.hud.toast(`${bot.name} hit`, '#35e6d0');
  }

  _enforceBounds() {
    const p = this.body.position;
    const dist = Math.hypot(p.x, p.z);

    if (dist > HARD_BOUND) {
      this.respawn();
      return;
    }
    if (dist > SOFT_BOUND && !this._boundWarned) {
      this._boundWarned = true;
      this.hud.toast('Return to the course', '#ff4d7e');
    } else if (dist < SOFT_BOUND * 0.9) {
      this._boundWarned = false;
    }
  }

  _broadcast(dt) {
    if (!this.net.connected) return;
    this._sendAccum += dt;
    if (this._sendAccum < 1 / SEND_HZ) return;
    this._sendAccum = 0;
    this.net.sendState(
      makeStatePacket(this.identity, this.body, this.race.currentIndex, this.race.elapsed),
    );
  }

  _updateHud() {
    const p = this.body.position;
    const v = this.body.velocity;

    this.hud.update({
      time: this.race.state === RaceState.RACING || this.race.state === RaceState.FINISHED
        ? this.race.elapsed
        : 0,
      best: this.race.best?.time ?? null,
      gateIndex: this.race.currentIndex,
      total: this.race.total,
      distance: this.race.distanceToNext(p),
      speed: Math.hypot(v.x, v.z),
      altitude: p.y,
      throttle: this.body.throttle,
      verticalSpeed: v.y,
      boost: this.boost.fraction,
      boostActive: this.boost.active,
      boostLocked: this.boost.locked,
      boostIntensity: this.boostFx.intensity,
      yaw: this.body.attitude().yaw,
      effects: this.effects.list(),
      scrambled: this.effects.scrambled,
    });

    const next = this.effects.scrambled ? null : this.race.nextCheckpoint;
    if (next) {
      this.hud.setChevron(this.indicator.compute(next.position, this.camera, this._viewport()));
    } else {
      this.hud.setChevron({ visible: false });
    }
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('hashchange', this._onHashChange);
    this._resizeObserver?.disconnect();
    this.input.dispose();
    this.online?.disconnect();
    this.fleet.dispose();
    this.boostFx.dispose();
    this.projectiles?.dispose();
    this.pickups?.dispose();
    this.music.dispose();
    for (const bot of this.bots) bot.dispose();
    this.gates?.dispose();
    this.structures?.dispose();
    this.model.dispose();
    this.renderer.dispose();
  }
}
