'use strict';
/**
 * Remembers window size/position between launches. Kept outside the financial
 * document so it is readable before the app is unlocked.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = { width: 1320, height: 860, maximized: false };

function file(userDataPath) {
  return path.join(userDataPath, 'window-state.json');
}

function load(userDataPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(file(userDataPath), 'utf8'));
    return {
      width: clamp(raw.width, 900, 10000, DEFAULTS.width),
      height: clamp(raw.height, 600, 10000, DEFAULTS.height),
      x: Number.isInteger(raw.x) ? raw.x : undefined,
      y: Number.isInteger(raw.y) ? raw.y : undefined,
      maximized: !!raw.maximized,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(userDataPath, win) {
  try {
    if (!win || win.isDestroyed()) return;
    const maximized = win.isMaximized();
    const b = maximized ? win.getNormalBounds() : win.getBounds();
    fs.writeFileSync(
      file(userDataPath),
      JSON.stringify({ width: b.width, height: b.height, x: b.x, y: b.y, maximized }),
      'utf8'
    );
  } catch {
    /* non-fatal */
  }
}

function clamp(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

module.exports = { load, save, DEFAULTS };
