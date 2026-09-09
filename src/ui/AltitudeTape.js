/**
 * Vertical altitude tape down the right-hand side.
 *
 * Same reasoning as the compass: a canvas, redrawn only when the value has
 * changed by enough to move a pixel. The tape scrolls so that the current
 * altitude always sits at the centre pointer, which is how an aircraft
 * altimeter tape reads.
 */

const PX_PER_M = 3.0;        // 360 px tape spans 120 m
const TICK_EVERY = 5;
const LABEL_EVERY = 25;

export class AltitudeTape {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas, { width = 82, height = 360 } = {}) {
    this.canvas = canvas;
    this.cssWidth = width;
    this.cssHeight = height;
    this.tapeLeft = 40;      // ticks start here; readout box sits to the left
    this.ctx = canvas.getContext('2d');
    this._dpr = 0;
    this._last = null;
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
    this._last = null;
  }

  /**
   * @param {number} altitude metres above ground
   * @param {number} verticalSpeed m/s, positive up — drives the trend arrow
   */
  draw(altitude, verticalSpeed = 0) {
    this._resize();
    const key = `${Math.round(altitude * 20)}|${Math.round(verticalSpeed * 4)}`;
    if (key === this._last) return;
    this._last = key;

    const ctx = this.ctx;
    const w = this.cssWidth;
    const h = this.cssHeight;
    const mid = h / 2;
    const left = this.tapeLeft;

    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Tape band, faded top and bottom.
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(8, 13, 23, 0)');
    grad.addColorStop(0.14, 'rgba(8, 13, 23, 0.6)');
    grad.addColorStop(0.86, 'rgba(8, 13, 23, 0.6)');
    grad.addColorStop(1, 'rgba(8, 13, 23, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(left, 0, w - left, h);

    ctx.textBaseline = 'middle';

    const span = h / PX_PER_M;
    const first = Math.ceil((altitude - span / 2) / TICK_EVERY) * TICK_EVERY;
    const last = altitude + span / 2;

    for (let a = first; a <= last; a += TICK_EVERY) {
      // Higher altitude is further up the screen.
      const y = mid - (a - altitude) * PX_PER_M;
      if (y < -12 || y > h + 12) continue;
      const edge = Math.min(y, h - y);
      const alpha = Math.max(0, Math.min(1, edge / (h * 0.16)));
      if (a < 0) continue;    // no such thing as negative altitude here

      const major = a % LABEL_EVERY === 0;
      ctx.strokeStyle = `rgba(210, 228, 250, ${(major ? 0.7 : 0.3) * alpha})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(w - (major ? 15 : 9), y + 0.5);
      ctx.lineTo(w - 2, y + 0.5);
      ctx.stroke();

      if (major) {
        ctx.fillStyle = `rgba(196, 214, 236, ${0.82 * alpha})`;
        ctx.font = '500 11px ui-monospace, Menlo, monospace';
        ctx.textAlign = 'right';
        ctx.fillText(String(a), w - 19, y);
      }
    }

    // Ground line, when it is in view — the most useful reference there is.
    const groundY = mid + altitude * PX_PER_M;
    if (groundY > -4 && groundY < h + 4) {
      ctx.strokeStyle = 'rgba(255, 77, 126, 0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(left, groundY);
      ctx.lineTo(w - 2, groundY);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255, 77, 126, 0.95)';
      ctx.font = '700 9px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.fillText('GND', left + 3, groundY - 8);
    }

    // Readout box with a pointer into the tape.
    const boxH = 30;
    const boxTop = mid - boxH / 2;
    ctx.fillStyle = 'rgba(10, 16, 26, 0.94)';
    ctx.strokeStyle = 'rgba(53, 230, 208, 0.85)';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(w - 2, mid);
    ctx.lineTo(w - 12, boxTop);
    ctx.lineTo(0, boxTop);
    ctx.lineTo(0, boxTop + boxH);
    ctx.lineTo(w - 12, boxTop + boxH);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#e8f1ff';
    ctx.font = '700 16px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(String(Math.round(altitude)), w - 20, mid + 1);
    ctx.fillStyle = 'rgba(125, 139, 166, 0.95)';
    ctx.font = '500 9px ui-monospace, Menlo, monospace';
    ctx.fillText('m', w - 14, mid + 1);

    // Climb / sink trend arrow beside the readout.
    if (Math.abs(verticalSpeed) > 0.4) {
      const up = verticalSpeed > 0;
      ctx.fillStyle = up ? 'rgba(53, 230, 208, 0.95)' : 'rgba(255, 77, 126, 0.95)';
      const ax = 9;
      const ay = mid + (up ? -1 : 1) * (boxH / 2 + 9);
      ctx.beginPath();
      ctx.moveTo(ax, ay + (up ? -5 : 5));
      ctx.lineTo(ax - 4.5, ay + (up ? 3 : -3));
      ctx.lineTo(ax + 4.5, ay + (up ? 3 : -3));
      ctx.closePath();
      ctx.fill();
      ctx.font = '500 9px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`${Math.abs(verticalSpeed).toFixed(1)}`, ax + 8, ay);
    }
  }
}
