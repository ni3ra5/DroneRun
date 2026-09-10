/**
 * End-to-end protocol test against a running relay.
 *
 * Start the server first (`npm run dev` in server/), then `npm test`.
 * Uses Node's built-in WebSocket client, so there is no dependency to add.
 */

const BASE = process.env.RELAY ?? 'ws://127.0.0.1:8787';
let fails = 0;
const ok = (cond, msg, detail = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${detail ? `  ${detail}` : ''}`);
};

/** A test client that records every message it receives. */
class Peer {
  constructor(room, name, color) {
    this.name = name;
    this.inbox = [];
    this.ws = new WebSocket(`${BASE}/room/${room}/ws`);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve);
      this.ws.addEventListener('error', reject);
    });
    this.ws.addEventListener('message', (e) => {
      this.inbox.push(JSON.parse(e.data));
    });
    this.color = color;
  }

  send(msg) { this.ws.send(JSON.stringify(msg)); }

  /** Wait for a message matching `t`, or throw after a timeout. */
  async expect(t, timeoutMs = 2500) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.inbox.find((m) => m.t === t);
      if (hit) { this.inbox.splice(this.inbox.indexOf(hit), 1); return hit; }
      if (Date.now() > deadline) throw new Error(`${this.name}: timed out waiting for '${t}'`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  has(t) { return this.inbox.some((m) => m.t === t); }
  close() { try { this.ws.close(); } catch { /* already closed */ } }
}

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const room = `T${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

console.log(`\n=== relay protocol (room ${room}) ===`);

// ── two players join ──────────────────────────────────────────────────
const a = new Peer(room, 'Ana', 0x35e6d0);
await a.ready;
a.send({ t: 'hello', name: 'Ana', color: 0x35e6d0, seed: 'cobalt-drift-417', theme: 'day', gates: 22 });
const welcomeA = await a.expect('welcome');
ok(welcomeA.seed === 'cobalt-drift-417', 'first player sets the course seed', welcomeA.seed);
ok(welcomeA.theme === 'day' && welcomeA.gates === 22,
   'first player also sets the lighting and the course length',
   `${welcomeA.theme}, ${welcomeA.gates} gates`);
ok(welcomeA.host === welcomeA.you, 'first player becomes host');
ok(welcomeA.phase === 'lobby', 'room starts in the lobby');

const b = new Peer(room, 'Bo', 0xff4d7e);
await b.ready;
// Deliberately asks for the opposite of everything the room already agreed.
b.send({ t: 'hello', name: 'Bo', color: 0xff4d7e, theme: 'night', gates: 8 });
const welcomeB = await b.expect('welcome');
ok(welcomeB.seed === 'cobalt-drift-417', 'a later joiner inherits the seed', welcomeB.seed);
ok(welcomeB.theme === 'day' && welcomeB.gates === 22,
   'a later joiner inherits the room settings rather than imposing its own',
   `${welcomeB.theme}, ${welcomeB.gates} gates`);
ok(welcomeB.host === welcomeA.you, 'the host does not change when someone joins');
ok(welcomeB.players.length === 2, 'the newcomer sees everyone already present',
   `${welcomeB.players.length} players`);

const joinSeen = await a.expect('join');
ok(joinSeen.name === 'Bo', 'existing players are told about a join');

// ── ready state ───────────────────────────────────────────────────────
b.send({ t: 'ready', ready: true });
await settle();
let roster = (await a.expect('roster')).players;
while (a.has('roster')) roster = (await a.expect('roster')).players;
const bo = roster.find((p) => p.name === 'Bo');
ok(bo?.ready === true, 'ready state propagates to other players');
ok(roster.find((p) => p.name === 'Ana')?.host === true, 'roster marks the host');

// ── only the host may change the seed or start ────────────────────────
b.send({ t: 'seed', seed: 'bo-was-here' });
await settle();
ok(!a.has('seed'), 'a non-host cannot change the course');

a.send({ t: 'seed', seed: 'nova-ember-763' });
const seedMsg = await b.expect('seed');
ok(seedMsg.seed === 'nova-ember-763', 'the host can change the course', seedMsg.seed);

// ── lighting and course length are the host's too ─────────────────────
b.send({ t: 'theme', theme: 'night' });
b.send({ t: 'gates', gates: 12 });
await settle();
ok(!a.has('theme'), 'a non-host cannot change the lighting');
ok(!a.has('gates'), 'a non-host cannot change the course length');

a.send({ t: 'theme', theme: 'night' });
const themeMsg = await b.expect('theme');
ok(themeMsg.theme === 'night', 'the host can change the lighting', themeMsg.theme);
// The host has to be told as well, so every client applies the change by the
// same path and no client can end up out of step with the room.
const themeEcho = await a.expect('theme');
ok(themeEcho.theme === 'night', 'the host is echoed its own lighting change');

a.send({ t: 'gates', gates: 12 });
const gatesMsg = await b.expect('gates');
ok(gatesMsg.gates === 12, 'the host can change the course length', `${gatesMsg.gates} gates`);
await a.expect('gates');

a.send({ t: 'theme', theme: 'chartreuse' });
a.send({ t: 'gates', gates: 900 });
await settle();
ok(!b.has('theme'), 'a lighting value outside the two themes is rejected');
const clamped = b.has('gates') ? (await b.expect('gates')).gates : null;
ok(clamped === 28, 'an out-of-range course length is clamped, not rejected outright',
   `900 -> ${clamped}`);
a.inbox.length = 0;

b.send({ t: 'start' });
await settle();
ok(!a.has('start'), 'a non-host cannot start the race');

a.send({ t: 'start' });
const startA = await a.expect('start');
const startB = await b.expect('start');
ok(startA.countdownMs === startB.countdownMs && startA.countdownMs > 0,
   'the host starts the race for everyone', `${startA.countdownMs} ms countdown`);

// ── settings freeze once the race is under way ────────────────────────
b.inbox.length = 0;
a.send({ t: 'theme', theme: 'day' });
a.send({ t: 'gates', gates: 8 });
a.send({ t: 'seed', seed: 'mid-race-swap' });
await settle();
ok(!b.has('theme') && !b.has('gates') && !b.has('seed'),
   'the host cannot change the course, its length or the lighting mid-race');

// ── state relay ───────────────────────────────────────────────────────
a.inbox.length = 0;
b.inbox.length = 0;
a.send({ t: 'state', p: [1, 2, 3], q: [0, 0, 0, 1], gate: 4, time: 12.5 });
const relayed = await b.expect('state');
ok(relayed.id === welcomeA.you, 'state packets are tagged with the sender');
ok(relayed.p[0] === 1 && relayed.gate === 4, 'state packets relay intact',
   `p=${relayed.p} gate=${relayed.gate}`);
await settle();
ok(!a.has('state'), 'a sender is not echoed its own state');

a.send({ t: 'event', kind: 'gate', payload: { index: 4 } });
const ev = await b.expect('event');
ok(ev.kind === 'gate' && ev.payload.index === 4, 'race events relay');

// ── back to the lobby ─────────────────────────────────────────────────
a.send({ t: 'lobby' });
await b.expect('lobby');
await settle();
let cleared = (await b.expect('roster')).players;
while (b.has('roster')) cleared = (await b.expect('roster')).players;
ok(cleared.every((p) => !p.ready), 'returning to the lobby clears ready flags');

// ── host migration ────────────────────────────────────────────────────
b.inbox.length = 0;
a.close();
await settle(500);
let afterLeave = null;
while (b.has('roster')) afterLeave = (await b.expect('roster')).players;
ok(afterLeave && afterLeave.length === 1, 'a departure is removed from the roster',
   `${afterLeave?.length} left`);
// Check the identity, not just that entry zero carries the flag — the latter
// is true by construction and would pass even if the host never changed.
ok(afterLeave?.length === 1 && afterLeave[0].name === 'Bo' && afterLeave[0].host === true,
   'the remaining player is promoted to host',
   `host is ${afterLeave?.find((p) => p.host)?.name}`);

// ── colour assignment ─────────────────────────────────────────────────
// Colours are handed out by the room, not chosen by players, so no two
// drones in a lobby can look alike.
{
  const roomC = `C${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const crowd2 = [];
  for (let i = 0; i < 8; i++) {
    const p = new Peer(roomC, `C${i}`, 0);
    await p.ready;
    // Deliberately all ask for the same colour; the room must ignore it.
    p.send({ t: 'hello', name: `C${i}`, color: 0x35e6d0 });
    const w = await p.expect('welcome');
    p.slot = w.yourColorIndex;
    crowd2.push(p);
  }
  const slots = crowd2.map((p) => p.slot);
  ok(new Set(slots).size === 8, 'a full room gets eight distinct colours',
     `slots ${slots.sort((a, b) => a - b).join(',')}`);
  ok(slots.every((n) => Number.isInteger(n) && n >= 0 && n < 8),
     'every assigned slot is within the palette');

  // A departure frees its slot for the next joiner.
  const freed = crowd2[3].slot;
  crowd2[3].close();
  await settle(500);
  const replacement = new Peer(roomC, 'Late', 0);
  await replacement.ready;
  replacement.send({ t: 'hello', name: 'Late' });
  const lateWelcome = await replacement.expect('welcome');
  ok(lateWelcome.yourColorIndex === freed,
     'a departed player frees its colour for the next joiner',
     `reused slot ${lateWelcome.yourColorIndex}`);

  for (const p of [...crowd2, replacement]) p.close();
  await settle(200);
}

// ── capacity ──────────────────────────────────────────────────────────
const crowd = [];
for (let i = 0; i < 7; i++) {
  const p = new Peer(room, `P${i}`, 0x9fe339);
  await p.ready;
  p.send({ t: 'hello', name: `P${i}` });
  await p.expect('welcome');
  crowd.push(p);
}
const extra = new Peer(room, 'Overflow', 0xffffff);
await extra.ready;
const full = await extra.expect('full');
ok(full.max === 8, 'the ninth player is turned away, not silently dropped',
   `max ${full.max}`);

for (const p of [b, extra, ...crowd]) p.close();
await settle(200);

console.log(`\n${fails === 0 ? 'ALL PROTOCOL CHECKS PASSED' : `${fails} CHECK(S) FAILED`}\n`);
process.exit(fails === 0 ? 0 : 1);
