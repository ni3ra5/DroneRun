import * as THREE from 'three';
import { makeRng } from '../core/rng.js';

/**
 * Procedural race course.
 *
 * The course is a polyline walked out from a shuffled deck of moves. The deck
 * is seeded with a guaranteed quota of climbs, dives, hard turns and one
 * hairpin, so every generated track forces the player through all six axes of
 * movement — up, down, left, right, forward and back. Generation is verified
 * against that requirement afterwards and retried if altitude clamping ate a
 * move (see `verifyCoverage`).
 *
 * Everything derives from the seed, so two clients with the same seed build
 * byte-identical geometry and the network layer only ships the seed string.
 */

const UP = new THREE.Vector3(0, 1, 0);
const MIN_ALT = 9;
const MAX_ALT = 96;
const MAX_RADIUS = 330;   // keep the course inside a comfortable play area

const DEG = Math.PI / 180;

/**
 * Course length, in gates. The floor is what the direction quota needs: a
 * course shorter than this cannot carry two climbs, two dives and a hairpin
 * as well as an opening run-up, so it would fail verification and fall back
 * to an unverified track. The ceiling is a play-area limit rather than a
 * generator one — the walk is pulled back toward the middle as it wanders,
 * and past this many legs it spends most of its length doing that.
 */
export const MIN_GATES = 8;
export const MAX_GATES = 28;
/** The lengths offered in the UI. */
export const GATE_CHOICES = [8, 12, 16, 22];
export const DEFAULT_GATES = 16;

export function clampGateCount(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_GATES;
  return Math.max(MIN_GATES, Math.min(MAX_GATES, v));
}

export function generateTrack(seed, gateCount = DEFAULT_GATES) {
  const gates = clampGateCount(gateCount);
  // A handful of attempts is always enough; the fallback is still playable.
  for (let attempt = 0; attempt < 12; attempt++) {
    const track = buildTrack(`${seed}#${attempt}`, gates);
    if (verifyTrack(track)) {
      track.seed = seed;
      track.attempt = attempt;
      return track;
    }
  }
  const track = buildTrack(`${seed}#fallback`, gates);
  track.seed = seed;
  return track;
}

/**
 * Build the move deck with its guaranteed direction quota.
 *
 * The quota is dealt in priority order and truncated to fit, so a short
 * course keeps the moves that the six-axis guarantee actually depends on and
 * drops only the surplus. The opening slot is reserved for a straight run-up
 * and the quota is dealt into the remaining slots — overwriting slot 0 after
 * the shuffle instead would silently discard whichever quota card landed
 * there, which a 16-gate deck can absorb and an 8-gate one cannot.
 */
const QUOTA = [
  // What verification requires: two climbs, two dives, a hairpin and a pair
  // of hard turns to put perpendicular legs on the course.
  'up', 'up', 'down', 'down', 'reverse', 'left', 'right',
  // Surplus, for as long as the course has room for it.
  'up', 'down', 'left', 'right',
];

function buildDeck(rng, gateCount) {
  const body = QUOTA.slice(0, gateCount - 1);
  while (body.length < gateCount - 1) {
    body.push(rng.pick(['straight', 'straight', 'left', 'right', 'up', 'down', 'reverse']));
  }
  rng.shuffle(body);

  // Open with a clean run-up so the player can settle before the first gate.
  const deck = ['straight', ...body];

  // Smooth out sequences that are unflyable or just unpleasant: back-to-back
  // hairpins, and any run of three identical vertical moves.
  for (let i = 1; i < deck.length; i++) {
    if (deck[i] === 'reverse' && deck[i - 1] === 'reverse') deck[i] = 'straight';
    if (i >= 2 && deck[i] === deck[i - 1] && deck[i - 1] === deck[i - 2]) {
      deck[i] = deck[i] === 'straight' ? 'left' : 'straight';
    }
  }
  return deck;
}

