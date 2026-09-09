/**
 * Live standings panel.
 *
 * Rows are kept and reused per racer rather than rebuilt each update: a
 * `innerHTML` rewrite every frame would drop text selection, restart CSS
 * transitions, and churn the DOM for data that changes only when somebody
 * passes a gate. Each cell is written only when its text actually differs.
 */

import { gapToLeader } from '../race/Standings.js';

export class Scoreboard {
  /** @param {HTMLElement} root */
  constructor(root) {
    this.root = root;
    this.rows = new Map();   // id -> {el, cells:{pos,name,gate,gap}, values:{}}
    this._order = [];
  }

  /** @param {Array} standings from computeStandings @param {number} total gates */
  render(standings, total) {
    const leader = standings[0];
    const present = new Set();

    for (const entry of standings) {
      present.add(entry.id);
      let row = this.rows.get(entry.id);
      if (!row) row = this._createRow(entry);

      const values = {
        pos: String(entry.position),
        name: entry.name,
        gate: entry.finished ? 'FIN' : `${entry.gate}/${total}`,
        gap: entry.position === 1 ? (entry.finished ? 'WON' : 'LEAD') : gapToLeader(entry, leader),
      };
      for (const key of ['pos', 'name', 'gate', 'gap']) {
        if (row.values[key] !== values[key]) {
          row.values[key] = values[key];
          row.cells[key].textContent = values[key];
        }
      }
      row.el.classList.toggle('finished', entry.finished);
    }

    // Drop rows for racers who are no longer in the field. Without this,
    // reducing the bot count leaves the departed bots on the board — rows
    // are cached by id, so nothing else would ever remove them.
    for (const [id, row] of this.rows) {
      if (present.has(id)) continue;
      row.el.remove();
      this.rows.delete(id);
    }

    // Reorder only when the order has actually changed. appendChild moves an
    // existing node, so this is a reorder rather than a rebuild.
    const order = standings.map((e) => e.id);
    if (order.join() !== this._order.join()) {
      this._order = order;
      for (const id of order) this.root.appendChild(this.rows.get(id).el);
    }
  }

  _createRow(entry) {
    const el = document.createElement('div');
    el.className = `sb-row${entry.isPlayer ? ' me' : ''}`;
    el.innerHTML = `
      <span class="sb-pos"></span>
      <span class="sb-dot" style="background:#${entry.color.toString(16).padStart(6, '0')}"></span>
      <span class="sb-name"></span>
      <span class="sb-gate"></span>
      <span class="sb-gap"></span>
    `;
    const row = {
      el,
      cells: {
        pos: el.querySelector('.sb-pos'),
        name: el.querySelector('.sb-name'),
        gate: el.querySelector('.sb-gate'),
        gap: el.querySelector('.sb-gap'),
      },
      values: {},
    };
    this.rows.set(entry.id, row);
    this.root.appendChild(el);
    return row;
  }

  clear() {
    this.rows.clear();
    this._order = [];
    this.root.innerHTML = '';
  }

  setVisible(visible) {
    this.root.parentElement.classList.toggle('hidden', !visible);
  }
}
