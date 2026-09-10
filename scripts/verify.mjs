/**
 * Headless verification for the parts of the game that can be checked without
 * a browser: the flight model, procedural generation, collision and race
 * rules. Run with `npm run verify`.
 *
 * The flyability section is the important one — it drives the real physics
 * with a pursuit autopilot to prove generated courses are actually flyable,
 * rather than only checking that they were generated.
 */
import * as THREE from 'three';
import { DronePhysics } from '../src/drone/DronePhysics.js';
import { Boost } from '../src/drone/Boost.js';
import { DroneModel } from '../src/drone/DroneModel.js';
import {
  generateTrack, clampGateCount, GATE_CHOICES, MIN_GATES, MAX_GATES,
} from '../src/world/TrackGenerator.js';
import { START_SLOTS, startSlot, gridPosition } from '../src/race/Grid.js';
import { PeerView } from '../src/core/Spectator.js';
import { CollisionWorld } from '../src/world/CollisionWorld.js';
import { Race, RaceState } from '../src/race/Race.js';

// Race.js touches localStorage; stub it for the headless run.
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

// Input.js binds to window/document. A tiny event-target stub lets the key
// handling be tested headlessly, which matters: the modifier behaviour below
// is subtle, platform-specific, and impossible to eyeball.
class FakeTarget {
  constructor() { this.handlers = new Map(); }
  addEventListener(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.handlers.get(type)?.delete(fn); }
  emit(type, ev) { for (const fn of this.handlers.get(type) ?? []) fn(ev); }
}
globalThis.document = { addEventListener() {}, removeEventListener() {}, activeElement: null };

const RESPAWN_PROBE = 12;   // longer than a crate's respawn delay