function buildTrack(seedString, gateCount) {
  const rng = makeRng(seedString);
  const deck = buildDeck(rng, gateCount);

  const p = new THREE.Vector3(0, 24, 0);
  let heading = new THREE.Vector3(0, 0, -1);   // horizontal, unit
  const waypoints = [p.clone()];
  const moves = [];

  for (let i = 0; i < deck.length; i++) {
    let move = deck[i];

    // Altitude guards: convert a move we cannot physically make.
    if (move === 'up' && p.y > MAX_ALT - 34) move = 'down';
    else if (move === 'down' && p.y < MIN_ALT + 30) move = 'up';

    let run = 0;
    let dy = 0;

    switch (move) {
      case 'left':
      case 'right': {
        const dir = move === 'left' ? 1 : -1;   // +Y rotation turns left
        heading.applyAxisAngle(UP, dir * rng.float(55, 95) * DEG);
        run = rng.float(24, 36);
        dy = rng.float(-5, 5);
        break;
      }
      case 'up':
        run = rng.float(10, 16);
        dy = rng.float(21, 32);
        break;
      case 'down':
        run = rng.float(10, 16);
        dy = -rng.float(19, 29);
        break;
      case 'reverse': {
        // A hairpin: turn back on the course, displaced sideways so the
        // return leg does not retrace the outbound one.
        heading.applyAxisAngle(UP, rng.sign() * rng.float(155, 185) * DEG);
        const lateral = new THREE.Vector3().crossVectors(UP, heading).normalize();
        // The offset has to exceed two gate radii with room to spare, or the
        // outbound and return gates end up overlapping rings.
        p.addScaledVector(lateral, rng.sign() * rng.float(30, 44));
        run = rng.float(26, 38);
        dy = rng.float(-7, 7);
        break;
      }
      default:
        run = rng.float(28, 42);
        dy = rng.float(-5, 5);
    }

    // Curl the course back toward the middle if it is wandering off.
    const horizDist = Math.hypot(p.x, p.z);
    if (horizDist > MAX_RADIUS * 0.72) {
      const inward = new THREE.Vector3(-p.x, 0, -p.z).normalize();
      const pull = THREE.MathUtils.clamp((horizDist / MAX_RADIUS - 0.72) * 2.6, 0, 0.8);
      heading.lerp(inward, pull).normalize();
    }

    p.addScaledVector(heading, run);
    p.y = THREE.MathUtils.clamp(p.y + dy, MIN_ALT, MAX_ALT);
    waypoints.push(p.clone());
    moves.push(move);
  }

  const curve = new THREE.CatmullRomCurve3(waypoints, false, 'catmullrom', 0.35);

  // ── gates ──────────────────────────────────────────────────────────────
  // Gates sit at the MIDDLE of each leg, not on the corners, and take their
  // normal from the curve's own tangent there. Both details matter:
  //
  //   · Mid-leg, the smoothed curve is travelling squarely along the leg, so
  //     the gate is guaranteed to be crossable in the forward direction. A
  //     corner-mounted gate can end up anti-aligned with the smoothed path
  //     (badly so at a hairpin, where the curve's local direction is nearly
  //     the reverse of the incoming leg) and become impossible to claim.
  //   · It puts the turn *between* gates rather than at one, so you corner
  //     and then thread — which is how a real race line reads.
  //
  // A CatmullRomCurve3 over n+1 points has n segments and getPoint maps t
  // uniformly across them, so t = (i + 0.5)/n is exactly mid-leg i.
  const legs = waypoints.length - 1;
  const checkpoints = [];
  for (let i = 0; i < legs; i++) {
    const t = (i + 0.5) / legs;
    checkpoints.push({
      index: i,
      t,
      position: curve.getPoint(t),
      normal: curve.getTangent(t).normalize(),
      radius: rng.float(4.2, 5.6),
      move: moves[i],
    });
  }

  // Even with a wide hairpin, smoothing can pull two consecutive mid-leg
  // gates close together. Relax their curve parameters apart along their own
  // legs until every neighbouring pair is comfortably separated. Each gate
  // stays within the middle half of its leg, so it keeps a clean tangent.
  const MIN_GAP = 6;
  for (let pass = 0; pass < 40; pass++) {
    let tightest = 0;
    for (let i = 1; i < checkpoints.length; i++) {
      const a = checkpoints[i - 1];
      const b = checkpoints[i];
      const need = a.radius + b.radius + MIN_GAP;
      const have = a.position.distanceTo(b.position);
      if (have >= need) continue;
      tightest = Math.max(tightest, need - have);
      const step = 0.3 / legs;
      a.t = Math.max((a.index + 0.25) / legs, a.t - step);
      b.t = Math.min((b.index + 0.75) / legs, b.t + step);
    }
    if (tightest === 0) break;
    for (const cp of checkpoints) {
      curve.getPoint(cp.t, cp.position);
      curve.getTangent(cp.t, cp.normal).normalize();
    }
  }

  const startDir = curve.getTangent(0).normalize();
  const start = {
    position: waypoints[0].clone(),
    // Body forward is −Z, so heading (x, z) maps to this yaw.
    yaw: Math.atan2(-startDir.x, -startDir.z),
  };

  const bounds = new THREE.Box3().setFromPoints(waypoints);
  const track = { waypoints, checkpoints, curve, start, bounds, moves, length: 0 };
  track.length = curve.getLength();
  track.structures = generateStructures(rng, track);
  return track;
}

