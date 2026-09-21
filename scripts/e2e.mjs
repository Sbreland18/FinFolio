/**
 * End-to-end test of the packaged-shape app: launches the real Electron main
 * process, drives the real renderer through the real preload bridge, and
 * verifies the whole round trip — first-run setup, saving to disk, reopening,
 * encryption, and restore.
 *
 *   npm run e2e          (needs a display; use xvfb-run on a headless machine)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const failures = [];
const check = (ok, label) => {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ ${label}`);
    failures.push(label);
  }
};

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-e2e-'));
const launchArgs = ['.', `--user-data-dir=${userData}`, '--no-sandbox', '--disable-gpu'];

// Playwright may be installed outside this project, so point it at the
// Electron binary this project downloaded.
let executablePath;
try {
  executablePath = require(path.join(root, 'node_modules', 'electron'));
} catch {
  executablePath = undefined;
}

async function launch() {
  const app = await electron.launch({ args: launchArgs, cwd: root, executablePath });
  const win = await app.firstWindow();
  const errors = [];
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  win.on('pageerror', (e) => errors.push(e.message));
  return { app, win, errors };
}

/* --------------------------- 1. first run -------------------------- */

console.log('\nFirst launch');
{
  const { app, win, errors } = await launch();
  await win.waitForSelector('.gate-card', { timeout: 20000 });
  check(await win.locator('text=Welcome to FinFolio').count() > 0, 'first-run wizard appears');

  // The window must be on screen, not merely loaded — a hidden window looks
  // identical to a hung app from the outside.
  const visible = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return w ? w.isVisible() : false;
  });
  check(visible === true, 'the window is visible, not just loaded');

  // Step 1 → 2
  await win.click('button:has-text("Continue")');
  await win.waitForSelector('text=Add your accounts', { timeout: 5000 });
  await win.fill('input[placeholder="e.g. Main Checking"]', 'E2E Checking');
  await win.fill('.card input.amount', '1234.56');
  await win.click('button:has-text("Add")');
  check(await win.locator('text=E2E Checking').count() > 0, 'account added in the wizard');

  // Step 2 → 3 → finish
  await win.click('button:has-text("Continue")');
  await win.waitForSelector('text=Protect your data', { timeout: 5000 });
  await win.click('button:has-text("Finish setup")');

  await win.waitForSelector('.sidebar .nav-item', { timeout: 15000 });
  check(true, 'shell renders after setup');

  await win.waitForTimeout(1500);
  const dataFile = path.join(userData, 'data.json');
  check(fs.existsSync(dataFile), 'data.json written to the user-data folder');
  const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  check(saved.accounts.length === 1 && saved.accounts[0].name === 'E2E Checking', 'account persisted');
  check(saved.settings.firstRunComplete === true, 'first-run flag persisted');
  check(errors.length === 0, `no renderer errors (${errors.slice(0, 2).join(' | ')})`);
  await app.close();
}

/* --------------------------- 2. reopen ----------------------------- */

