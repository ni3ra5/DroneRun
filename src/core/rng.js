/**
 * Deterministic seeded randomness.
 *
 * Every client that knows the seed generates a byte-identical track, so the
 * network layer only ever has to ship a short seed string instead of geometry.
 */

/** FNV-1a-ish string hash -> 32-bit unsigned int. */
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Mulberry32 — small, fast, good enough distribution for level generation. */
export function makeRng(seed) {
  let a = typeof seed === 'string' ? hashSeed(seed) : seed >>> 0;

  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    float: (min, max) => min + next() * (max - min),
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
    bool: (p = 0.5) => next() < p,
    sign: () => (next() < 0.5 ? -1 : 1),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** Fisher-Yates, in place, returns the same array. */
    shuffle: (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    },
  };
}

const WORDS = [
  'nova', 'flux', 'zephyr', 'onyx', 'cobalt', 'ember', 'vertex', 'lumen',
  'quartz', 'apex', 'drift', 'helix', 'orbit', 'pulse', 'raven', 'solstice',
  'talon', 'vapor', 'wraith', 'zenith', 'cinder', 'delta', 'echo', 'gale',
];

/** Human-shareable seed, e.g. "cobalt-drift-417". */
export function randomSeed() {
  const r = Math.random;
  const w = () => WORDS[Math.floor(r() * WORDS.length)];
  return `${w()}-${w()}-${Math.floor(r() * 900 + 100)}`;
}