/**
 * Accept or reject a finished course.
 *
 * Two independent things are checked. Direction coverage can be lost to
 * altitude clamping, so the six-axis guarantee is verified rather than
 * assumed. And because the walk can fold back near itself, two gates many
 * legs apart can end up with intersecting rings — legal for the rules, since
 * only the current gate is ever tested, but visually ambiguous to fly. Both
 * are cheaper to reject and regenerate than to repair.
 */
function verifyTrack(track) {
  for (let i = 0; i < track.checkpoints.length; i++) {
    for (let j = i + 1; j < track.checkpoints.length; j++) {
      const a = track.checkpoints[i];
      const b = track.checkpoints[j];
      if (a.position.distanceTo(b.position) < a.radius + b.radius + 2) return false;
    }
  }
  return verifyCoverage(track);
}

function verifyCoverage(track) {
  let up = 0, down = 0, lateral = 0, reversal = 0;
  const headings = [];

  for (const cp of track.checkpoints) {
    if (cp.normal.y > 0.55) up++;
    if (cp.normal.y < -0.45) down++;
    const h = new THREE.Vector3(cp.normal.x, 0, cp.normal.z);
    if (h.lengthSq() > 1e-4) headings.push(h.normalize());
  }

  for (let i = 0; i < headings.length; i++) {
    for (let j = i + 1; j < headings.length; j++) {
      const d = headings[i].dot(headings[j]);
      if (d < -0.55) reversal++;          // one leg flies back against another
      if (d > -0.4 && d < 0.4) lateral++;  // roughly perpendicular legs
    }
  }

  return up >= 2 && down >= 2 && lateral >= 4 && reversal >= 1;
}

// ── obstacle field ───────────────────────────────────────────────────────

/** Shortest distance from a point to an oriented box. 0 when inside. */
function distanceToBox(point, box, scratch) {
  const local = scratch.copy(point).sub(box.position).applyQuaternion(
    box.inverseQuaternion,
  );
  const h = box.halfExtents;
  const dx = Math.max(Math.abs(local.x) - h.x, 0);
  const dy = Math.max(Math.abs(local.y) - h.y, 0);
  const dz = Math.max(Math.abs(local.z) - h.z, 0);
  return Math.hypot(dx, dy, dz);
}

function makeBox(position, halfExtents, quaternion, kind, tint) {
  return {
    position,
    halfExtents,
    quaternion,
    inverseQuaternion: quaternion.clone().invert(),
    kind,
    tint,
  };
}

/**
 * Populate the course with towers, blocks, slabs and gate arches, rejecting
 * anything that would intrude on the racing line's clearance corridor.
 */