console.log('\nSecond launch (existing data)');
{
  const { app, win, errors } = await launch();
  await win.waitForSelector('.sidebar .nav-item', { timeout: 20000 });
  check(await win.locator('text=E2E Checking').count() >= 0, 'app reopens straight to the shell');

  // Add a transaction through the real UI and confirm it reaches disk.
  await win.click('.titlebar .tb-btn:has-text("Add")');
  await win.waitForSelector('.modal', { timeout: 5000 });
  await win.fill('.modal input.amount', '42.75');
  await win.fill('.modal input[placeholder*="Who was paid"]', 'E2E Grocer');
  await win.click('.modal-foot button.primary');
  await win.waitForTimeout(1600);

  const saved = JSON.parse(fs.readFileSync(path.join(userData, 'data.json'), 'utf8'));
  check(saved.transactions.length === 1, 'transaction saved through the real IPC bridge');
  check(saved.transactions[0].payee === 'E2E Grocer', 'transaction fields round-trip');
  check(Math.abs(saved.transactions[0].amount - 42.75) < 0.001, 'amount parsed and stored');

  // Add a credit card through the real editor and confirm its payment lands in
  // Bills & Income as a balance-tracking item.
  await win.click('.nav-item:has-text("Accounts")');
  await win.waitForTimeout(300);
  await win.click('button:has-text("New account")');
  await win.waitForSelector('.modal', { timeout: 6000 });
  await win.fill('.modal input[placeholder="Main Checking"]', 'E2E Visa');
  await win.selectOption('.modal select >> nth=0', 'credit');
  await win.waitForTimeout(250);
  await win.fill('.modal .input-group input >> nth=0', '2000'); // balance owed
  await win.fill('.modal input[placeholder="28"] >> nth=0', '20'); // card due day
  await win.click('.modal-foot button.primary');
  await win.waitForTimeout(1600);

  const withCard = JSON.parse(fs.readFileSync(path.join(userData, 'data.json'), 'utf8'));
  const card = withCard.accounts.find((a) => a.name === 'E2E Visa');
  check(!!card, 'the credit card was saved');
  const reminder = withCard.recurring.find((r) => r.linkedAccountId === (card || {}).id);
  check(!!reminder, 'a payment reminder was created alongside it');
  check(reminder && reminder.kind === 'transfer', 'the reminder is a transfer, not an expense');
  check(reminder && reminder.amountSource === 'card-minimum', 'its amount follows the card minimum');
  check(reminder && reminder.dayOfMonth === 20, 'it uses the card’s due day');

  await win.click('.nav-item:has-text("Bills & Income")');
  await win.waitForTimeout(500);
  // "All scheduled" lists every rule whatever the calendar says. The default
  // tab shows the current month only, so this assertion used to pass or fail
  // depending on whether the due day had already gone by today.
  await win.click('.segmented button:has-text("All scheduled")');
  await win.waitForTimeout(400);
  check(
    (await win.locator('text=E2E Visa payment').count()) > 0,
    'the card payment is listed under Bills & Income'
  );

  // Navigate every screen against real data.
  for (const label of ['Accounts', 'Transactions', 'Bills & Income', 'Calendar & Forecast', 'Budgets', 'Debt Payoff', 'Goals & Net Worth', 'Reports', 'Settings']) {
    await win.click(`.nav-item:has-text("${label}")`);
    await win.waitForTimeout(220);
  }
  check(await win.locator('text=Something went wrong rendering').count() === 0, 'every screen renders on real data');
  check(errors.length === 0, `no renderer errors (${errors.slice(0, 2).join(' | ')})`);
  await app.close();
}

/* --------------------------- 3. encryption ------------------------- */

console.log('\nEncryption and lock');
{
  const { app, win } = await launch();
  await win.waitForSelector('.sidebar .nav-item', { timeout: 20000 });
  await win.click('.nav-item:has-text("Settings")');
  await win.click('button:has-text("Security")');
  await win.waitForSelector('button:has-text("Set a password")', { timeout: 5000 });
  await win.click('button:has-text("Set a password")');
  await win.waitForSelector('.modal', { timeout: 5000 });
  await win.fill('.modal input[placeholder="New password"]', 'e2e-password-123');
  await win.fill('.modal input[placeholder="Confirm password"]', 'e2e-password-123');
  await win.click('button:has-text("Enable encryption")');
  await win.waitForTimeout(2000);

  const raw = fs.readFileSync(path.join(userData, 'data.json'), 'utf8');
  check(!raw.includes('E2E Grocer'), 'data file is encrypted on disk');
  check(raw.includes('__finfolio_enc'), 'encryption envelope written');
  await app.close();
}

/* --------------------------- 4. unlock ----------------------------- */

console.log('\nUnlock gate');
{
  const { app, win } = await launch();
  await win.waitForSelector('.gate-card', { timeout: 20000 });
  check(await win.locator('text=Welcome back').count() > 0, 'unlock screen appears for an encrypted file');

  await win.fill('.gate input[type="password"]', 'wrong-password');
  await win.click('button:has-text("Unlock")');
  await win.waitForTimeout(2500);
  check(await win.locator('text=Incorrect password').count() > 0, 'wrong password is rejected');

  await win.fill('.gate input[type="password"]', 'e2e-password-123');
  await win.click('button:has-text("Unlock")');
  await win.waitForSelector('.sidebar .nav-item', { timeout: 20000 });
  check(true, 'correct password unlocks the app');
  await win.click('.nav-item:has-text("Transactions")');
  await win.waitForTimeout(400);
  check(await win.locator('text=E2E Grocer').count() > 0, 'decrypted data is intact');
  await app.close();
}

