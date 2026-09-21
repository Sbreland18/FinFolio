/**
 * Runs the *packaged* build (the app.asar bundle electron-builder produces),
 * not the source tree. This is what catches "works in dev, blank window when
 * installed" problems — most often a path that does not resolve inside asar.
 *
 *   npx electron-builder --linux dir      # or --win dir on Windows
 *   node scripts/e2e-packaged.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const candidates = [
  path.join(root, 'dist', 'linux-unpacked', 'finfolio'),
  path.join(root, 'dist', 'win-unpacked', 'FinFolio.exe'),
  path.join(root, 'dist', 'mac', 'FinFolio.app', 'Contents', 'MacOS', 'FinFolio'),
];
const binary = candidates.find((p) => fs.existsSync(p));
if (!binary) {
  console.error('No packaged build found. Run: npx electron-builder --dir');
  process.exit(1);
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-pkg-'));
const failures = [];
const check = (ok, label) => {
  console[ok ? 'log' : 'error'](`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures.push(label);
};

console.log(`\nPackaged build: ${path.relative(root, binary)}`);

const app = await electron.launch({
  executablePath: binary,
  args: [`--user-data-dir=${userData}`, '--no-sandbox', '--disable-gpu'],
});
const win = await app.firstWindow();
const errors = [];
win.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
win.on('pageerror', (e) => errors.push(e.message));

await win.waitForSelector('.gate-card, .sidebar', { timeout: 30000 });
check(true, 'the renderer loads from inside app.asar');

// A window that loads but is never shown looks exactly like a hung app: the
// process sits in Task Manager and nothing appears. Assert on the window, not
// just on the page.
const windowState = await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0];
  if (!w) return null;
  const b = w.getBounds();
  return { visible: w.isVisible(), minimized: w.isMinimized(), width: b.width, height: b.height };
});
check(windowState !== null, 'a window exists');
check(windowState && windowState.visible === true, 'the window is actually visible on screen');
check(windowState && !windowState.minimized, 'the window is not minimized');
check(
  windowState && windowState.width > 400 && windowState.height > 300,
  `the window has a usable size (${windowState && windowState.width}×${windowState && windowState.height})`
);

const url = win.url();
check(url.startsWith('app://'), `renderer served over the app:// scheme (${url})`);

const styled = await win.evaluate(() =>
  getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)'
);
check(styled, 'stylesheets loaded through the custom protocol');

const modules = await win.evaluate(() => typeof window.finfolio === 'object');
check(modules, 'preload bridge is available');

check(errors.length === 0, `no renderer errors (${errors.slice(0, 2).join(' | ')})`);

// Deliberate probe: reading outside the renderer folder must be refused.
// The page's own CSP (connect-src 'none') stops it first, which is the point —
// the protocol handler's path guard is the second line of defence.
const traversal = await win.evaluate(async () => {
  try {
    const res = await fetch('app://finfolio/../../package.json');
    return res.status;
  } catch {
    return 'blocked';
  }
});
check(traversal === 403 || traversal === 404 || traversal === 'blocked', `reading outside the renderer folder refused (${traversal})`);

await app.close();
fs.rmSync(userData, { recursive: true, force: true });

console.log('');
if (failures.length) {
  console.error(`${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('✓ Packaged build verified.');
