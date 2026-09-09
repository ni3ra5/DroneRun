import './style.css';
import { Game } from './core/Game.js';
import { randomSeed } from './core/rng.js';
import { readSeed, readRoom } from './core/link.js';

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

function savedName() {
  try {
    const n = localStorage.getItem('dronerun.name');
    return n && n.trim() ? n.trim().slice(0, 16) : null;
  } catch {
    return null;
  }
}

const canvas = document.getElementById('scene');
const overlay = document.getElementById('overlay');

try {
  window.game = new Game({
    canvas,
    overlay,
    seed: readSeed() ?? randomSeed(),
    theme: savedTheme(),
    botCount: savedBotCount(),
    name: savedName(),
  });
  // An invite link lands straight in the lobby.
  const room = readRoom();
  if (room) window.game.goOnline(room, { create: false });
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
