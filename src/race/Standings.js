/**
 * Live race order.
 *
 * Kept as a pure function over plain data so it can be tested without a
 * scene, a renderer or a clock — the ordering rules are fiddly enough that
 * they deserve that.
 *
 * Order, most-leading first:
 *   1. Finishers ahead of everyone still flying, earliest finish first.
 *   2. Otherwise whoever has cleared more gates.
 *   3. On the same gate count, whoever got there sooner.
 *
 * @typedef {object} Entry
 * @property {string} id
 * @property {string} name
 * @property {number} color
 * @property {number} gate    gates cleared so far
 * @property {number[]} splits elapsed time at each gate cleared
 * @property {boolean} finished
 * @property {?number} finishTime
 * @property {boolean} [isPlayer]
 */

/** @param {Entry[]} entries @returns {(Entry & {position: number})[]} */
export function computeStandings(entries) {
  const ranked = [...entries].sort((a, b) => {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (a.finished && b.finished) return (a.finishTime ?? 0) - (b.finishTime ?? 0);
    if (a.gate !== b.gate) return b.gate - a.gate;

    // Same gate count: the one who reached it earlier is ahead. A racer with
    // no split for it yet (only possible at gate 0) sorts last.
    const ta = a.gate > 0 ? a.splits[a.gate - 1] ?? Infinity : Infinity;
    const tb = b.gate > 0 ? b.splits[b.gate - 1] ?? Infinity : Infinity;
    if (ta !== tb) return ta - tb;
    return a.name.localeCompare(b.name);   // stable, so rows never jitter
  });
  return ranked.map((e, i) => ({ ...e, position: i + 1 }));
}

/**
 * Human-readable gap from a racer to the leader.
 * Time when they are on the same gate, gates when they are not — a gap in
 * seconds is meaningless between racers at different points on the course.
 *
 * @returns {string} '' for the leader
 */
export function gapToLeader(entry, leader) {
  if (entry === leader || entry.position === 1) return '';

  if (entry.finished && leader.finished) {
    return `+${((entry.finishTime ?? 0) - (leader.finishTime ?? 0)).toFixed(2)}`;
  }
  if (leader.gate !== entry.gate) {
    const behind = leader.gate - entry.gate;
    return `+${behind}g`;
  }
  const mine = entry.splits[entry.gate - 1];
  const theirs = leader.splits[leader.gate - 1];
  if (mine == null || theirs == null) return '';
  return `+${(mine - theirs).toFixed(2)}`;
}