const DT = 1 / 240;
let fails = 0;
const ok = (cond, msg, detail = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${detail ? `  ${detail}` : ''}`);
};

const ZERO = { forward: 0, right: 0, yaw: 0, vertical: 0, boost: 0 };
const run = (body, cmd, seconds, collision = null) => {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) body.step(DT, cmd, collision);
};

console.log('\n=== PHYSICS ===');
{
  const b = new DronePhysics();
  b.reset(new THREE.Vector3(0, 30, 0), 0);
  run(b, ZERO, 8);
  ok(Math.abs(b.position.y - 30) < 0.35, 'hover holds altitude',
     `y=${b.position.y.toFixed(3)} drift=${(b.position.y - 30).toFixed(3)}m over 8s`);
  ok(b.velocity.length() < 0.05, 'hover is settled', `|v|=${b.velocity.length().toFixed(4)}`);
  const att = b.attitude();
  ok(Math.abs(att.pitch) < 0.01 && Math.abs(att.roll) < 0.01, 'hover is level',
     `pitch=${(att.pitch * 57.3).toFixed(2)}° roll=${(att.roll * 57.3).toFixed(2)}°`);
}
{
  // Forward stick must produce forward (−Z) motion and nose-down pitch.
  const b = new DronePhysics();
  b.reset(new THREE.Vector3(0, 30, 0), 0);
  run(b, { forward: 1, right: 0, yaw: 0, vertical: 0 }, 6);
  const att = b.attitude();
  ok(b.position.z < -5, 'W flies forward (−Z)', `z=${b.position.z.toFixed(2)}`);
  ok(att.pitch < -0.4, 'forward stick pitches nose down', `pitch=${(att.pitch * 57.3).toFixed(1)}°`);
  ok(Math.abs(b.position.y - 30) < 2.5, 'altitude held while translating',
     `y=${b.position.y.toFixed(2)}`);
  const top = Math.hypot(b.velocity.x, b.velocity.z);
  ok(top > 10 && top < 22, 'top speed in the racing band',
     `${top.toFixed(1)} m/s = ${(top * 3.6).toFixed(0)} km/h`);
}
{
  const b = new DronePhysics();
  b.reset(new THREE.Vector3(0, 30, 0), 0);
  run(b, { forward: 0, right: 1, yaw: 0, vertical: 0 }, 6);
  ok(b.position.x > 5, 'E strafes right (+X)', `x=${b.position.x.toFixed(2)}`);
  ok(b.attitude().roll < -0.4, 'right stick rolls right',
     `roll=${(b.attitude().roll * 57.3).toFixed(1)}°`);
}
{
  // Keep this short enough that the Euler yaw has not wrapped past π, or the
  // assertion would be testing the wrap rather than the direction.
  const b = new DronePhysics();
  b.reset(new THREE.Vector3(0, 30, 0), 0);
  run(b, { forward: 0, right: 0, yaw: 1, vertical: 0 }, 0.5);
  const yaw = b.attitude().yaw;
  ok(yaw > 0.5 && yaw < Math.PI, 'A yaws left (+Y)',
     `yaw=+${(yaw * 57.3).toFixed(0)}° after 0.5s (target rate 2.6 rad/s)`);

  const b2 = new DronePhysics();
  b2.reset(new THREE.Vector3(0, 30, 0), 0);
  run(b2, { forward: 0, right: 0, yaw: -1, vertical: 0 }, 0.5);
  ok(b2.attitude().yaw < -0.5, 'D yaws right (−Y)',
     `yaw=${(b2.attitude().yaw * 57.3).toFixed(0)}°`);
}
{
  const up = new DronePhysics();
  up.reset(new THREE.Vector3(0, 30, 0), 0);
  run(up, { forward: 0, right: 0, yaw: 0, vertical: 1 }, 4);
  const climb = (up.position.y - 30) / 4;
  ok(climb > 4 && climb < 8, 'K climbs at a usable rate', `${climb.toFixed(2)} m/s avg`);

  const down = new DronePhysics();
  down.reset(new THREE.Vector3(0, 60, 0), 0);
  run(down, { forward: 0, right: 0, yaw: 0, vertical: -1 }, 4);
  const sink = (60 - down.position.y) / 4;
  ok(sink > 3.5 && sink < 9, 'M descends at a controlled rate', `${sink.toFixed(2)} m/s avg`);
  ok(down.velocity.y > -8, 'descent is regulated, not a free fall',
     `vy=${down.velocity.y.toFixed(2)} m/s`);
}
{
  // Recovery: kick the airframe hard and confirm the controller re-levels.
  const b = new DronePhysics();
  b.reset(new THREE.Vector3(0, 40, 0), 0);
  b.omega.set(7, 3, -6);
  run(b, ZERO, 4);
  const att = b.attitude();
  ok(Math.abs(att.pitch) < 0.06 && Math.abs(att.roll) < 0.06,
     'controller recovers from a violent tumble',
     `pitch=${(att.pitch * 57.3).toFixed(2)}° roll=${(att.roll * 57.3).toFixed(2)}°`);
}
{
  // Ground contact must settle rather than jitter or sink through.
  const world = new CollisionWorld([]);
  const b = new DronePhysics();
  b.reset(new THREE.Vector3(0, 8, 0), 0);
  run(b, { forward: 0, right: 0, yaw: 0, vertical: -1 }, 6, world);
  ok(b.position.y > 0.3 && b.position.y < 0.45, 'rests on the ground plane',
     `y=${b.position.y.toFixed(3)} (radius 0.36)`);
}

console.log('\n=== BOOST ===');
{
  // Boost must actually be faster, and must not cost altitude — the whole
  // point of raising thrust alongside tilt is that the drone can hold height
  // at a steeper lean.
  const plain = new DronePhysics();
  plain.reset(new THREE.Vector3(0, 40, 0), 0);
  run(plain, { forward: 1, right: 0, yaw: 0, vertical: 0, boost: 0 }, 8);
  const vPlain = Math.hypot(plain.velocity.x, plain.velocity.z);

  const boosted = new DronePhysics();
  boosted.reset(new THREE.Vector3(0, 40, 0), 0);
  run(boosted, { forward: 1, right: 0, yaw: 0, vertical: 0, boost: 1 }, 8);
  const vBoost = Math.hypot(boosted.velocity.x, boosted.velocity.z);

  ok(vBoost > vPlain * 1.8, 'boost roughly doubles top speed',
     `${(vPlain * 3.6).toFixed(0)} -> ${(vBoost * 3.6).toFixed(0)} km/h (+${((vBoost / vPlain - 1) * 100).toFixed(0)}%)`);

  // Convergence under sustained boost is asserted further down, over a
  // 12-second horizon: leaning to 63° puts a lot of airspeed on the body's
  // vertical axis, and the vertical-hold integrator takes longer than 8 s to
  // wind up against that much drag. What the player actually experiences is
  // the per-reserve cost, checked next.

  // And the number a player actually experiences: height lost over one full
  // reserve. Gate radii are 4.2-5.6 m, so this has to be well inside that.
  const oneReserve = new DronePhysics();
  oneReserve.reset(new THREE.Vector3(0, 40, 0), 0);
  run(oneReserve, { forward: 1, right: 0, yaw: 0, vertical: 0, boost: 1 }, 2.8);
  ok(40 - oneReserve.position.y < 2.5, 'a full boost costs little altitude',
     `${(40 - oneReserve.position.y).toFixed(2)} m lost over the 2.8 s reserve, reaching ${(Math.hypot(oneReserve.velocity.x, oneReserve.velocity.z) * 3.6).toFixed(0)} km/h`);

  // Acceleration, not just terminal speed — this is what a player feels.
  const a1 = new DronePhysics(); a1.reset(new THREE.Vector3(0, 40, 0), 0);
  run(a1, { forward: 1, right: 0, yaw: 0, vertical: 0, boost: 0 }, 1.5);
  const a2 = new DronePhysics(); a2.reset(new THREE.Vector3(0, 40, 0), 0);
  run(a2, { forward: 1, right: 0, yaw: 0, vertical: 0, boost: 1 }, 1.5);
  ok(a2.speed > a1.speed * 1.7, 'boost accelerates far harder off the mark',
     `${a1.speed.toFixed(1)} -> ${a2.speed.toFixed(1)} m/s after 1.5 s`);

  // The vertical integrator's clamp, not thrust, is what decides whether the
  // craft can hold height at full boost lean — the controller can only ask
  // for g + climbKi * climbIClamp of vertical acceleration, so raising
  // maxRotorThrust on its own changes nothing. Guard that it stays adequate.
  const held = new DronePhysics();
  held.reset(new THREE.Vector3(0, 300, 0), 0);
  run(held, { forward: 1, right: 0, yaw: 0, vertical: 0, boost: 1 }, 12);
  ok(Math.abs(held.velocity.y) < 0.2,
     'the vertical hold keeps up with full boost rather than sinking',
     `vy=${held.velocity.y.toFixed(3)} m/s after 12 s at full lean`);

  // A wound-up integrator must not fling the craft upward on release.
  const rel = new DronePhysics();
  rel.reset(new THREE.Vector3(0, 300, 0), 0);
  run(rel, { forward: 1, right: 0, yaw: 0, vertical: 0, boost: 1 }, 3);
  const atRelease = rel.position.y;
  let peak = atRelease;
  for (let i = 0; i < 240 * 4; i++) {
    rel.step(DT, ZERO, null);
    peak = Math.max(peak, rel.position.y);
  }
  ok(peak - atRelease < 4, 'releasing boost does not fling the craft upward',
     `${(peak - atRelease).toFixed(2)} m of overshoot`);
}
{
  const feed = (b, seconds, held) => {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) b.update(DT, held);
  };

  const b = new Boost();
  ok(b.fraction === 1 && !b.locked, 'boost starts full and usable');

  feed(b, 1, true);
  ok(b.active, 'boost engages while held');
  ok(b.fraction > 0.5 && b.fraction < 0.75, 'drains at the configured rate',
     `${(b.fraction * 100).toFixed(0)}% left after 1 s of a 2.8 s reserve`);

  // Hold past the 2.8 s reserve: it should bottom out and lock, not sputter.
  feed(b, 2, true);
  ok(b.fraction === 0 && b.locked && !b.active,
     'drains to empty and locks out rather than sputtering');

  // Keep holding. It recharges, but must stay inhibited *and* keep reporting
  // itself locked, so the HUD does not promise boost that will not fire.
  feed(b, 4, true);
  ok(!b.active && b.locked, 'holding past depletion neither fires nor unlocks',
     `reserve back to ${(b.fraction * 100).toFixed(0)}% but still inhibited`);

  // Release, then press again.
  feed(b, 0.1, false);
  ok(!b.locked, 'releasing after depletion clears the lockout');
  feed(b, 0.5, true);
  ok(b.active, 'releasing and pressing again re-engages');

  // Refill timing from empty.
  const c = new Boost();
  feed(c, 3, true);            // drain it
  feed(c, 0.1, false);         // release
  feed(c, 6.6, false);         // 0.6 s delay + 6 s refill
  ok(c.fraction > 0.98 && !c.locked, 'refills to full in about 6 s',
     `${(c.fraction * 100).toFixed(0)}% and unlocked`);

  // Tapping must not beat holding.
  const tap = new Boost();
  let tapped = 0;
  for (let i = 0; i < Math.round(6 / DT); i++) {
    const held = Math.floor(i * DT * 5) % 2 === 0;   // 0.2 s on, 0.2 s off
    tap.update(DT, held);
    if (tap.active) tapped += DT;
  }
  const hold = new Boost();
  let holdTime = 0;
  for (let i = 0; i < Math.round(6 / DT); i++) {
    hold.update(DT, true);
    if (hold.active) holdTime += DT;
  }
  ok(tapped <= holdTime + 0.05, 'tapping the key is not better than holding it',
     `tapped ${tapped.toFixed(2)} s vs held ${holdTime.toFixed(2)} s over 6 s`);
}

console.log('\n=== INPUT ===');
{
  const { Input } = await import('../src/core/Input.js');
  const target = new FakeTarget();
  const input = new Input(target);
  const key = (type, code, meta = false) => target.emit(type, {
    code, metaKey: meta, ctrlKey: false, altKey: false, shiftKey: false,
    repeat: false, preventDefault() {},
  });
  const held = () => Object.entries({
    fwd: 'forward', back: 'back', yawL: 'yawLeft', yawR: 'yawRight',
    left: 'left', right: 'right', up: 'up', down: 'down', boost: 'boost',
  }).filter(([, a]) => input.isDown(a)).map(([k]) => k).join(',') || '-';

  // Every binding in the scheme, one at a time.
  const bindings = [
    ['KeyW', 'fwd'], ['KeyS', 'back'],
    ['KeyA', 'yawL'], ['KeyD', 'yawR'],
    ['KeyQ', 'left'], ['KeyE', 'right'],
    ['KeyK', 'up'], ['KeyM', 'down'],
    ['ShiftLeft', 'boost'],
  ];
  let allMapped = true;
  const wrong = [];
  for (const [code, expect] of bindings) {
    input._flush();
    key('keydown', code);
    if (held() !== expect) { allMapped = false; wrong.push(`${code}->${held()}`); }
    key('keyup', code);
    if (held() !== '-') { allMapped = false; wrong.push(`${code} stuck`); }
  }
  ok(allMapped, 'every key in the scheme maps to exactly one action and releases',
     wrong.length ? wrong.join(' ') : `${bindings.length} bindings checked`);

  // A realistic combination: climbing, turning and boosting at once.
  input._flush();
  key('keydown', 'KeyW');
  key('keydown', 'KeyA');
  key('keydown', 'KeyK');
  key('keydown', 'ShiftLeft');
  ok(input.isDown('forward') && input.isDown('yawLeft')
     && input.isDown('up') && input.isDown('boost'),
     'forward + yaw + climb + boost all hold together', held());

  // Shift-M produces a different character; matching on physical code is
  // what keeps descend working while boosting.
  input._flush();
  key('keydown', 'ShiftLeft');
  target.emit('keydown', {
    code: 'KeyM', key: 'M', shiftKey: true, metaKey: false, ctrlKey: false,
    altKey: false, repeat: false, preventDefault() {},
  });
  ok(input.isDown('down') && input.isDown('boost'),
     'descend still works while Shift is held for boost', held());

  // Nothing is bound to Cmd or Ctrl any more.
  input._flush();
  key('keydown', 'MetaLeft', true);
  ok(held() === '-', 'Cmd is not a flight control', held());

  // Defensive latching: if Cmd is held anyway, an unreliable keyup must not
  // strand a key, and releasing Cmd must leave nothing stuck.
  input._flush();
  key('keydown', 'KeyW');
  key('keydown', 'MetaLeft', true);
  key('keyup', 'KeyW', true);           // the macOS spurious keyup
  ok(input.isDown('forward'), 'a spurious keyup while Cmd is held is ignored', held());
  key('keyup', 'MetaLeft', false);
  ok(held() === '-', 'releasing Cmd flushes, leaving nothing stuck', held());

  // Respawn lives on 1. Every other tap binding has been removed, so a
  // regression that reintroduced one would be caught here.
  let respawned = 0;
  const seen = [];
  input.on('respawn', () => { respawned++; });
  for (const a of ['restart', 'newTrack', 'camera', 'mute']) {
    input.on(a, () => seen.push(a));
  }
  input._flush();
  key('keydown', 'KeyQ');
  ok(respawned === 0 && input.isDown('left'), 'Q strafes, and triggers nothing else');
  key('keydown', 'Digit1');
  ok(respawned === 1, '1 returns to the last gate');

  for (const code of ['KeyR', 'KeyN', 'KeyC', 'KeyP', 'KeyG']) key('keydown', code);
  ok(seen.length === 0, 'removed bindings fire nothing',
     seen.length ? seen.join(',') : 'R, N, C, P and G are all inert');

  // M is descend, so it must not also mute.
  input._flush();
  key('keydown', 'KeyM');
  ok(input.isDown('down') && seen.length === 0, 'M descends and does not mute');

  input.dispose();
}

console.log('\n=== REMOTE FLEET ===');
{
  const { RemoteFleet, NetworkAdapter } = await import('../src/net/Network.js');
  const scene = { add() {}, remove() {} };
  const fleet = new RemoteFleet(scene);
  const adapter = new NetworkAdapter();
  fleet.attach(adapter);

  const roster = (ids) => adapter.emit('roster', {
    players: ids.map((id) => ({ id, name: id, color: 0x35e6d0 })),
    selfId: 'me',
  });

  roster(['me', 'a', 'b']);
  ok(fleet.count === 2 && !fleet.peers.has('me'),
     'the roster populates the fleet and excludes ourselves', `${fleet.count} peers`);

  roster(['me', 'a']);
  ok(fleet.count === 1 && fleet.peers.has('a') && !fleet.peers.has('b'),
     'a racer dropped from the roster is removed from the fleet');

  // The bug this guards: a state packet already in flight when its sender
  // leaves must not resurrect them as a peer nothing ever removes again.
  adapter.emit('state', { id: 'b', name: 'b', color: 0, p: [1, 2, 3], q: [0, 0, 0, 1] });
  ok(fleet.count === 1 && !fleet.peers.has('b'),
     'a late state packet cannot resurrect a departed racer');

  // A live peer still moves.
  adapter.emit('state', { id: 'a', p: [4, 5, 6], q: [0, 0, 0, 1] });
  ok(fleet.peers.get('a').snapshots.length === 1, 'state from a live peer is still applied');

  // An explicit leave works as before.
  adapter.emit('leave', { id: 'a' });
  ok(fleet.count === 0, 'an explicit leave removes the peer');

  fleet.dispose();
}

console.log('\n=== TRAIL ===');
{
  // The trail is a ring buffer rendered as a line strip. Getting the
  // wrap-around wrong does not fail loudly — it just draws long streaks
  // between samples taken seconds apart. So assert continuity directly:
  // consecutive drawn points must never be further apart than the drone
  // actually moved between samples.
  const model = new DroneModel(0x35e6d0, { trail: true });
  const STEP = 0.25;
  const N = 260;   // comfortably more than two full laps of the 90-slot ring
  const worst = { gap: 0, at: -1, after: -1 };

  for (let i = 0; i < N; i++) {
    model._pushTrail(new THREE.Vector3(i * STEP, 30, 0));   // straight line
    const arr = model.trail.geometry.getAttribute('position').array;
    const count = model.trail.geometry.drawRange.count;
    for (let k = 1; k < count; k++) {
      const dx = arr[k * 3] - arr[(k - 1) * 3];
      const dy = arr[k * 3 + 1] - arr[(k - 1) * 3 + 1];
      const dz = arr[k * 3 + 2] - arr[(k - 1) * 3 + 2];
      const gap = Math.hypot(dx, dy, dz);
      if (gap > worst.gap) { worst.gap = gap; worst.at = k; worst.after = i; }
    }
  }
  ok(worst.gap <= STEP * 1.001, 'trail stays continuous across ring wrap-around',
     `largest gap between adjacent points = ${worst.gap.toFixed(3)} m, step was ${STEP} m`);

  // And it must be monotonic along the path — no jumping backwards.
  const arr = model.trail.geometry.getAttribute('position').array;
  const count = model.trail.geometry.drawRange.count;
  let monotonic = true;
  for (let k = 1; k < count; k++) if (arr[k * 3] <= arr[(k - 1) * 3]) monotonic = false;
  ok(monotonic, 'trail points are ordered oldest to newest',
     `${count} points spanning ${(arr[(count - 1) * 3] - arr[0]).toFixed(2)} m`);

  model.clearTrail();
  ok(model.trail.geometry.drawRange.count === 0, 'clearing the trail empties it');
}

console.log('\n=== TRACK GENERATION ===');
{
  const seeds = Array.from({ length: 60 }, (_, i) => `verify-seed-${i}`);
  let worst = { lateral: 99, reversal: 99, up: 99, down: 99 };
  let gateTotal = 0, structTotal = 0, minGap = Infinity, retries = 0;

  for (const seed of seeds) {
    const t = generateTrack(seed);
    retries += t.attempt ?? 0;
    gateTotal += t.checkpoints.length;
    structTotal += t.structures.length;

    let up = 0, down = 0, lateral = 0, reversal = 0;
    const headings = [];
    for (const cp of t.checkpoints) {
      if (cp.normal.y > 0.55) up++;
      if (cp.normal.y < -0.45) down++;
      const h = new THREE.Vector3(cp.normal.x, 0, cp.normal.z);
      if (h.lengthSq() > 1e-4) headings.push(h.normalize());
    }
    for (let i = 0; i < headings.length; i++) {
      for (let j = i + 1; j < headings.length; j++) {
        const d = headings[i].dot(headings[j]);
        if (d < -0.55) reversal++;
        if (d > -0.4 && d < 0.4) lateral++;
      }
    }
    worst.up = Math.min(worst.up, up);
    worst.down = Math.min(worst.down, down);
    worst.lateral = Math.min(worst.lateral, lateral);
    worst.reversal = Math.min(worst.reversal, reversal);

    // No two gates anywhere on the course may have overlapping rings.
    for (let i = 0; i < t.checkpoints.length; i++) {
      for (let j = i + 1; j < t.checkpoints.length; j++) {
        const a = t.checkpoints[i], b = t.checkpoints[j];
        minGap = Math.min(minGap, a.position.distanceTo(b.position) - a.radius - b.radius);
      }
    }
  }

  ok(worst.up >= 2, 'every seed forces climbing through a gate', `min up-gates = ${worst.up}`);
  ok(worst.down >= 2, 'every seed forces diving through a gate', `min down-gates = ${worst.down}`);
  ok(worst.lateral >= 4, 'every seed forces left/right turns', `min perpendicular pairs = ${worst.lateral}`);
  ok(worst.reversal >= 1, 'every seed forces flying back on itself', `min reversal pairs = ${worst.reversal}`);
  ok(minGap > 1, 'no two gate rings overlap, anywhere on the course',
     `tightest pair = ${minGap.toFixed(1)} m of clear air between rings`);
  console.log(`      avg gates=${(gateTotal / seeds.length).toFixed(1)}  avg structures=${(structTotal / seeds.length).toFixed(0)}  total regen retries=${retries}`);
}
{
  // The racing line itself must be clear of every obstacle.
  const scratch = new THREE.Vector3();
  const dist = (p, box) => {
    const l = scratch.copy(p).sub(box.position).applyQuaternion(box.inverseQuaternion);
    const h = box.halfExtents;
    return Math.hypot(
      Math.max(Math.abs(l.x) - h.x, 0),
      Math.max(Math.abs(l.y) - h.y, 0),
      Math.max(Math.abs(l.z) - h.z, 0));
  };
  let minClear = Infinity;
  let minGateClear = Infinity;
  for (let i = 0; i < 25; i++) {
    const t = generateTrack(`clearance-${i}`);
    const pts = t.curve.getPoints(900);
    for (const box of t.structures) {
      for (const p of pts) minClear = Math.min(minClear, dist(p, box));
      for (const cp of t.checkpoints) {
        minGateClear = Math.min(minGateClear, dist(cp.position, box) - cp.radius);
      }
    }
  }
  ok(minClear > 3.5, 'racing line keeps clearance from obstacles',
     `tightest = ${minClear.toFixed(2)} m (drone radius 0.36)`);
  ok(minGateClear > 1.0, 'no obstacle blocks a gate aperture',
     `tightest = ${minGateClear.toFixed(2)} m outside the ring`);
}

console.log('\n=== GATE VALIDATION ===');
{
  // Sweep the drone along the racing line and confirm every gate registers,
  // in order, exactly once.
  let allPassed = 0, seeds = 20;
  for (let s = 0; s < seeds; s++) {
    const t = generateTrack(`gates-${s}`);
    const race = new Race(t);
    race.begin();
    race.countdown = 0;
    race.update(0.001, t.start.position, t.start.position);

    const N = 6000;
    let prev = t.curve.getPointAt(0);
    for (let i = 1; i <= N; i++) {
      const p = t.curve.getPointAt(i / N);
      race.update(1 / 60, prev, p);
      prev = p;
    }
    if (race.state === RaceState.FINISHED) allPassed++;
  }
  ok(allPassed === seeds, 'sweeping the racing line clears every gate in order',
     `${allPassed}/${seeds} seeds finished`);
}
{
  // Reverse crossing must not count.
  const t = generateTrack('reverse-test');
  const race = new Race(t);
  race.begin();
  race.countdown = 0;
  race.update(0.001, t.start.position, t.start.position);
  const cp = t.checkpoints[0];
  const front = cp.position.clone().addScaledVector(cp.normal, 3);
  const behind = cp.position.clone().addScaledVector(cp.normal, -3);
  race.update(1 / 60, front, behind);   // wrong way
  ok(race.currentIndex === 0, 'flying backwards through a gate does not count');
  race.update(1 / 60, behind, front);   // right way
  ok(race.currentIndex === 1, 'flying forwards through a gate counts');
}
{
  // Tunnelling: one frame that jumps clean past the gate must still register.
  const t = generateTrack('tunnel-test');
  const race = new Race(t);
  race.begin();
  race.countdown = 0;
  race.update(0.001, t.start.position, t.start.position);
  const cp = t.checkpoints[0];
  const a = cp.position.clone().addScaledVector(cp.normal, -40);
  const b = cp.position.clone().addScaledVector(cp.normal, 40);
  race.update(1 / 60, a, b);
  ok(race.currentIndex === 1, 'an 80 m single-frame jump still registers the gate');
}

console.log('\n=== POWER-UPS (feature-flagged off; kept covered) ===');
{
  const { FEATURES } = await import('../src/config.js');
  ok(FEATURES.powerUps === false, 'power-ups are currently switched off',
     'flip FEATURES.powerUps in src/config.js to re-enable');

  const { Effects, applyHit, POWER_UPS, rollPowerUp, FOCUS_TIME_SCALE } =
    await import('../src/race/PowerUps.js');

  const body = new DronePhysics();
  body.reset(new THREE.Vector3(0, 40, 0), 0);
  const fx = new Effects(body);

  ok(body.mods.rotorScale.every((v) => v === 1) && body.mods.dragScale === 1,
     'modifiers start neutral');

  // Rotor jam must reach the mixer, affect exactly one rotor, and swing below
  // the ~0.34 of commanded thrust that holding a hover needs — otherwise the
  // controller simply compensates and nothing is felt.
  fx.add('ROTOR_JAM', 2, { rotor: 2 });
  let lo = Infinity;
  let hi = -Infinity;
  let othersClean = true;
  for (let i = 0; i < 120; i++) {
    fx.update(1 / 120);
    lo = Math.min(lo, body.mods.rotorScale[2]);
    hi = Math.max(hi, body.mods.rotorScale[2]);
    if (body.mods.rotorScale[0] !== 1 || body.mods.rotorScale[1] !== 1
      || body.mods.rotorScale[3] !== 1) othersClean = false;
  }
  ok(othersClean, 'rotor jam affects exactly one of the four rotors');
  ok(lo < 0.34 && hi > 0.8, 'the jammed rotor swings past what a hover needs',
     `delivered thrust ranges ${lo.toFixed(2)}x to ${hi.toFixed(2)}x`);

  // A jam has to be disruptive AND survivable. Both halves matter: a steady
  // rotor cut is either invisible (the controller compensates) or terminal
  // (it flips and never recovers), which is why it is modelled as a
  // fluctuating rotor instead.
  const jammed = new DronePhysics();
  jammed.reset(new THREE.Vector3(0, 60, 0), 0);
  const jfx = new Effects(jammed);
  jfx.add('ROTOR_JAM', 2.4, { rotor: 1 });
  let peakTilt = 0;
  for (let i = 0; i < 240 * 2.4; i++) {
    jfx.update(DT);
    jammed.step(DT, ZERO, null);
    const a = jammed.attitude();
    peakTilt = Math.max(peakTilt, Math.hypot(a.pitch, a.roll) * 57.3);
  }
  const lostAlt = 60 - jammed.position.y;
  ok(peakTilt > 12 && peakTilt < 70, 'a jammed rotor makes the airframe lurch',
     `peak ${peakTilt.toFixed(0)}° off level, ${lostAlt.toFixed(1)} m of altitude`);

  for (let i = 0; i < 240 * 3; i++) { jfx.update(DT); jammed.step(DT, ZERO, null); }
  const settled = Math.hypot(jammed.attitude().pitch, jammed.attitude().roll) * 57.3;
  ok(settled < 2 && !jfx.has('ROTOR_JAM'), 'and is recoverable once it expires',
     `settles to ${settled.toFixed(1)}°`);

  // Effects expire and leave nothing behind.
  fx.clear();
  fx.add('AFTERBURNER', 0.5);
  fx.update(0);
  ok(body.mods.dragScale < 0.5, 'afterburner cuts drag', `x${body.mods.dragScale}`);
  fx.update(0.6);
  ok(!fx.has('AFTERBURNER') && body.mods.dragScale === 1,
     'an expired effect restores its modifier');

  // Afterburner should be a trade, not a straight upgrade: much faster flat
  // out, but it takes far longer to slow down.
  const plain = new DronePhysics(); plain.reset(new THREE.Vector3(0, 60, 0), 0);
  const burn = new DronePhysics(); burn.reset(new THREE.Vector3(0, 60, 0), 0);
  const bfx = new Effects(burn);
  bfx.add('AFTERBURNER', 60);
  const FWD = { forward: 1, right: 0, yaw: 0, vertical: 0, boost: 0 };
  for (let i = 0; i < 240 * 12; i++) {
    plain.step(DT, FWD, null);
    bfx.update(DT); burn.step(DT, FWD, null);
  }
  const vPlain = Math.hypot(plain.velocity.x, plain.velocity.z);
  const vBurn = Math.hypot(burn.velocity.x, burn.velocity.z);
  ok(vBurn > vPlain * 1.3, 'afterburner raises top speed substantially',
     `${(vPlain * 3.6).toFixed(0)} -> ${(vBurn * 3.6).toFixed(0)} km/h`);

  const coastPlain = { ...plain }, coastBurn = { ...burn };
  let tp = 0, tb = 0;
  for (let i = 0; i < 240 * 20 && Math.hypot(plain.velocity.x, plain.velocity.z) > 3; i++) {
    plain.step(DT, ZERO, null); tp += DT;
  }
  for (let i = 0; i < 240 * 20 && Math.hypot(burn.velocity.x, burn.velocity.z) > 3; i++) {
    bfx.update(DT); burn.step(DT, ZERO, null); tb += DT;
  }
  ok(tb > tp, 'and costs you the braking', `coast-down ${tp.toFixed(1)}s vs ${tb.toFixed(1)}s`);

  // A hit kills momentum and adds spin, as an impact does.
  const victim = { body: new DronePhysics(), effects: null };
  victim.body.reset(new THREE.Vector3(0, 50, 0), 0);
  victim.effects = new Effects(victim.body);
  victim.body.velocity.set(12, 0, -4);
  applyHit(victim, 1.5, () => 0.9);
  ok(victim.body.velocity.length() === 0, 'a hit kills all velocity');
  ok(victim.body.omega.length() > 1, 'a hit imparts spin', `|w|=${victim.body.omega.length().toFixed(1)}`);
  victim.effects.update(0);
  ok(victim.body.mods.authority < 0.5, 'a hit degrades control authority',
     `x${victim.body.mods.authority}`);
  victim.effects.update(2);
  ok(victim.body.mods.authority === 1, 'control authority comes back');

  // Focus reports a slowdown, and its own timer is not slowed by it.
  const f = new Effects(new DronePhysics());
  ok(f.timeScale === 1, 'time runs normally with no effects');
  f.add('FOCUS', 2);
  f.update(0);
  ok(f.timeScale === FOCUS_TIME_SCALE && f.timeScale < 1, 'focus slows the world');
  f.update(2.1);
  ok(f.timeScale === 1 && !f.has('FOCUS'), 'focus expires on the real clock');

  // Phase and scramble are read as flags.
  const p2 = new Effects(new DronePhysics());
  p2.add('PHASE', 3); p2.add('SCRAMBLER', 4); p2.update(0);
  ok(p2.collisionOff && p2.scrambled, 'phase and scrambler expose their flags');

  // The drop table must never hand out an offensive item in a solo race.
  const solo = new Set();
  let rngState = 12345;
  const rng = () => { rngState = (rngState * 1103515245 + 12345) % 2147483648; return rngState / 2147483648; };
  for (let i = 0; i < 400; i++) solo.add(rollPowerUp(rng, false));
  const offensive = [...solo].filter((id) => POWER_UPS[id].needsTarget);
  ok(offensive.length === 0, 'solo races never roll a target-seeking item',
     `rolled: ${[...solo].join(', ')}`);

  const withBots = new Set();
  for (let i = 0; i < 400; i++) withBots.add(rollPowerUp(rng, true));
  ok(withBots.size >= 6, 'a contested race rolls the full pool', `${withBots.size} distinct`);
}

console.log('\n=== PICKUPS ===');
{
  const { Pickups, distanceToSegment } = await import('../src/race/Pickups.js');
  const { Bot } = await import('../src/race/Bot.js');
  const stubScene = { add() {}, remove() {} };

  // Geometry first: the swept test must be immune to frame size.
  const track = generateTrack('pickup-geom');
  const pk = new Pickups(stubScene, track);
  ok(pk.items.length > 5, 'crates are placed around the course',
     `${pk.items.length} on a ${track.checkpoints.length}-gate track`);

  const c = pk.items[0].position;
  const near = (dz) => [
    c.clone().add(new THREE.Vector3(0, 0, -dz)),
    c.clone().add(new THREE.Vector3(0, 0, dz)),
  ];
  ok(pk.collect(...near(5)) === 0, 'a pass through a crate collects it');
  pk.reset();
  ok(pk.collect(...near(140)) === 0, 'a 280 m single frame still collects it');
  pk.reset();
  ok(pk.collect(
    c.clone().add(new THREE.Vector3(9, 0, -5)),
    c.clone().add(new THREE.Vector3(9, 0, 5)),
  ) === null, 'a pass well clear of a crate collects nothing');

  pk.reset();
  pk.collect(...near(5));
  ok(pk.items[0].cooldown > 0, 'a collected crate goes on cooldown');
  pk.update(RESPAWN_PROBE);
  ok(pk.items[0].cooldown <= 0, 'and comes back after its cooldown');

  // The property that actually matters: racing the course normally has to
  // pick crates up. Placement that looks reasonable on paper can still sit
  // off the flown line — which is exactly the bug this catches.
  let collected = 0;
  let placed = 0;
  const SEEDS = 4;
  for (let sIdx = 0; sIdx < SEEDS; sIdx++) {
    const t2 = generateTrack(`pickup-line-${sIdx}`);
    const collision = new CollisionWorld(t2.structures);
    const crates = new Pickups(stubScene, t2);
    placed += crates.items.length;

    const bot = new Bot({
      scene: stubScene, track: t2, collision, index: 0, count: 1, color: 0,
    });
    let clock = 0;
    while (clock < 240 && !bot.finished) {
      bot.update(DT, clock, true);
      if (crates.collect(bot._prevPos, bot.body.position) != null) collected++;
      clock += DT;
    }
    crates.dispose();
    bot.dispose();
  }
  const rate = collected / placed;
  ok(rate > 0.6, 'flying the racing line actually collects crates',
     `${collected}/${placed} (${(rate * 100).toFixed(0)}%) across ${SEEDS} seeds`);
}

console.log('\n=== STANDINGS ===');
{
  const { computeStandings, gapToLeader } = await import('../src/race/Standings.js');
  const mk = (name, gate, splits, finished = false, finishTime = null) =>
    ({ id: name, name, color: 0, gate, splits, finished, finishTime });

  // More gates always leads.
  let s1 = computeStandings([mk('a', 3, [1, 2, 3]), mk('b', 5, [1, 2, 3, 4, 5])]);
  ok(s1[0].name === 'b' && s1[0].position === 1, 'more gates cleared leads');

  // Same gate count: earlier split leads.
  let s2 = computeStandings([mk('slow', 4, [1, 2, 3, 9]), mk('fast', 4, [1, 2, 3, 5])]);
  ok(s2[0].name === 'fast', 'on the same gate, the earlier arrival leads');
  ok(gapToLeader(s2[1], s2[0]) === '+4.00', 'gap on the same gate is a time',
     gapToLeader(s2[1], s2[0]));

  // Different gate counts report a gate gap, not a meaningless time.
  let s3 = computeStandings([mk('a', 2, [1, 2]), mk('b', 5, [1, 2, 3, 4, 5])]);
  ok(gapToLeader(s3[1], s3[0]) === '+3g', 'gap across gates is reported in gates',
     gapToLeader(s3[1], s3[0]));

  // Finishers outrank anyone still flying, however far along they are.
  let s4 = computeStandings([
    mk('flying', 15, Array.from({ length: 15 }, (_, i) => i)),
    mk('done', 16, Array.from({ length: 16 }, (_, i) => i), true, 60),
  ]);
  ok(s4[0].name === 'done', 'a finisher outranks a racer still on course');

  let s5 = computeStandings([
    mk('second', 16, [], true, 70), mk('first', 16, [], true, 62),
  ]);
  ok(s5[0].name === 'first' && gapToLeader(s5[1], s5[0]) === '+8.00',
     'finishers are ordered by finish time, with a time gap');

  // Ordering must be stable, or scoreboard rows jitter every frame.
  const tied = [mk('x', 2, [1, 2]), mk('y', 2, [1, 2]), mk('z', 2, [1, 2])];
  const a = computeStandings(tied).map((e) => e.name).join();
  const b = computeStandings([...tied].reverse()).map((e) => e.name).join();
  ok(a === b, 'tied racers order stably regardless of input order', `${a} vs ${b}`);

  ok(computeStandings([mk('solo', 0, [])])[0].position === 1, 'a single racer is first');
}

console.log('\n=== BOTS ===');
{
  const { Bot } = await import('../src/race/Bot.js');
  const stubScene = { add() {}, remove() {} };

  let fieldsFinished = 0;
  let botsFinished = 0;
  let botsTotal = 0;
  const times = [];
  const SEEDS = 6;
  const FIELD = 5;

  for (let sIdx = 0; sIdx < SEEDS; sIdx++) {
    const track = generateTrack(`bots-${sIdx}`);
    const collision = new CollisionWorld(track.structures);
    const bots = Array.from({ length: FIELD }, (_, i) => new Bot({
      scene: stubScene, track, collision, index: i, count: FIELD, color: 0x35e6d0,
    }));

    let t = 0;
    const LIMIT = 300;                       // simulated seconds
    while (t < LIMIT && bots.some((b) => !b.finished)) {
      for (const bot of bots) bot.update(DT, t, true);
      t += DT;
    }

    botsTotal += FIELD;
    const done = bots.filter((b) => b.finished);
    botsFinished += done.length;
    if (done.length === FIELD) fieldsFinished++;
    for (const b of done) times.push(b.finishTime);
    for (const b of bots) b.dispose();
  }

  ok(botsFinished === botsTotal, 'every bot completes every course',
     `${botsFinished}/${botsTotal} across ${SEEDS} seeds`);
  ok(fieldsFinished === SEEDS, 'no field ever strands a bot', `${fieldsFinished}/${SEEDS}`);

  if (times.length) {
    const min = Math.min(...times), max = Math.max(...times);
    const avg = times.reduce((x, y) => x + y, 0) / times.length;
    ok(max - min > 5, 'skill spread produces a field, not a single block',
       `finishes ${min.toFixed(1)}s to ${max.toFixed(1)}s, avg ${avg.toFixed(1)}s`);
  }

  // ── missing gates ──────────────────────────────────────────────────
  // A bot that never fluffs a gate is unbeatable and obviously mechanical.
  // Misses are produced by pushing the approach off-axis and letting the
  // ordinary gate rule decide, so what matters is that intended fumbles
  // actually become misses, that weaker bots miss more, and that a miss
  // costs time without ever stranding anybody.
  {
    const FIELD2 = 5;
    const SEEDS2 = 8;
    let rolled = 0;
    let missed = 0;
    let gateAttempts = 0;
    let allFinished = 0;
    let fieldTotal = 0;
    const perSkill = Array.from({ length: FIELD2 }, () => ({ rolled: 0, missed: 0, times: [] }));

    for (let sIdx = 0; sIdx < SEEDS2; sIdx++) {
      const t2 = generateTrack(`miss-check-${sIdx}`);
      const coll = new CollisionWorld(t2.structures);
      const field = Array.from({ length: FIELD2 }, (_, i) => new Bot({
        scene: stubScene, track: t2, collision: coll, index: i, count: FIELD2, color: 0,
      }));

      // Observe how many fumbles were rolled, to compare against how many
      // actually became misses.
      field.forEach((bot, i) => {
        const original = bot._pickAim.bind(bot);
        bot._pickAim = (cp) => {
          original(cp);
          if (bot._fumbling) { rolled++; perSkill[i].rolled++; }
        };
      });

      let clock = 0;
      while (clock < 400 && field.some((b) => !b.finished)) {
        for (const bot of field) bot.update(DT, clock, true);
        clock += DT;
      }

      gateAttempts += FIELD2 * t2.checkpoints.length;
      field.forEach((bot, i) => {
        fieldTotal++;
        missed += bot.misses;
        perSkill[i].missed += bot.misses;
        if (bot.finished) { allFinished++; perSkill[i].times.push(bot.finishTime); }
        bot.dispose();
      });
    }

    ok(allFinished === fieldTotal, 'bots still all finish once they can miss gates',
       `${allFinished}/${fieldTotal}`);
    ok(missed > 0, 'bots do miss gates', `${missed} misses over ${gateAttempts} gate attempts`);

    const perGate = missed / gateAttempts;
    ok(perGate > 0.03 && perGate < 0.16, 'misses are occasional, not constant',
       `${(perGate * 100).toFixed(1)}% of gates, ${(missed / fieldTotal).toFixed(2)} per race`);

    // An off-axis approach that still clips the ring counts as a pass. Some
    // of those are expected — it is where near-misses come from — but the
    // mechanism is broken if most intended fumbles sail through the middle.
    const landed = missed / Math.max(1, rolled);
    ok(landed > 0.6, 'an intended fumble usually becomes a real miss',
       `${(landed * 100).toFixed(0)}% of ${rolled} rolls landed; the rest clipped the ring and passed`);

    const strong = perSkill[0];
    const weak = perSkill[FIELD2 - 1];
    ok(weak.missed > strong.missed, 'weaker bots miss more than stronger ones',
       `fastest ${strong.missed}, slowest ${weak.missed}`);

    const avg = (arr) => arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);
    ok(avg(weak.times) > avg(strong.times), 'and finish later for it',
       `${avg(strong.times).toFixed(1)}s vs ${avg(weak.times).toFixed(1)}s`);
  }

  // Same seed, same race — the networking plan ships only a seed.
  {
    const runOnce = () => {
      const t2 = generateTrack('bot-determinism');
      const coll = new CollisionWorld(t2.structures);
      const bot = new Bot({
        scene: stubScene, track: t2, collision: coll, index: 2, count: 5, color: 0,
      });
      let clock = 0;
      while (clock < 400 && !bot.finished) { bot.update(DT, clock, true); clock += DT; }
      const out = `${bot.finishTime.toFixed(5)}|${bot.misses}`;
      bot.dispose();
      return out;
    };
    const a = runOnce();
    const b = runOnce();
    ok(a === b, 'a bot race is reproducible from the seed', `${a} twice`);
  }

  // A fumbled gate must be retried cleanly, or a bot could loop on it.
  {
    const t2 = generateTrack('bot-retry');
    const coll = new CollisionWorld(t2.structures);
    const bot = new Bot({
      scene: stubScene, track: t2, collision: coll, index: 0, count: 1, color: 0,
    });
    const cp = t2.checkpoints[0];
    // _watchGate must already match, or _steer treats this as a new gate and
    // re-rolls the aim before the overshoot branch is ever reached.
    bot._watchGate = bot.gate;
    bot._phase = 'commit';
    bot._fumbling = true;
    bot._aimOffset.set(30, 0, 0);
    // Park it well past the plane so the overshoot check fires.
    bot.body.position.copy(cp.position).addScaledVector(cp.normal, 9);
    bot._steer(DT);
    ok(bot.misses === 1 && !bot._fumbling && bot._aimOffset.lengthSq() === 0,
       'overshooting a fumbled gate counts it and clears the bad aim');
    bot.dispose();
  }

  // Bots must be judged by the player's rule, not a looser one.
  const track = generateTrack('bot-rule');
  const collision = new CollisionWorld(track.structures);
  const bot = new Bot({ scene: stubScene, track, collision, index: 0, count: 1, color: 0 });
  const cp = track.checkpoints[0];
  bot.body.position.copy(cp.position).addScaledVector(cp.normal, 3);
  bot._prevPos.copy(cp.position).addScaledVector(cp.normal, -3);
  bot._checkGate(1.5);
  ok(bot.gate === 1 && bot.splits[0] === 1.5,
     'a bot gate crossing is stamped on the shared race clock');
  bot.dispose();
}

console.log('\n=== FLYABILITY (autopilot through the real physics) ===');
{
  // A deliberately simple pursuit autopilot. If this can finish, a human can.
  const fly = (seed, withCollision) => {
    const t = generateTrack(seed);
    const collision = withCollision ? new CollisionWorld(t.structures) : null;
    const body = new DronePhysics();
    body.reset(t.start.position, t.start.yaw);
    const race = new Race(t);
    race.begin();
    race.countdown = 0;

    const prev = new THREE.Vector3();
    const cmd = { forward: 0, right: 0, yaw: 0, vertical: 0, boost: 0 };
    const aim = new THREE.Vector3();
    const to = new THREE.Vector3();
    const want = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const Y = new THREE.Vector3(0, 1, 0);

    // Per-gate approach phase. 'lineup' flies to a staging point on the
    // gate's own axis; 'commit' drives straight through the aperture from
    // there. If a gate is overshot without scoring, we drop back to lineup
    // and try again — without that, the autopilot parks itself just past the
    // gate and stops, which is a flaw in the pilot and not in the course.
    let phase = 'lineup';
    let watching = 0;

    const maxSteps = 240 * 240;   // 240 simulated seconds
    for (let i = 0; i < maxSteps; i++) {
      const cp = race.nextCheckpoint;
      if (!cp) break;
      if (race.currentIndex !== watching) { watching = race.currentIndex; phase = 'lineup'; }

      const ahead = body.position.clone().sub(cp.position).dot(cp.normal);
      aim.copy(cp.position).addScaledVector(cp.normal, phase === 'lineup' ? -15 : 15);

      if (phase === 'lineup') {
        if (body.position.distanceTo(aim) < 5) phase = 'commit';
      } else if (ahead > 5) {
        phase = 'lineup';       // missed it — go back round
      }

      to.copy(aim).sub(body.position);
      const yaw = body.attitude().yaw;
      let yawErr = Math.atan2(-to.x, -to.z) - yaw;
      while (yawErr > Math.PI) yawErr -= Math.PI * 2;
      while (yawErr < -Math.PI) yawErr += Math.PI * 2;
      q.setFromAxisAngle(Y, -yaw);

      // Velocity control, not position control: a proportional controller on
      // position alone has no damping term and just orbits the target.
      const dist = to.length();
      want.copy(to).normalize().multiplyScalar(Math.min(11, dist * 0.85)).sub(body.velocity);
      const local = want.clone().applyQuaternion(q);

      cmd.yaw = Math.max(-1, Math.min(1, yawErr * 2.0));
      cmd.forward = Math.max(-1, Math.min(1, -local.z / 5));
      cmd.right = Math.max(-1, Math.min(1, local.x / 5));
      cmd.vertical = Math.max(-1, Math.min(1, want.y / 3));

      prev.copy(body.position);
      body.step(DT, cmd, collision);
      race.update(DT, prev, body.position);
      if (race.state === RaceState.FINISHED) break;
    }
    return { done: race.state === RaceState.FINISHED, gates: race.currentIndex, total: race.total, time: race.elapsed };
  };

  let clean = 0, dirty = 0, times = [];
  const N = 15;
  for (let i = 0; i < N; i++) {
    const a = fly(`fly-${i}`, false);
    if (a.done) { clean++; times.push(a.time); }
    const b = fly(`fly-${i}`, true);
    if (b.done) dirty++;
    if (!a.done) console.log(`      seed fly-${i}: no-collision run stalled at gate ${a.gates}/${a.total}`);
  }
  ok(clean === N, 'autopilot completes every course (obstacles off)', `${clean}/${N}`);
  ok(dirty >= Math.ceil(N * 0.8), 'courses stay completable with obstacles live',
     `${dirty}/${N} flown start to finish against real collision`);
  if (times.length) {
    const avg = times.reduce((s, x) => s + x, 0) / times.length;
    console.log(`      autopilot lap times: avg ${avg.toFixed(1)}s  min ${Math.min(...times).toFixed(1)}s  max ${Math.max(...times).toFixed(1)}s`);
  }
}

console.log('\n=== COURSE LENGTH ===');
{
  ok(clampGateCount(4) === MIN_GATES && clampGateCount(500) === MAX_GATES,
     'gate count is clamped to the supported range',
     `4 -> ${clampGateCount(4)}, 500 -> ${clampGateCount(500)}`);
  ok(clampGateCount('nonsense') === 16, 'a nonsense gate count falls back to the default',
     String(clampGateCount('nonsense')));

  // Every offered length has to produce exactly that many gates, and has to
  // do it through verification rather than dropping to the unverified
  // fallback — a short deck is where the direction quota is easiest to lose.
  let wrongCount = 0, fellBack = 0, worstUp = 99, worstDown = 99, worstRev = 99;
  for (const gates of GATE_CHOICES) {
    for (let i = 0; i < 25; i++) {
      const t = generateTrack(`len-${gates}-${i}`, gates);
      if (t.checkpoints.length !== gates) wrongCount++;
      // buildTrack only stamps `attempt` on a verified track.
      if (t.attempt === undefined) fellBack++;

      let up = 0, down = 0, rev = 0;
      const headings = [];
      for (const cp of t.checkpoints) {
        if (cp.normal.y > 0.55) up++;
        if (cp.normal.y < -0.45) down++;
        const h = new THREE.Vector3(cp.normal.x, 0, cp.normal.z);
        if (h.lengthSq() > 1e-4) headings.push(h.normalize());
      }
      for (let a = 0; a < headings.length; a++) {
        for (let b = a + 1; b < headings.length; b++) {
          if (headings[a].dot(headings[b]) < -0.55) rev++;
        }
      }
      worstUp = Math.min(worstUp, up);
      worstDown = Math.min(worstDown, down);
      worstRev = Math.min(worstRev, rev);
    }
  }
  ok(wrongCount === 0, 'every offered length builds exactly that many gates',
     `${GATE_CHOICES.join('/')} over 25 seeds each`);
  ok(fellBack === 0, 'no offered length has to use the unverified fallback',
     `${fellBack} fallbacks`);
  ok(worstUp >= 2 && worstDown >= 2 && worstRev >= 1,
     'the six-axis guarantee survives the shortest course',
     `worst case: ${worstUp} climbs, ${worstDown} dives, ${worstRev} reversals`);

  // The shortest course must still be flyable, not merely well-formed.
  const short = generateTrack('short-fly', MIN_GATES);
  ok(short.length > 150, 'a short course is still a course', `${short.length.toFixed(0)} m`);
}

console.log('\n=== STARTING GRID ===');
{
  ok(START_SLOTS.length === 8, 'the grid has one square per palette colour',
     `${START_SLOTS.length} slots`);

  // Two drones on the same square is the bug this replaced, so the squares
  // have to be far enough apart that nobody starts inside anybody else.
  let closest = Infinity;
  for (let i = 0; i < START_SLOTS.length; i++) {
    for (let j = i + 1; j < START_SLOTS.length; j++) {
      const a = START_SLOTS[i], b = START_SLOTS[j];
      closest = Math.min(closest, Math.hypot(a[0] - b[0], a[1] - b[1]));
    }
  }
  // Two 0.36 m radius drones need 0.72 m; anything under a metre would read
  // as overlapping on screen.
  ok(closest > 1.2, 'no two grid squares overlap', `closest pair ${closest.toFixed(2)} m`);

  const track = generateTrack('grid-test');
  const placed = START_SLOTS.map((_, i) => gridPosition(track.start, i));
  let minSep = Infinity;
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      minSep = Math.min(minSep, placed[i].distanceTo(placed[j]));
    }
  }
  ok(minSep > 1.2, 'grid squares stay separated once placed on a track',
     `closest ${minSep.toFixed(2)} m`);
  ok(placed[0].distanceTo(track.start.position) < 1e-6,
     'slot 0 is the track start itself');

  // The grid is laid out in the start heading's frame, so it must rotate
  // with the course rather than always running east-west.
  const rotated = { position: track.start.position.clone(), yaw: track.start.yaw + Math.PI / 2 };
  ok(gridPosition(rotated, 1).distanceTo(placed[1]) > 2,
     'the grid is oriented by the start heading, not by world axes');

  ok(startSlot(-1) === START_SLOTS[7] && startSlot(9) === START_SLOTS[1],
     'slot lookup wraps in both directions');

  // Every square must be clear of the course's own obstacles, or a player
  // would spawn inside a building.
  const collision = new CollisionWorld(track.structures);
  let blocked = 0;
  for (const seed of ['grid-a', 'grid-b', 'grid-c', 'grid-d', 'grid-e']) {
    const t = generateTrack(seed);
    const world = new CollisionWorld(t.structures);
    for (let i = 0; i < START_SLOTS.length; i++) {
      if (world.query(gridPosition(t.start, i), 0.36).length > 0) blocked++;
    }
  }
  ok(blocked === 0, 'no grid square spawns a drone inside geometry',
     `${blocked} blocked of ${5 * START_SLOTS.length}`);
  void collision;
}

console.log('\n=== SPECTATE CAMERA ===');
{
  // A peer arrives as an interpolated transform with no velocity, which the
  // chase camera needs — it leads its look-at point along it. PeerView
  // differentiates it; check the derived value is right, since a wrong one
  // points the camera at empty air ahead of the drone.
  const group = new THREE.Group();
  group.position.set(0, 20, 0);
  const view = new PeerView(group);
  group.position.set(0, 20, -1.5);
  view.update(0.1);
  ok(Math.abs(view.velocity.z + 15) < 1e-6, 'a peer view differentiates velocity',
     `vz=${view.velocity.z.toFixed(3)} m/s`);
  ok(Math.abs(view.speed - 15) < 1e-6, 'a peer view reports speed');

  group.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7);
  ok(Math.abs(view.attitude().yaw - 0.7) < 1e-6,
     'a peer view reports yaw on the same convention as the physics body',
     `yaw=${view.attitude().yaw.toFixed(4)}`);

  // A zero delta must not divide by zero and poison the camera with NaN.
  const before = view.velocity.clone();
  view.update(0);
  ok(Number.isFinite(view.velocity.length()) && view.velocity.equals(before),
     'a zero-length frame leaves the velocity finite and unchanged');
}

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : `${fails} CHECK(S) FAILED`}\n`);
process.exit(fails === 0 ? 0 : 1);
