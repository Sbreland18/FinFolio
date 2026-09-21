/**
 * UI smoke test.
 *
 * Loads the real renderer in Chromium with a stubbed preload bridge and sample
 * data, walks every screen in both themes, and fails on any console error,
 * uncaught exception or error panel. Screenshots land in scripts/.smoke/.
 *
 *   npm run smoke            # headless, writes screenshots
 *   npm run smoke -- --open  # keep the browser open
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const shotDir = path.join(here, '.smoke');

const { chromium } = require('playwright');
const schema = require('../src/main/schema.js');
const { buildDemoDocument } = await import(pathToFileURL(path.join(root, 'src/renderer/js/demo.js')).href);

const doc = buildDemoDocument(schema.emptyDocument());

// Leave one card without a payment reminder so the "not in your bills" prompt
// and the bulk add dialog are exercised rather than assumed.
doc.recurring = doc.recurring.filter((r) => r.id !== 'demo-storepay');

const ROUTES = [
  ['Dashboard', 'dashboard'],
  ['Accounts', 'accounts'],
  ['Transactions', 'transactions'],
  ['Bills & Income', 'recurring'],
  ['Calendar & Forecast', 'calendar'],
  ['Budgets', 'budgets'],
  ['Debt Payoff', 'debt'],
  ['Goals & Net Worth', 'goals'],
  ['Reports', 'reports'],
  ['Settings', 'settings'],
];

fs.rmSync(shotDir, { recursive: true, force: true });
fs.mkdirSync(shotDir, { recursive: true });

const problems = [];
const browser = await chromium.launch({
  headless: !process.argv.includes('--open'),
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, deviceScaleFactor: 1 });

page.on('console', (msg) => {
  if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
});
page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));

await page.addInitScript(({ document: seed }) => {
  const noop = () => () => {};
  window.__finfolioDoc = seed;
  window.finfolio = {
    app: {
      info: async () => ({
        ok: true, version: '1.0.0', name: 'FinFolio', platform: 'win32', arch: 'x64',
        electron: '44.0.0', chrome: '138', node: '22', isDev: true, isPackaged: false,
        userData: 'C:\\Users\\Demo\\AppData\\Roaming\\FinFolio',
      }),
    },
    data: {
      status: async () => ({
        exists: true, encrypted: false, size: 421000,
        path: 'C:\\Users\\Demo\\AppData\\Roaming\\FinFolio\\data.json',
        dir: 'C:\\Users\\Demo\\AppData\\Roaming\\FinFolio',
        defaultDir: 'C:\\Users\\Demo\\AppData\\Roaming\\FinFolio',
        isDefaultLocation: true,
        backupDir: 'C:\\...\\backups', unlocked: true,
        modified: new Date().toISOString(), changedElsewhere: false,
        locationUnavailable: null, storeError: null,
      }),
      load: async () => ({ ok: true, doc: window.__finfolioDoc }),
      save: async () => ({ ok: true, updatedAt: new Date().toISOString() }),
      lock: async () => ({ ok: true }),
      peek: async () => ({ ok: true, doc: window.__finfolioDoc }),
      reload: async () => ({ ok: true, doc: window.__finfolioDoc }),
      changedElsewhere: async () => ({ ok: true, changed: false }),
      mergeWithDisk: async () => ({
        ok: true,
        doc: window.__finfolioDoc,
        stats: { added: { transactions: 3 }, updated: { accounts: 1 }, removed: {}, totalAdded: 3, totalUpdated: 1, totalRemoved: 0 },
      }),
      mergeWith: async () => ({
        ok: true,
        doc: window.__finfolioDoc,
        stats: { added: { transactions: 2 }, updated: {}, removed: {}, totalAdded: 2, totalUpdated: 0, totalRemoved: 0 },
      }),
      compare: async () => ({ ok: true, stats: { added: {}, updated: {}, removed: {}, totalAdded: 0, totalUpdated: 0, totalRemoved: 0 } }),
      pickFolder: async () => ({ ok: false, error: 'CANCELED' }),
      inspectLocation: async () => ({ ok: true, dir: 'C:\\Users\\Demo\\OneDrive\\FinFolio', existing: null }),
      setLocation: async () => ({ ok: true, dir: 'C:\\Users\\Demo\\OneDrive\\FinFolio', doc: window.__finfolioDoc, mode: 'move' }),
      resetLocation: async () => ({ ok: true }),
      suggestFolders: async () => ({
        ok: true,
        folders: [
          { label: 'Google Drive (G:)', dir: 'G:\\My Drive\\FinFolio', root: 'G:\\My Drive' },
          { label: 'OneDrive - Hancock County Schools', dir: 'C:\\Users\\Demo\\OneDrive - HCS\\FinFolio', root: 'C:\\Users\\Demo\\OneDrive - HCS' },
        ],
      }),
      onExternalChange: noop,
      setPassword: async () => ({ ok: true, encrypted: true }),
      verifyPassword: async () => ({ ok: true, matches: true }),
      scorePassword: async () => ({ ok: true, score: 3, label: 'Strong' }),
      revealInFolder: async () => ({ ok: true }),
    },
    backup: {
      now: async () => ({ ok: true }),
      list: async () => ({ ok: true, items: [{ name: 'finfolio-20260917-080000.finbak', path: 'C:\\b\\1.finbak', size: 120345, modified: new Date().toISOString() }] }),
      openFolder: async () => ({ ok: true }),
      remove: async () => ({ ok: true }),
      // The cloud-copy flow, with just enough state to exercise both halves.
      testFolder: async (dir) => ({ ok: true, dir }),
      mirrorStatus: async () =>
        window.__mirrorDir
          ? { ok: true, configured: true, dir: window.__mirrorDir, reachable: true, count: 12, newest: new Date().toISOString() }
          : { ok: true, configured: false },
      syncMirror: async () => ({ ok: true, copied: 12, total: 12 }),
      openMirror: async () => ({ ok: true }),
      suggestFolders: async () => ({
        ok: true,
        folders: [
          { label: 'Google Drive (G:)', dir: 'G:\\My Drive\\FinFolio Backups', root: 'G:\\My Drive' },
          { label: 'OneDrive - Hancock County Schools', dir: 'C:\\Users\\Demo\\OneDrive - HCS\\FinFolio Backups', root: 'C:\\Users\\Demo\\OneDrive - HCS' },
        ],
      }),
      export: async () => ({ ok: false, error: 'CANCELED' }),
      pick: async () => ({ ok: true, file: 'C:\\Users\\Demo\\Documents\\FinFolio-Backup.finbak' }),
      read: async () => ({
        ok: true,
        doc: window.__finfolioDoc,
        info: { createdAt: new Date(Date.now() - 86400000).toISOString(), appVersion: '1.0.0', encrypted: false },
      }),
      restore: async () => ({ ok: false, error: 'CANCELED' }),
    },
    files: {
      // Returns a sample statement so the import wizard can be driven end to end.
      openText: async () => ({
        ok: true,
        file: 'C:\\Downloads\\statement.csv',
        name: 'statement.csv',
        size: 420,
        content: [
          'Posted Date,Description,Debit,Credit,Balance',
          '09/02/2026,KROGER #1184,84.12,,2410.55',
          '09/04/2026,SHELL OIL 4471,41.80,,2368.75',
          '09/05/2026,PAYROLL HANCOCK SCHOOLS,,2380.00,4748.75',
          '09/07/2026,STARBUCKS STORE 220,6.45,,4742.30',
          '09/09/2026,AMAZON MKTPLACE,132.99,,4609.31',
        ].join('\n'),
      }),
      saveText: async () => ({ ok: false, error: 'CANCELED' }),
      openPath: async () => ({ ok: true }),
    },
    clipboard: { write: async () => ({ ok: true }) },
    shell: { openExternal: async () => ({ ok: true }) },
    window: {
      minimize: async () => ({ ok: true }),
      toggleMaximize: async () => ({ ok: true }),
      close: async () => ({ ok: true }),
      state: async () => ({ ok: true, maximized: false, focused: true }),
      onState: noop,
    },
    theme: { apply: async () => ({ ok: true, dark: false }), onSystemChange: noop },
    updates: {
      state: async () => ({ ok: true, status: 'current', currentVersion: '1.0.0', info: { version: '1.0.0' } }),
      check: async () => ({ ok: true, status: 'current' }),
      download: async () => ({ ok: true }),
      install: async () => true,
      prefs: async () => ({ ok: true }),
      onEvent: noop,
    },
    menu: { onCommand: noop },
    log: { error: async (m, s) => { console.error('LOGGED', m, s); return { ok: true }; } },
  };
}, { document: doc });

// The app serves the renderer from a privileged app:// origin because ES
// modules cannot load over file://. A local static server reproduces that.
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
};
const rendererRoot = path.join(root, 'src', 'renderer');
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.normalize(path.join(rendererRoot, rel === '/' ? '/index.html' : rel));
  if (!file.startsWith(rendererRoot) || !fs.existsSync(file)) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

await page.goto(`${origin}/index.html`);
await page.waitForSelector('.sidebar .nav-item', { timeout: 15000 });

let step = 0;
for (const theme of ['light', 'dark']) {
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  for (const [label, route] of ROUTES) {
    step += 1;
    await page.click(`.nav-item:has-text("${label}")`);
    await page.waitForTimeout(320);
    const errorPanel = await page.locator('text=Something went wrong rendering this screen').count();
    if (errorPanel) {
      const detail = await page.locator('.view pre').first().innerText().catch(() => '');
      problems.push(`render error on "${label}" (${theme}): ${detail.split('\n')[0]}`);
    }
    await page.screenshot({
      path: path.join(shotDir, `${String(step).padStart(2, '0')}-${theme}-${route}.png`),
      fullPage: false,
    });
  }
}

// Exercise the dialogs — this is where most runtime errors hide.
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));

async function dialog(name, navLabel, trigger, shot, after) {
  try {
    await page.click(`.nav-item:has-text("${navLabel}")`);
    await page.waitForTimeout(280);
    await page.click(trigger);
    await page.waitForSelector('.modal', { timeout: 6000 });
    if (after) await after();
    await page.waitForTimeout(220);
    await page.screenshot({ path: path.join(shotDir, shot) });
  } catch (err) {
    problems.push(`dialog "${name}" did not open: ${err.message.split('\n')[0]}`);
  } finally {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(250);
  }
}

await dialog('transaction', 'Dashboard', '.titlebar .tb-btn:has-text("Add")', '21-dialog-transaction.png');
await dialog('account', 'Accounts', 'button:has-text("New account")', '22-dialog-account.png', async () => {
  // Switching the type reveals the credit-card fields — exercise that path.
  await page.selectOption('.modal select >> nth=0', 'credit').catch(() => {});
});
await dialog('recurring', 'Bills & Income', 'button:has-text("New schedule")', '23-dialog-recurring.png');
await dialog('import', 'Transactions', 'button:has-text("Import")', '24-dialog-import.png');
await dialog('budget', 'Budgets', 'button:has-text("Edit budget")', '25-dialog-budget.png');
await dialog('goal', 'Goals & Net Worth', 'button:has-text("New goal")', '26-dialog-goal.png');

// Walk the import wizard all the way through with a sample CSV.
try {
  await page.click('.nav-item:has-text("Transactions")');
  await page.waitForTimeout(280);
  await page.click('button:has-text("Import")');
  await page.waitForSelector('.modal', { timeout: 6000 });
  await page.click('button:has-text("Choose a file")');
  await page.waitForSelector('text=Preview of the file', { timeout: 6000 });
  await page.screenshot({ path: path.join(shotDir, '27-import-mapping.png') });
  await page.click('.modal-foot button.primary');
  await page.waitForSelector('text=to import', { timeout: 6000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shotDir, '28-import-preview.png') });
  const rows = await page.locator('.modal tbody tr').count();
  if (rows < 5) problems.push(`import wizard parsed ${rows} rows, expected 5`);
  const dupBadges = await page.locator('.modal .badge:has-text("Duplicate")').count();
  if (dupBadges === 0) problems.push('import wizard found no duplicates in data that contains one');
} catch (err) {
  problems.push(`import wizard failed: ${err.message.split('\n')[0]}`);
} finally {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(250);
}

// Card payments as bills: the prompt, and the dialog that adds them.
try {
  await page.click('.nav-item:has-text("Debt Payoff")');
  await page.waitForTimeout(400);
  const prompt = await page.locator('text=not in Bills & Income').count();
  if (!prompt) problems.push('debt screen does not offer to add missing payment reminders');
  await page.screenshot({ path: path.join(shotDir, '29-debt-missing-reminder.png') });

  await page.click('.view button:has-text("Add them")');
  await page.waitForSelector('text=Add these payments to Bills & Income', { timeout: 6000 });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(shotDir, '30-add-payment-reminders.png') });
  await page.click('.modal-foot button.primary');
  await page.waitForTimeout(600);

  const stillMissing = await page.locator('text=not in Bills & Income').count();
  if (stillMissing) problems.push('the reminder was not added');

  await page.click('.nav-item:has-text("Bills & Income")');
  await page.waitForTimeout(500);
  const estimated = await page.locator('.list-row:has-text("estimated")').count();
  if (!estimated) problems.push('no card payment shows an estimated amount in Bills & Income');
  await page.screenshot({ path: path.join(shotDir, '31-bills-with-cards.png') });
} catch (err) {
  problems.push(`card-payment reminders failed: ${err.message.split('\n')[0]}`);
} finally {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);
}

// Turning on cloud copies of the backups — the flow that failed in the field
// when a suggested folder did not exist yet.
try {
  await page.click('.nav-item:has-text("Settings")');
  await page.waitForTimeout(280);
  await page.click('.settings-nav button:has-text("Backup & restore")');
  await page.waitForTimeout(420);
  await page.screenshot({ path: path.join(shotDir, '27-cloud-backup-off.png') });

  const suggested = await page.locator('button:has-text("Google Drive (G:)")').count();
  if (!suggested) problems.push('no detected cloud folder offered for backups');

  await page.evaluate(() => {
    // The mock records the chosen folder so the "on" state can render.
    const original = window.finfolio.backup.testFolder;
    window.finfolio.backup.testFolder = async (dir, create) => {
      window.__mirrorDir = dir;
      return original(dir, create);
    };
  });
  await page.click('button:has-text("Google Drive (G:)")');
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(shotDir, '28-cloud-backup-on.png') });
  const onState = await page.locator('text=backups in your cloud folder').count();
  if (!onState) problems.push('cloud backup card did not switch to the configured state');
} catch (err) {
  problems.push(`cloud backup setup failed: ${err.message.split('\n')[0]}`);
}

// The restore dialog, which is where merging is offered.
try {
  await page.click('.nav-item:has-text("Settings")');
  await page.waitForTimeout(280);
  await page.click('.settings-nav button:has-text("Backup & restore")');
  await page.waitForTimeout(380);
  await page.click('button:has-text("Restore from a file")');
  await page.waitForSelector('text=Restore from this backup', { timeout: 6000 });
  await page.waitForTimeout(260);
  await page.screenshot({ path: path.join(shotDir, '29-dialog-restore.png') });
  const hasMerge = await page.locator('.modal button:has-text("Merge")').count();
  if (!hasMerge) problems.push('restore dialog does not offer a merge');
} catch (err) {
  problems.push(`restore dialog failed: ${err.message.split('\n')[0]}`);
} finally {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(250);
}

// Every settings tab, since each one builds its panel independently.
try {
  await page.click('.nav-item:has-text("Settings")');
  await page.waitForTimeout(280);
  const tabs = ['General', 'Appearance', 'Security', 'Backup & restore', 'Sync across computers', 'Categories & rules', 'Updates', 'Data & storage'];
  for (const [i, tab] of tabs.entries()) {
    await page.click(`.settings-nav button:has-text("${tab}")`);
    await page.waitForTimeout(420);
    if (await page.locator('text=Something went wrong rendering this screen').count()) {
      problems.push(`settings tab "${tab}" failed to render`);
    }
    await page.screenshot({ path: path.join(shotDir, `3${i}-settings-${tab.split(' ')[0].toLowerCase()}.png`) });
  }
} catch (err) {
  problems.push(`settings tabs failed: ${err.message.split('\n')[0]}`);
}

// Row menus. These are clicked with a real mouse rather than dispatched,
// because the bug they are guarding against was invisible to a synthetic
// click: the menu closed on mousedown, so the element was gone before the
// click landed and every menu item in the app quietly did nothing.
try {
  await page.click('.nav-item:has-text("Bills & Income")');
  await page.waitForTimeout(400);

  await page.click('.list-row button.btn.ghost.icon.sm >> nth=0');
  await page.waitForSelector('.menu', { timeout: 4000 });
  await page.screenshot({ path: path.join(shotDir, '39-row-menu.png') });

  const items = await page.locator('.menu button').count();
  if (items < 4) problems.push(`row menu has ${items} items, expected the full set`);

  await page.click('.menu button:has-text("Edit the schedule")');
  const opened = await page
    .waitForSelector('.modal', { timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  if (!opened) problems.push('clicking a row-menu item did nothing — the menu closes before the click lands');
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(250);
} catch (err) {
  problems.push(`row menu failed: ${err.message.split('\n')[0]}`);
}

// Skipping one occurrence, then putting it back.
try {
  await page.click('.nav-item:has-text("Bills & Income")');
  await page.waitForTimeout(400);
  const before = await page.locator('.list-row').count();

  await page.click('.list-row button.btn.ghost.icon.sm >> nth=0');
  await page.waitForSelector('.menu', { timeout: 4000 });
  await page.click('.menu button:has-text("Skip just")');
  await page.waitForSelector('.modal:has-text("Skip")', { timeout: 4000 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(shotDir, '40-dialog-skip.png') });
  await page.click('.modal-foot button:has-text("Skip this payment")');
  await page.waitForTimeout(600);

  const skippedRows = await page.locator('.list-row:has-text("Skipped")').count();
  if (!skippedRows) problems.push('a skipped occurrence is not shown as skipped');
  const after = await page.locator('.list-row').count();
  if (after !== before) problems.push('skipping changed how many rows are listed instead of marking one');
  await page.screenshot({ path: path.join(shotDir, '41-bills-skipped.png') });

  await page.click('.list-row:has-text("Skipped") button:has-text("Put it back")');
  await page.waitForTimeout(600);
  if (await page.locator('.list-row:has-text("Skipped")').count()) {
    problems.push('putting a skipped payment back did not restore it');
  }
} catch (err) {
  problems.push(`skip flow failed: ${err.message.split('\n')[0]}`);
} finally {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);
}

// Setting the amount for a single date — the variable-payday case.
try {
  await page.click('.nav-item:has-text("Bills & Income")');
  await page.waitForTimeout(400);
  await page.click('.list-row button.btn.ghost.icon.sm >> nth=0');
  await page.waitForSelector('.menu', { timeout: 4000 });
  await page.click('.menu button:has-text("Set the amount for just")');
  await page.waitForSelector('.modal', { timeout: 4000 });
  await page.fill('.modal input.amount >> nth=0', '1234.56');
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(shotDir, '42-dialog-occurrence-amount.png') });
  await page.click('.modal-foot button:has-text("Save for this date")');
  await page.waitForTimeout(600);

  if (!(await page.locator('.list-row:has-text("set for this date")').count())) {
    problems.push('an amount set for one date is not marked on the row');
  }
  if (!(await page.locator('.list-row:has-text("1,234.56")').count())) {
    problems.push('the amount set for one date is not the amount shown');
  }
  await page.screenshot({ path: path.join(shotDir, '43-bills-occurrence-amount.png') });
} catch (err) {
  problems.push(`per-date amount failed: ${err.message.split('\n')[0]}`);
} finally {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);
}

// The payoff schedule must follow the payment date the person set, not the
// day the screen happened to be opened.
try {
  await page.click('.nav-item:has-text("Debt Payoff")');
  await page.waitForTimeout(420);
  await page.click('.list-row button[title="Details"] >> nth=0');
  await page.waitForSelector('.modal .table tbody tr', { timeout: 6000 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(shotDir, '46-debt-schedule.png') });

  const nextPayment = await page
    .locator('.modal dl.kv dd')
    .first()
    .innerText()
    .catch(() => '');
  const firstRow = await page.locator('.modal .table tbody tr td >> nth=1').innerText().catch(() => '');
  if (!nextPayment) {
    problems.push('the payoff detail does not say when the next payment is due');
  } else {
    // "December 1, 2026" against "12/01/2026" — the day number is what matters.
    const due = (nextPayment.match(/\s(\d{1,2}),/) || [])[1];
    const first = (firstRow.match(/\/(\d{2})\//) || [])[1];
    if (!due || !first) problems.push('could not read the payoff schedule’s dates');
    else if (Number(due) !== Number(first)) {
      problems.push(`the payoff schedule starts on day ${first} but the payment is due on day ${due}`);
    }
  }
} catch (err) {
  problems.push(`payoff schedule failed: ${err.message.split('\n')[0]}`);
} finally {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(220);
}

// Recording a payment: it must offer "Cleared the bank", and the bill must
// stop being listed as due afterwards.
try {
  await page.click('.nav-item:has-text("Bills & Income")');
  await page.waitForTimeout(420);
  const before = await page.locator('.list-row:has(button:has-text("Paid"))').count();
  const payable = page.locator('.list-row:has(button:has-text("Paid"))').first();
  if (!(await payable.count())) {
    problems.push('nothing in Bills & Income can be recorded as paid');
  } else {
    await payable.locator('button:has-text("Paid")').click();
    await page.waitForSelector('.modal', { timeout: 4000 });
    if (!(await page.locator('.modal label.check:has-text("Cleared the bank")').count())) {
      problems.push('the record-payment dialog does not offer "Cleared the bank"');
    }
    await page.click('.modal label.check:has-text("Cleared the bank")');
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(shotDir, '47-dialog-record-payment.png') });
    await page.click('.modal-foot button:has-text("Record it")');
    await page.waitForTimeout(800);

    const after = await page.locator('.list-row:has(button:has-text("Paid"))').count();
    if (after >= before) {
      problems.push(`recording a payment left it listed as still to pay (${before} before, ${after} after)`);
    }
    if (!(await page.locator('.list-row .badge:has-text("Paid")').count())) {
      problems.push('a recorded payment is not shown as paid anywhere');
    }
    await page.screenshot({ path: path.join(shotDir, '48-bills-after-payment.png') });
  }
} catch (err) {
  problems.push(`recording a payment failed: ${err.message.split('\n')[0]}`);
} finally {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(220);
}

// The payoff detail must not contradict the screen behind it: the date there
// is this debt on its own, and the plan's date is named alongside it.
try {
  await page.click('.nav-item:has-text("Debt Payoff")');
  await page.waitForTimeout(420);
  await page.click('.list-row button[title="Details"] >> nth=0');
  await page.waitForSelector('.modal dl.kv', { timeout: 6000 });
  await page.waitForTimeout(200);
  if (!(await page.locator('.modal dt:has-text("on its own")').count())) {
    problems.push('the payoff detail does not say its date is for this debt alone');
  }
  if (!(await page.locator('.modal:has-text("In your")').count())) {
    problems.push('the payoff detail does not name the plan’s own date for this debt');
  }
  await page.screenshot({ path: path.join(shotDir, '49-debt-detail-plan.png') });
} catch (err) {
  problems.push(`payoff detail failed: ${err.message.split('\n')[0]}`);
} finally {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(220);
}

// The month view on Bills & Income.
try {
  await page.click('.nav-item:has-text("Bills & Income")');
  await page.waitForTimeout(450);
  if (!(await page.locator('.kpi:has-text("Left to pay"), .stat:has-text("Left to pay")').count())) {
    problems.push('the month view does not say what is left to pay');
  }
  if (!(await page.locator('text=Projected month end').count())) {
    problems.push('the month view does not project where the month ends up');
  }
  await page.screenshot({ path: path.join(shotDir, '50-bills-month.png') });
  await page.click('button[title="Previous month"]');
  await page.waitForTimeout(450);
  if (await page.locator('text=Something went wrong rendering this screen').count()) {
    problems.push('stepping back a month broke the screen');
  }
  await page.click('button:has-text("This month")');
  await page.waitForTimeout(400);
} catch (err) {
  problems.push(`month view failed: ${err.message.split('\n')[0]}`);
}

// A mortgage payment must be recorded as escrow + interest + principal.
try {
  await page.click('.nav-item:has-text("Bills & Income")');
  await page.waitForTimeout(400);
  await page.click('.segmented button:has-text("All scheduled")');
  await page.waitForTimeout(400);
  const mortgageRow = page.locator('tr:has-text("Mortgage payment")').first();
  if (!(await mortgageRow.count())) {
    problems.push('the demo has no mortgage to exercise');
  } else {
    await mortgageRow.locator('button').first().click();
    await page.waitForSelector('.menu', { timeout: 4000 });
    await page.click('.menu button:has-text("Record as paid")');
    await page.waitForSelector('.modal', { timeout: 4000 });
    if (!(await page.locator('.modal label.check:has-text("Split out escrow and interest")').count())) {
      problems.push('a mortgage payment is not offered as escrow, interest and principal');
    }
    if (!(await page.locator('.modal:has-text("off the balance")').count())) {
      problems.push('the payment dialog does not say what actually comes off the balance');
    }
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(shotDir, '51-dialog-mortgage-payment.png') });
  }
} catch (err) {
  problems.push(`mortgage payment failed: ${err.message.split('\n')[0]}`);
} finally {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(220);
}

// A loan heading for forgiveness is counted in payments, not dollars.
try {
  await page.click('.nav-item:has-text("Debt Payoff")');
  await page.waitForTimeout(450);
  if (!(await page.locator('.badge:has-text("to forgiveness")').count())) {
    problems.push('a loan with forgiveness is not marked on Debt Payoff');
  }
  await page.click('.list-row:has-text("Student Loan") button[title="Details"]');
  await page.waitForSelector('.modal dl.kv', { timeout: 6000 });
  if (!(await page.locator('.modal dt:has-text("Qualifying payments")').count())) {
    problems.push('the forgiveness progress is not shown on the loan');
  }
  if (!(await page.locator('.modal:has-text("Forgiven around")').count())) {
    problems.push('no forgiveness date is projected');
  }
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(shotDir, '52-debt-forgiveness.png') });
} catch (err) {
  problems.push(`forgiveness view failed: ${err.message.split('\n')[0]}`);
} finally {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(220);
}

// Reports: a custom range, and drilling into a category.
try {
  await page.click('.nav-item:has-text("Reports")');
  await page.waitForTimeout(450);
  await page.click('.segmented button:has-text("Custom")');
  await page.waitForTimeout(450);
  if ((await page.locator('input[type="date"]').count()) < 2) {
    problems.push('a custom range offers no dates to pick');
  }
  await page.screenshot({ path: path.join(shotDir, '53-reports-custom-range.png') });

  await page.click('.segmented button:has-text("12 months")');
  await page.waitForTimeout(500);
  await page.click('table.clickable tbody tr >> nth=0');
  await page.waitForSelector('.modal', { timeout: 5000 });
  if (!(await page.locator('.modal:has-text("Average a month")').count())) {
    problems.push('the drill-down does not show an average');
  }
  if (!(await page.locator('.modal:has-text("Next month, projected")').count())) {
    problems.push('the drill-down does not project anything');
  }
  if (!(await page.locator('.modal table tbody tr').count())) {
    problems.push('the drill-down shows no transactions');
  }
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(shotDir, '54-reports-drilldown.png') });
} catch (err) {
  problems.push(`reports drill-down failed: ${err.message.split('\n')[0]}`);
} finally {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(220);
}

// Choosing which debts the payoff plan is about.
try {
  await page.click('.nav-item:has-text("Debt Payoff")');
  await page.waitForTimeout(450);
  if (!(await page.locator('text=Set aside from this plan').count())) {
    problems.push('a set-aside debt is not shown anywhere — it would just vanish');
  }
  if (!(await page.locator('.kpi-grid:has-text("set aside"), .stat:has-text("set aside")').count())) {
    problems.push('the totals do not say that something is excluded');
  }
  const planned = await page.locator('button:has-text("of"):has-text("debts")').count();
  if (!planned) problems.push('no control to choose which debts the plan covers');
  await page.screenshot({ path: path.join(shotDir, '55-debt-set-aside.png') });

  await page.click('button:has-text("debts") >> nth=0');
  await page.waitForSelector('.modal:has-text("Which debts")', { timeout: 5000 });
  const boxes = await page.locator('.modal .list-row label.check input').count();
  if (boxes < 2) problems.push(`the chooser lists ${boxes} debts`);
  await page.waitForTimeout(180);
  await page.screenshot({ path: path.join(shotDir, '56-debt-chooser.png') });

  // Put everything back and confirm the plan grows again.
  await page.click('.modal button:has-text("Everything")');
  await page.click('.modal-foot button:has-text("Save")');
  await page.waitForTimeout(800);
  if (await page.locator('text=Set aside from this plan').count()) {
    problems.push('including every debt still leaves a set-aside section');
  }

  // And back out again, so the default state is restored for later screens.
  await page.click('button:has-text("Choose debts"), button:has-text("debts") >> nth=0');
  await page.waitForSelector('.modal:has-text("Which debts")', { timeout: 5000 });
  await page.click('.modal button:has-text("All but the mortgage")');
  await page.click('.modal-foot button:has-text("Save")');
  await page.waitForTimeout(800);
  if (!(await page.locator('text=Set aside from this plan').count())) {
    problems.push('setting the mortgage aside from the chooser did not take effect');
  }
} catch (err) {
  problems.push(`payoff plan chooser failed: ${err.message.split('\n')[0]}`);
} finally {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(220);
}

// Bills must wear their category's icon, not a blank page, and the list must
// separate cards, loans and everyday bills. Checked on All scheduled, which
// always lists every rule whatever state the month is in.
try {
  await page.click('.nav-item:has-text("Bills & Income")');
  await page.waitForTimeout(400);
  await page.click('.segmented button:has-text("All scheduled")');
  await page.waitForTimeout(500);

  const rowCount = await page.locator('table tbody tr:not(.group-row)').count();
  if (rowCount < 4) problems.push(`All scheduled lists only ${rowCount} rows`);

  const groups = await page.locator('table tbody tr.group-row').allInnerTexts().catch(() => []);
  if (groups.length < 2) {
    problems.push(`the schedule list is not separated by kind (${groups.length} headings)`);
  } else if (!groups.some((g) => /credit card/i.test(g))) {
    problems.push(`no credit-card section in the schedule list :: ${groups.join(' | ')}`);
  }

  const blanks = await page.locator('table tbody tr:not(.group-row) td span', { hasText: '📄' }).count();
  if (blanks) problems.push(`${blanks} schedule(s) still show the blank-page icon`);
  await page.screenshot({ path: path.join(shotDir, '57-bills-grouped.png') });
} catch (err) {
  problems.push(`bill icons and grouping failed: ${err.message.split('\n')[0]}`);
}

// Subscriptions: the total, the what-if, and acting on it.
try {
  await page.click('.nav-item:has-text("Bills & Income")');
  await page.waitForTimeout(400);
  await page.click('.segmented button:has-text("Subscriptions")');
  await page.waitForTimeout(500);
  if (!(await page.locator('text=Every subscription, dearest first').count())) {
    problems.push('the subscriptions tab did not render its list');
  }
  const subRows = await page.locator('.card-body.flush .list-row').count();
  if (subRows < 2) problems.push(`the subscriptions list shows ${subRows} rows`);
  if (!(await page.locator('.stat:has-text("A year"), .kpi:has-text("A year")').count())) {
    problems.push('subscriptions are not totalled for a year');
  }
  await page.screenshot({ path: path.join(shotDir, '58-subscriptions.png') });

  await page.click('.list-row label.check >> nth=0');
  await page.waitForTimeout(600);
  if (!(await page.locator('text=You would save').count())) {
    problems.push('ticking a subscription does not show what dropping it saves');
  }
  if (!(await page.locator('text=a year').count())) {
    problems.push('the saving is not annualised');
  }
  await page.screenshot({ path: path.join(shotDir, '59-subscriptions-whatif.png') });
} catch (err) {
  problems.push(`subscriptions failed: ${err.message.split('\n')[0]}`);
}

// Available credit in money, not just a percentage.
try {
  await page.click('.nav-item:has-text("Accounts")');
  await page.waitForTimeout(450);
  if (!(await page.locator('.meter-top:has-text("available")').count())) {
    problems.push('a credit card does not show how much credit is available');
  }
  if (!(await page.locator('.stat:has-text("Credit available"), .kpi:has-text("Credit available")').count())) {
    problems.push('there is no total of available credit');
  }
  await page.screenshot({ path: path.join(shotDir, '60-accounts-available-credit.png') });
} catch (err) {
  problems.push(`available credit failed: ${err.message.split('\n')[0]}`);
}

// Sub-categories: the tree in the manager, and totals that roll up.
try {
  await page.click('.nav-item:has-text("Settings")');
  await page.waitForTimeout(280);
  await page.click('.settings-nav button:has-text("Categories & rules")');
  await page.waitForTimeout(380);
  await page.click('button:has-text("Manage categories")');
  await page.waitForSelector('.modal', { timeout: 4000 });

  if (!(await page.locator('.modal .list-row:has-text("Pet food")').count())) {
    problems.push('the category manager does not show sub-categories');
  }
  if (!(await page.locator('.modal .list-row:has-text("Pets"):has-text("sub-categor")').count())) {
    problems.push('a parent category does not say it has sub-categories');
  }
  await page.screenshot({ path: path.join(shotDir, '61-category-tree.png') });

  // Adding one under a parent.
  await page.click('.modal .list-row:has-text("Pets") button[title="Add a sub-category"] >> nth=0');
  await page.waitForSelector('.modal:has-text("New sub-category under")', { timeout: 4000 });
  if (!(await page.locator('.modal:has-text("Sits under")').count())) {
    problems.push('the category dialog does not offer a parent');
  }
  await page.screenshot({ path: path.join(shotDir, '62-subcategory-dialog.png') });
} catch (err) {
  problems.push(`sub-categories failed: ${err.message.split('\n')[0]}`);
} finally {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);
}

// Reports: narrowing to one account, and a parent broken into its children.
try {
  await page.click('.nav-item:has-text("Reports")');
  await page.waitForTimeout(500);
  const before = await page.locator('.stat-value').first().innerText().catch(() => '');
  const accountPick = page.locator('.page-actions select, .actions select').last();
  await accountPick.selectOption({ label: 'Rewards Visa' }).catch(async () => {
    await page.selectOption('select >> nth=1', { label: 'Rewards Visa' });
  });
  await page.waitForTimeout(600);
  const after = await page.locator('.stat-value').first().innerText().catch(() => '');
  if (before === after) problems.push('filtering reports by account changed nothing');
  if (!(await page.locator('text=Rewards Visa').count())) {
    problems.push('a filtered report does not say which account it covers');
  }
  await page.screenshot({ path: path.join(shotDir, '63-reports-by-account.png') });

  await accountPick.selectOption({ label: 'All accounts' }).catch(() => {});
  await page.waitForTimeout(600);
  await page.click('table.clickable tbody tr >> nth=0');
  await page.waitForSelector('.modal', { timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
} catch (err) {
  problems.push(`reports by account failed: ${err.message.split('\n')[0]}`);
}

// The calendar's account picker, and opening a day's rows.
try {
  await page.click('.nav-item:has-text("Calendar & Forecast")');
  await page.waitForTimeout(550);
  if (!(await page.locator('text=Accounts in this forecast').count())) {
    problems.push('the forecast does not say which accounts it covers');
  }
  const checkingOnly = page.locator('button:has-text("Checking only")');
  if (!(await checkingOnly.count())) {
    problems.push('there is no one-click way to forecast checking alone');
  } else {
    await checkingOnly.click();
    await page.waitForTimeout(700);
    if (!(await page.locator('text=1 of').count())) {
      problems.push('narrowing the forecast does not report what is included');
    }
    await page.screenshot({ path: path.join(shotDir, '64-forecast-checking-only.png') });
    await page.click('button:has-text("All cash accounts")');
    await page.waitForTimeout(600);
  }

  await page.click('.cal-day:has(.cal-ev) >> nth=0');
  await page.waitForSelector('.modal', { timeout: 5000 });
  const dayRows = await page.locator('.modal .list-row').count();
  if (!dayRows) problems.push('a calendar day shows no rows');
  await page.click('.modal .list-row >> nth=0');
  await page.waitForTimeout(500);
  const opened = await page.locator('.modal:has-text("transaction"), .modal:has-text("scheduled item"), .modal:has-text("Edit")').count();
  if (!opened) problems.push('clicking a day row does not open anything');
  await page.screenshot({ path: path.join(shotDir, '65-calendar-day-open.png') });
} catch (err) {
  problems.push(`calendar failed: ${err.message.split('\n')[0]}`);
} finally {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);
}

// Transactions: a custom date range.
try {
  await page.click('.nav-item:has-text("Transactions")');
  await page.waitForTimeout(450);
  const rangePick = page.locator('.toolbar select').nth(2);
  await rangePick.selectOption('custom');
  await page.waitForTimeout(500);
  if ((await page.locator('.toolbar input[type="date"]').count()) < 2) {
    problems.push('a custom transaction range offers no dates');
  }
  await page.screenshot({ path: path.join(shotDir, '66-transactions-custom-range.png') });
  await rangePick.selectOption('all');
  await page.waitForTimeout(400);
} catch (err) {
  problems.push(`transactions range failed: ${err.message.split('\n')[0]}`);
}

// The utilisation meters must be a way into the account.
try {
  await page.click('.nav-item:has-text("Debt Payoff")');
  await page.waitForTimeout(500);
  const meter = page.locator('.card[role="button"]').first();
  if (!(await meter.count())) {
    problems.push('the utilisation meters are not clickable');
  } else {
    await meter.click();
    await page.waitForSelector('.modal dl.kv', { timeout: 5000 });
    if (!(await page.locator('.modal-foot button:has-text("Transactions")').count())) {
      problems.push('the account dialog has no way through to its transactions');
    }
    await page.screenshot({ path: path.join(shotDir, '67-utilisation-open.png') });
  }
} catch (err) {
  problems.push(`utilisation link failed: ${err.message.split('\n')[0]}`);
} finally {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(220);
}

// Accounts: sorting and a custom order.
try {
  await page.click('.nav-item:has-text("Accounts")');
  await page.waitForTimeout(500);
  const nameOf = async () =>
    (await page.locator('.grid-auto .card').first().innerText().catch(() => '')).split('\n')[0];
  const sortPick = page.locator('select[aria-label="Sort accounts"]');
  if (!(await sortPick.count())) {
    problems.push('accounts cannot be sorted');
  } else {
    const byType = await nameOf();
    await sortPick.selectOption('balance');
    await page.waitForTimeout(600);
    const byBalance = await nameOf();
    if (byType === byBalance) problems.push('sorting accounts by balance changed nothing');

    await sortPick.selectOption('custom');
    await page.waitForTimeout(600);
    await page.click('button:has-text("Reorder")');
    await page.waitForSelector('.modal:has-text("Your account order")', { timeout: 5000 });
    const first = await page.locator('.modal .list-row .l-title').first().innerText();
    await page.click('.modal .list-row >> nth=0 >> button[title="Move down"]');
    await page.waitForTimeout(500);
    const afterMove = await page.locator('.modal .list-row .l-title').first().innerText();
    if (first === afterMove) problems.push('moving an account down did nothing');
    await page.screenshot({ path: path.join(shotDir, '68-accounts-reorder.png') });
    await page.click('.modal-foot button:has-text("Done")');
    await page.waitForTimeout(500);
    await page.locator('select[aria-label="Sort accounts"]').selectOption('type');
    await page.waitForTimeout(400);
  }
} catch (err) {
  problems.push(`account sorting failed: ${err.message.split('\n')[0]}`);
} finally {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);
}

// Category icons: a real picker, and the icon actually reaching the category.
try {
  await page.click('.nav-item:has-text("Settings")');
  await page.waitForTimeout(280);
  await page.click('.settings-nav button:has-text("Categories & rules")');
  await page.waitForTimeout(380);
  await page.click('button:has-text("Manage categories")');
  await page.waitForSelector('.modal', { timeout: 4000 });
  await page.click('.modal button:has-text("New category")');
  await page.waitForSelector('.emoji-grid', { timeout: 4000 });

  const choices = await page.locator('.emoji-btn').count();
  if (choices < 20) problems.push(`the icon picker offers ${choices} icons, expected a grid`);

  await page.fill('.modal input.input >> nth=0', 'Sunday lunch');
  await page.click('.emoji-btn[data-emoji="🍕"]');
  const marked = await page.locator('.emoji-btn.on').count();
  if (marked !== 1) problems.push('choosing an icon does not show which one is chosen');
  await page.waitForTimeout(160);
  await page.screenshot({ path: path.join(shotDir, '44-dialog-category-icon.png') });

  await page.click('.modal-foot button:has-text("Save")');
  await page.waitForTimeout(600);
  const saved = await page.locator('.modal .list-row:has-text("Sunday lunch")').first();
  const avatar = await saved.locator('.avatar').innerText().catch(() => '');
  if (!avatar.includes('🍕')) problems.push(`the chosen icon did not stick — the category shows "${avatar}"`);
  await page.screenshot({ path: path.join(shotDir, '45-categories-with-icon.png') });
} catch (err) {
  problems.push(`category icons failed: ${err.message.split('\n')[0]}`);
} finally {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);
}

await page.waitForTimeout(300);

if (!process.argv.includes('--open')) {
  await browser.close();
  server.close();
}

console.log(`\nScreenshots → ${path.relative(process.cwd(), shotDir)}`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of [...new Set(problems)]) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(
  `✓ ${ROUTES.length * 2} screens, 11 dialogs, row menus, skip and per-date amounts, the month view,\n  grouped bill lists and their icons, subscriptions and the what-if, available credit,\n  mortgage payment splitting, forgiveness tracking, the icon picker, custom report ranges\n  and drill-downs, sub-categories, reports by account, the forecast account picker,\n  calendar day links, custom transaction ranges, the utilisation links, account sorting,\n  the import wizard and 8 settings tabs rendered with no console errors.`
);