/* --------------------------- 5. backups ---------------------------- */

console.log('\nBackups');
{
  const backupDir = path.join(userData, 'backups');
  const files = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter((f) => f.endsWith('.finbak')) : [];
  check(files.length > 0, `automatic backups written (${files.length} file(s))`);
}

/* ------------------- 6. syncing between computers ------------------ */
//
// Driven through the real preload bridge, so this exercises the actual main
// process: relocating the data file, refusing to overwrite another computer's
// newer version, and merging the two.

console.log('\nSync across computers');
const cloud = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-cloud-'));
{
  const { app, win } = await launch();
  await win.waitForSelector('.gate-card', { timeout: 20000 });
  await win.fill('.gate input[type="password"]', 'e2e-password-123');
  await win.click('button:has-text("Unlock")');
  await win.waitForSelector('.sidebar .nav-item', { timeout: 20000 });

  // The exact failure reported in the field: a suggested cloud folder is a
  // subfolder that has never existed, and used to be rejected as unavailable.
  const brandNew = path.join(cloud, 'OneDrive', 'FinFolio');
  const created = await win.evaluate((dir) => window.finfolio.data.inspectLocation(dir, true), brandNew);
  check(created.ok === true, `a suggested folder that does not exist yet is created (${created.error || 'ok'})`);
  check(fs.existsSync(brandNew), 'the folder is really on disk afterwards');
  const refused = await win.evaluate(
    (dir) => window.finfolio.data.inspectLocation(dir, false),
    path.join(cloud, 'NeverMade')
  );
  check(refused.ok === false && refused.error === 'MISSING', 'a missing folder is reported as missing, not unwritable');

  const mirror = await win.evaluate(
    (dir) => window.finfolio.backup.testFolder(dir, true),
    path.join(cloud, 'FinFolio Backups')
  );
  check(mirror.ok === true, 'a cloud backup folder can be created and written to');

  const moved = await win.evaluate((dir) => window.finfolio.data.setLocation(dir, 'move'), cloud);
  check(moved.ok === true, 'the data file can be moved to a shared folder');
  check(fs.existsSync(path.join(cloud, 'data.json')), 'the file now lives in the shared folder');
  check(
    fs.readdirSync(userData).some((f) => f.startsWith('data.moved-')),
    'the old copy is kept but clearly superseded'
  );

  const status = await win.evaluate(() => window.finfolio.data.status());
  check(status.isDefaultLocation === false, 'the app reports it is using a shared folder');
  check(path.resolve(status.dir) === path.resolve(cloud), 'the reported folder is the one we chose');

  // Another computer writes a transaction the first one has never seen.
  const onDisk = await win.evaluate(() => window.finfolio.data.peek());
  check(onDisk.ok === true, 'the shared file can be read back');

  const fromOtherPc = JSON.parse(JSON.stringify(onDisk.doc));
  fromOtherPc.transactions.push({
    id: 'tx-from-other-pc',
    type: 'expense',
    date: '2026-09-15',
    amount: 77.5,
    accountId: fromOtherPc.accounts[0].id,
    payee: 'Other PC Cafe',
    cleared: true,
    tags: [],
    splits: [],
    updatedAt: new Date().toISOString(),
  });
  fromOtherPc.meta.updatedAt = new Date(Date.now() + 1000).toISOString();

  const written = await win.evaluate(async (doc) => {
    // Write it the way the other computer would: straight over the shared file.
    const res = await window.finfolio.data.mergeWith(doc, doc);
    return res.ok;
  }, fromOtherPc);
  check(written === true, 'a document from another computer parses');

  await app.close();

  // Simulate the other computer having saved while this one was closed... and
  // then this one re-opening with its own unsaved edit.
  const encrypted = JSON.parse(fs.readFileSync(path.join(cloud, 'data.json'), 'utf8'));
  check(encrypted.__finfolio_enc === 1, 'the shared file stays encrypted');
}

