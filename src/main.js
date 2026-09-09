import './style.css';
import { Game } from './core/Game.js';
import { randomSeed } from './core/rng.js';
import { readSeed } from './core/link.js';
import { PLAYER_COLORS } from './drone/DroneModel.js';

function savedTheme() {
  try {
    const t = localStorage.getItem('dronerun.theme');
    return t === 'day' || t === 'night' ? t : 'night';
  } catch {
    return 'night';
  }
}

function savedBotCount() {
  try {
    const n = Number(localStorage.getItem('dronerun.bots'));
    return Number.isInteger(n) && n >= 0 && n <= 7 ? n : 0;
  } catch {
    return 0;
  }
}

function savedColorIndex() {
  try {
    const raw = localStorage.getItem('dronerun.color');
    const i = raw == null ? 0 : Number(raw);
    return Number.isInteger(i) && i >= 0 && i < PLAYER_COLORS.length ? i : 0;
  } catch {
    return 0;
  }
}

const canvas = document.getElementById('scene');
const overlay = document.getElementById('overlay');

try {
  window.game = new Game({
    canvas,
    overlay,
    seed: readSeed() ?? randomSeed(),
    colorIndex: savedColorIndex(),
    theme: savedTheme(),
    botCount: savedBotCount(),
  });
} catch (err) {
  console.error(err);
  overlay.innerHTML = `
    <div id="modal">
      <div class="card">
        <div class="tag">Unable to start</div>
        <h2>WebGL failed to initialise</h2>
        <p>${err instanceof Error ? err.message : String(err)}</p>
        <p>This game needs hardware-accelerated WebGL 2. Check that it is
        enabled in your browser settings, then reload.</p>
      </div>
    </div>`;
}