function generateStructures(rng, track) {
  const structures = [];
  const scratch = new THREE.Vector3();

  // Dense sample of the racing line, used for all clearance tests.
  const samples = [];
  const sampleCount = 520;
  for (let i = 0; i <= sampleCount; i++) samples.push(track.curve.getPointAt(i / sampleCount));

  const CORRIDOR = 8.5;   // metres of guaranteed free air around the line

  const clears = (box, margin) => {
    for (const s of samples) {
      if (distanceToBox(s, box, scratch) < margin) return false;
    }
    for (const cp of track.checkpoints) {
      if (distanceToBox(cp.position, box, scratch) < cp.radius + 7) return false;
    }
    return true;
  };

  // ── gate arches: framing around gates that sit on a horizontal leg ────
  for (const cp of track.checkpoints) {
    if (Math.abs(cp.normal.y) > 0.2) continue;   // skip climbs and dives
    if (!rng.bool(0.55)) continue;

    // Build the box orientation from an explicit orthonormal basis rather
    // than setFromUnitVectors. The minimal rotation between two vectors gives
    // no guarantee about where the box's X axis ends up, and we depend on it
    // being exactly the horizontal lateral direction — otherwise the lintel
    // tilts and its far end swings down into the gate aperture.
    const lateral = new THREE.Vector3().crossVectors(UP, cp.normal).normalize();
    const yAxis = new THREE.Vector3().crossVectors(cp.normal, lateral).normalize();
    const q = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(lateral, yAxis, cp.normal),
    );

    const offset = cp.radius + 2.6;
    const legH = Math.min(cp.position.y, 14);

    const candidates = [
      // Two uprights, clear of the aperture on either side.
      makeBox(
        cp.position.clone().addScaledVector(lateral, offset).setY(cp.position.y - 1),
        new THREE.Vector3(1.1, legH, 1.1), q.clone(), 'arch', rng.float(0, 1),
      ),
      makeBox(
        cp.position.clone().addScaledVector(lateral, -offset).setY(cp.position.y - 1),
        new THREE.Vector3(1.1, legH, 1.1), q.clone(), 'arch', rng.float(0, 1),
      ),
      // A lintel above it.
      makeBox(
        cp.position.clone().setY(cp.position.y + offset + 1),
        new THREE.Vector3(offset + 2.2, 0.9, 1.1), q.clone(), 'arch', rng.float(0, 1),
      ),
    ];

    for (const c of candidates) {
      // Arches hug their own gate, so the line margin is tighter than for a
      // building — but no arch may ever encroach on any gate's aperture.
      let ok = true;
      for (const s of samples) {
        if (distanceToBox(s, c, scratch) < 4.4) { ok = false; break; }
      }
      if (ok) {
        for (const other of track.checkpoints) {
          if (distanceToBox(other.position, c, scratch) < other.radius + 1.2) { ok = false; break; }
        }
      }
      if (ok) structures.push(c);
    }
  }

  // ── ground towers and blocks ──────────────────────────────────────────
  const pad = 70;
  const min = track.bounds.min, max = track.bounds.max;
  let placed = 0;
  const TARGET = 108;

  for (let attempt = 0; attempt < 2600 && placed < TARGET; attempt++) {
    const kind = rng.next() < 0.42 ? 'tower' : rng.next() < 0.72 ? 'block' : 'slab';
    const x = rng.float(min.x - pad, max.x + pad);
    const z = rng.float(min.z - pad, max.z + pad);
    const yaw = rng.float(0, Math.PI * 2);
    const q = new THREE.Quaternion().setFromAxisAngle(UP, yaw);

    let box;
    if (kind === 'tower') {
      const w = rng.float(4.5, 11);
      const d = rng.float(4.5, 11);
      const h = rng.float(26, 62);
      box = makeBox(new THREE.Vector3(x, h, z), new THREE.Vector3(w, h, d), q, 'tower', rng.float(0, 1));
    } else if (kind === 'block') {
      const w = rng.float(9, 22);
      const d = rng.float(9, 22);
      const h = rng.float(6, 20);
      box = makeBox(new THREE.Vector3(x, h, z), new THREE.Vector3(w, h, d), q, 'block', rng.float(0, 1));
    } else {
      // Floating slab — reads as a bridge or catwalk to duck under or over.
      const w = rng.float(10, 30);
      const d = rng.float(5, 14);
      const y = rng.float(16, 74);
      box = makeBox(new THREE.Vector3(x, y, z), new THREE.Vector3(w, 0.8, d), q, 'slab', rng.float(0, 1));
    }

    if (!clears(box, CORRIDOR)) continue;

    // Avoid stacking obstacles inside one another.
    let overlaps = false;
    for (const other of structures) {
      if (other.kind === 'arch') continue;
      const rSum = other.halfExtents.length() + box.halfExtents.length();
      if (other.position.distanceToSquared(box.position) < rSum * rSum * 0.28) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) continue;

    structures.push(box);
    placed++;
  }

  return structures;
}