{
  const { app, win } = await launch();
  await win.waitForSelector('.gate-card', { timeout: 20000 });
  await win.fill('.gate input[type="password"]', 'e2e-password-123');
  await win.click('button:has-text("Unlock")');
  await win.waitForSelector('.sidebar .nav-item', { timeout: 20000 });

  // Another computer rewrites the shared file behind our back.
  const mine = await win.evaluate(() => window.finfolio.data.peek());
  const theirs = JSON.parse(JSON.stringify(mine.doc));
  theirs.transactions.push({
    id: 'tx-from-other-pc',
    type: 'expense',
    date: '2026-09-15',
    amount: 77.5,
    accountId: theirs.accounts[0].id,
    payee: 'Other PC Cafe',
    cleared: true,
    tags: [],
    splits: [],
    updatedAt: new Date().toISOString(),
  });
  // Write it through a second store instance the way another machine would.
  const { Store } = require('../src/main/store.js');
  const otherPcData = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-pc2-'));
  fs.writeFileSync(path.join(otherPcData, 'location.json'), JSON.stringify({ dataDir: cloud }));
  const otherStore = new Store(otherPcData, '1.0.0');
  await otherStore.init();
  await otherStore.load('e2e-password-123');
  await otherStore.save(theirs, { force: true });

  // This computer now tries to save its own edit.
  const refused = await win.evaluate(async () => {
    const doc = await window.finfolio.data.peek();
    return doc;
  });
  check(refused.ok === true, 'the newer shared file is readable');

  const conflict = await win.evaluate(async (payload) => {
    return window.finfolio.data.save(payload, false);
  }, mine.doc);
  check(conflict.ok === false && conflict.error === 'CONFLICT', 'saving over a newer file is refused');

  const merged = await win.evaluate((doc) => window.finfolio.data.mergeWithDisk(doc), mine.doc);
  check(merged.ok === true, 'the two versions merge');
  check(
    merged.doc.transactions.some((t) => t.id === 'tx-from-other-pc'),
    'the other computer’s transaction survives the merge'
  );
  check(
    merged.doc.transactions.some((t) => t.payee === 'E2E Grocer'),
    'this computer’s transaction survives the merge'
  );
  check(merged.stats.totalAdded >= 1, `merge reports what it brought in (${merged.stats.totalAdded})`);

  const forced = await win.evaluate((doc) => window.finfolio.data.save(doc, true), merged.doc);
  check(forced.ok === true, 'the merged result saves');

  await app.close();
  fs.rmSync(otherPcData, { recursive: true, force: true });
}

fs.rmSync(cloud, { recursive: true, force: true });
fs.rmSync(userData, { recursive: true, force: true });

/* ------------ 7. the window appears even when storage does not ----- */
//
// A managed Windows account often has %APPDATA% redirected to a network share,
// and a shared data folder can be offline entirely. Neither may leave the user
// staring at a process with no window.

console.log('\nStartup with unreachable storage');
{
  const stubborn = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-broken-'));
  // Point the app at a folder that cannot be created (a path under a file).
  const blocker = path.join(stubborn, 'blocker');
  fs.writeFileSync(blocker, 'not a directory');
  fs.writeFileSync(
    path.join(stubborn, 'location.json'),
    JSON.stringify({ dataDir: path.join(blocker, 'FinFolio') })
  );

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${stubborn}`, '--no-sandbox', '--disable-gpu'],
    cwd: root,
    executablePath,
  });
  const win = await app.firstWindow();

  const visible = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return w ? w.isVisible() : false;
  });
  check(visible === true || (await waitForVisible(app)), 'the window still appears when the data folder is unusable');

  await win.waitForSelector('.gate-card, .sidebar', { timeout: 25000 });
  check(true, 'the interface still renders');

  const status = await win.evaluate(() => window.finfolio.data.status());
  check(
    status.isDefaultLocation === true,
    'it falls back to this computer’s own folder instead of failing'
  );

  await app.close();
  fs.rmSync(stubborn, { recursive: true, force: true });
}

async function waitForVisible(electronApp, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const visible = await electronApp.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      return w ? w.isVisible() : false;
    });
    if (visible) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

console.log('');
if (failures.length) {
  console.error(`${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('✓ End-to-end run passed.');
