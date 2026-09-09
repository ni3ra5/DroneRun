/**
 * Heading tape across the top of the screen.
 *
 * Drawn to a canvas rather than assembled from DOM nodes: the strip scrolls
 * continuously and would otherwise mean re-laying out ~40 elements every
 * frame. Drawing only the visible arc also makes wrap-around free — there is
 * no seam to special-case at 360°/0°.
 */

const PX_PER_DEG = 2.9;      // ~193° visible across a 560 px tape
const CARDINALS = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };

export class Compass {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas, { width = 560, height = 86 } = {}) {
    this.canvas = canvas;
    this.cssWidth = width;
    this.cssHeight = height;
    this.barHeight = 54;
    this.ctx = canvas.getContext('2d');
    this._dpr = 0;
    this._lastHeading = null;
    this._resize();
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (dpr === this._dpr) return;
    this._dpr = dpr;
    this.canvas.width = Math.round(this.cssWidth * dpr);
    this.canvas.height = Math.round(this.cssHeight * dpr);
    this.canvas.style.width = `${this.cssWidth}px`;
    this.canvas.style.height = `${this.cssHeight}px`;
    this._lastHeading = null;   // force a redraw at the new scale
  }

  /**
   * Convert the drone's yaw to a compass heading.
   * Body forward is −Z at yaw 0, which we call north; yaw is a left-handed
   * turn from the compass's point of view, hence the negation.
   */
  static headingFromYaw(yaw) {
    const deg = -yaw * 180 / Math.PI;
    return ((deg % 360) + 360) % 360;
  }

  /** @param {number} heading degrees, 0 = north */
  draw(heading) {
    this._resize();
    // A tenth of a degree is far below one pixel; skip redundant redraws.
    const q = Math.round(heading * 10) / 10;
    if (q === this._lastHeading) return;
    this._lastHeading = q;

    const ctx = this.ctx;
    const w = this.cssWidth;
    const bar = this.barHeight;
    const mid = w / 2;

    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.clearRect(0, 0, w, this.cssHeight);

    // Tape background, fading out at both ends so ticks don't stop abruptly.
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, 'rgba(8, 13, 23, 0)');
    grad.addColorStop(0.12, 'rgba(8, 13, 23, 0.62)');
    grad.addColorStop(0.88, 'rgba(8, 13, 23, 0.62)');
    grad.addColorStop(1, 'rgba(8, 13, 23, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, bar);

    ctx.strokeStyle = 'rgba(120, 160, 210, 0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, bar - 0.5);
    ctx.lineTo(w, bar - 0.5);
    ctx.stroke();

    const span = w / PX_PER_DEG;
    const first = Math.ceil((heading - span / 2) / 5) * 5;
    const last = heading + span / 2;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let d = first; d <= last; d += 5) {
      // Signed shortest angular distance from the centre of the tape.
      let delta = d - heading;
      if (delta > 180) delta -= 360;
      else if (delta < -180) delta += 360;
      const x = mid + delta * PX_PER_DEG;
      if (x < -20 || x > w + 20) continue;

      // Fade toward the ends of the tape.
      const edge = Math.min(x, w - x);
      const alpha = Math.max(0, Math.min(1, edge / (w * 0.14)));
      const compass = ((d % 360) + 360) % 360;
      const isCardinal = compass % 90 === 0;
      const isMajor = compass % 15 === 0;

      ctx.strokeStyle = `rgba(210, 228, 250, ${(isMajor ? 0.72 : 0.34) * alpha})`;
      ctx.lineWidth = isMajor ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(x, 6);
      ctx.lineTo(x, isMajor ? 17 : 12);
      ctx.stroke();

      if (isCardinal) {
        ctx.fillStyle = `rgba(255, 255, 255, ${0.96 * alpha})`;
        ctx.font = '700 21px ui-monospace, Menlo, monospace';
        ctx.fillText(CARDINALS[compass], x, 34);
      } else if (isMajor) {
        ctx.fillStyle = `rgba(196, 214, 236, ${0.8 * alpha})`;
        ctx.font = '500 12px ui-monospace, Menlo, monospace';
        ctx.fillText(String(compass), x, 33);
      }
    }

    // Centre marker: a pointer hanging below the tape with the exact heading.
    const tipY = bar;
    const boxTop = bar + 9;
    const boxBottom = this.cssHeight - 4;
    const halfW = 25;

    ctx.fillStyle = 'rgba(10, 16, 26, 0.92)';
    ctx.strokeStyle = 'rgba(53, 230, 208, 0.85)';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(mid, tipY);
    ctx.lineTo(mid + 9, boxTop);
    ctx.lineTo(mid + halfW, boxTop);
    ctx.lineTo(mid + halfW, boxBottom);
    ctx.lineTo(mid - halfW, boxBottom);
    ctx.lineTo(mid - halfW, boxTop);
    ctx.lineTo(mid - 9, boxTop);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#e8f1ff';
    ctx.font = '700 15px ui-monospace, Menlo, monospace';
    ctx.fillText(
      String(Math.round(heading) % 360).padStart(3, '0'),
      mid, (boxTop + boxBottom) / 2 + 1,
    );

    // A tick at dead centre, over the tape, so the pointer reads as aligned.
    ctx.strokeStyle = 'rgba(53, 230, 208, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(mid, 4);
    ctx.lineTo(mid, bar - 1);
    ctx.stroke();
  }
}
