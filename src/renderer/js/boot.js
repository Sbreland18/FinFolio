/**
 * Bootstrap: unlock gate → first-run setup → application shell.
 */

import { h, mount, $ } from './dom.js';
import { icon } from './icons.js';
import { configureFormat, today, parseAmount } from './format.js';
import { state, setDoc, saveNow, commit, notify } from './state.js';
import { uid, ACCOUNT_TYPES, isLiability } from './finance.js';
import { buildShell, applyAppearance, renderView } from './shell.js';
import { installSyncHandlers } from './sync.js';
import { toast, toastErr, field, textInput, select, moneyInput, readMoney, checkbox } from './ui.js';

const api = window.finfolio;

window.addEventListener('error', (e) => {
  if (api) api.log.error(String(e.message), e.error && e.error.stack);
});
window.addEventListener('unhandledrejection', (e) => {
  if (api) api.log.error('unhandled rejection', String(e.reason && e.reason.stack ? e.reason.stack : e.reason));
});

main().catch((err) => {
  console.error(err);
  mount(
    $('#app'),
    h(
      'div.gate',
      null,
      h(
        'div.gate-card',
        null,
        h('h1', null, 'FinFolio could not start'),
        h('p.sub', null, String(err && err.message ? err.message : err)),
        h('pre.mono.tiny.mt-16.selectable', { style: { whiteSpace: 'pre-wrap', textAlign: 'left' } }, String(err && err.stack))
      )
    )
  );
});

async function main() {
  if (!api) throw new Error('Preload bridge unavailable — start the app with "npm start".');

  const info = await api.app.info();
  state.appInfo = info;

  // Watch the OS theme so "system" stays in sync.
  api.theme.onSystemChange(() => {
    if (state.doc && (state.doc.settings.theme || 'system') === 'system') {
      applyAppearance(state.doc.settings);
    }
  });

  const status = await api.data.status();
  if (status.storeError === 'SLOW_STORAGE') {
    toastErr('Your data folder is responding slowly — FinFolio may take a moment.', { timeout: 8000 });
  }
  let loaded;
  if (status.encrypted) {
    loaded = await unlockGate();
  } else {
    loaded = await api.data.load(null);
    if (!loaded.ok && loaded.error === 'PASSWORD_REQUIRED') loaded = await unlockGate();
  }

  if (!loaded || !loaded.ok) {
    throw new Error(describeLoadError(loaded && loaded.error));
  }

  setDoc(loaded.doc);
  configureFormat(loaded.doc.settings);
  applyAppearance(loaded.doc.settings);

  if (!loaded.doc.settings.firstRunComplete) {
    await firstRunWizard();
  }

  mount($('#app'));
  buildShell();
  installSyncHandlers();

  if (status.locationUnavailable) {
    toast(
      `Your shared folder could not be reached, so FinFolio is using this computer’s copy for now. It reconnects on its own once the folder is back.`,
      { title: 'Shared folder offline', tone: 'warn', timeout: 0 }
    );
  }

  wireUpdates();
  maybeAutoBackup();
  flushOnExit();
}

function describeLoadError(code) {
  switch (code) {
    case 'CORRUPT':
      return 'The data file could not be read. Restore a backup from Settings → Backup, or from the backups folder in your app data directory.';
    case 'BAD_PASSWORD':
      return 'Incorrect password.';
    default:
      return `Could not open your data (${code || 'unknown error'}).`;
  }
}

/* --------------------------- unlock gate -------------------------- */

function unlockGate() {
  return new Promise((resolve) => {
    const pw = h('input.input', { type: 'password', placeholder: 'Password', autofocus: true });
    const err = h('div.err.hidden');
    const btn = h('button.btn.primary.lg.block', { onclick: attempt }, 'Unlock');

    async function attempt() {
      const value = pw.value;
      if (!value) return;
      btn.disabled = true;
      mount(btn, h('span.spinner'), ' Unlocking…');
      const res = await api.data.load(value);
      if (res.ok) {
        resolve(res);
        return;
      }
      btn.disabled = false;
      mount(btn, 'Unlock');
      err.textContent = describeLoadError(res.error);
      err.classList.remove('hidden');
      pw.select();
    }

    pw.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') attempt();
      err.classList.add('hidden');
    });

    mount(
      $('#app'),
      h(
        'div.gate',
        null,
        h(
          'div.gate-card',
          null,
          h('div.gate-logo', null, icon('lock', { size: 28 })),
          h('h1', null, 'Welcome back'),
          h('p.sub', null, 'Your data is encrypted on this computer. Enter your password to continue.'),
          h('div.gate-form', null, pw, err, btn),
          h(
            'p.tiny.dim.mt-16',
            null,
            'There is no password recovery — the password never leaves this machine. Restore a backup if you have lost it.'
          )
        )
      )
    );
    setTimeout(() => pw.focus(), 50);
  });
}

/* ------------------------- first-run wizard ----------------------- */

function firstRunWizard() {
  return new Promise((resolve) => {
    let step = 0;
    const draft = {
      accent: 'indigo',
      theme: 'system',
      currency: 'USD',
      accounts: [],
      password: '',
    };

    const host = h('div.gate');
    mount($('#app'), host);
    render();

    function render() {
      const steps = h(
        'div.steps',
        null,
        ...[0, 1, 2].map((i) =>
          h(`div.step${i < step ? '.done' : i === step ? '.now' : ''}`)
        )
      );
      const content = [stepWelcome, stepAccounts, stepSecurity][step]();
      mount(
        host,
        h('div.gate-card.wide', null, steps, ...content)
      );
    }

    function nextBtn(label, onClick, disabled = false) {
      return h(
        'div.row.mt-24',
        { style: { justifyContent: 'space-between' } },
        step > 0
          ? h('button.btn', { onclick: () => { step -= 1; render(); } }, icon('chevronLeft', { size: 15 }), 'Back')
          : h('div'),
        h('button.btn.primary.lg', { onclick: onClick, disabled }, label, icon('chevronRight', { size: 16 }))
      );
    }

    /* ---- step 1: welcome + look ---- */
    function stepWelcome() {
      const accents = ['indigo', 'blue', 'violet', 'teal', 'emerald', 'amber', 'rose'];
      const swatchRow = h(
        'div.swatches',
        null,
        ...accents.map((a) =>
          h('button.swatch-btn', {
            'aria-pressed': String(draft.accent === a),
            title: a,
            style: { background: accentPreview(a) },
            onclick: () => {
              draft.accent = a;
              document.documentElement.setAttribute('data-accent', a);
              render();
            },
          })
        )
      );
      const themeSel = select(
        [
          { value: 'system', label: 'Match Windows' },
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ],
        {
          value: draft.theme,
          onchange: (e) => {
            draft.theme = e.target.value;
            applyAppearance({ ...draft });
          },
        }
      );
      const currency = select(
        ['USD', 'CAD', 'EUR', 'GBP', 'AUD', 'NZD', 'MXN', 'JPY', 'INR', 'ZAR'].map((c) => ({ value: c, label: c })),
        { value: draft.currency, onchange: (e) => { draft.currency = e.target.value; } }
      );

      return [
        h('div.center', null, h('div.gate-logo', null, icon('trending', { size: 30, stroke: 2.2 }))),
        h('h1', { style: { textAlign: 'center' } }, 'Welcome to FinFolio'),
        h(
          'p.sub',
          { style: { textAlign: 'center' } },
          'Everything stays on this computer. Let’s set things up — it takes about a minute.'
        ),
        h(
          'div.grid.grid-2.mt-24',
          null,
          field('Theme', themeSel),
          field('Currency', currency)
        ),
        h('div.mt-16', null, h('div.label.mb-8', null, 'Accent colour'), swatchRow),
        nextBtn('Continue', () => { step = 1; render(); }),
      ];
    }

    /* ---- step 2: accounts ---- */
    function stepAccounts() {
      const list = h('div.col');
      const renderList = () => {
        mount(
          list,
          ...(draft.accounts.length
            ? draft.accounts.map((a, i) =>
                h(
                  'div.list-row.card',
                  null,
                  h('div.avatar', null, ACCOUNT_TYPES.find((t) => t.id === a.type)?.icon || '🏦'),
                  h(
                    'div.l-main',
                    null,
                    h('div.l-title', null, a.name),
                    h('div.l-sub', null, ACCOUNT_TYPES.find((t) => t.id === a.type)?.label)
                  ),
                  h('div.l-amount', null, a.balance.toFixed(2)),
                  h(
                    'button.btn.ghost.icon.sm',
                    { onclick: () => { draft.accounts.splice(i, 1); renderList(); } },
                    icon('trash', { size: 14 })
                  )
                )
              )
            : [h('p.muted.small', null, 'No accounts yet — add your checking account to begin.')])
        );
      };

      const nameI = textInput({ placeholder: 'e.g. Main Checking' });
      const typeI = select(ACCOUNT_TYPES.map((t) => ({ value: t.id, label: `${t.icon} ${t.label}` })), { value: 'checking' });
      const balI = moneyInput({});
      const add = () => {
        const name = nameI.value.trim();
        if (!name) {
          nameI.focus();
          return;
        }
        draft.accounts.push({ name, type: typeI.value, balance: readMoney(balI) });
        nameI.value = '';
        balI.querySelector('input').value = '';
        nameI.focus();
        renderList();
      };
      nameI.addEventListener('keydown', (e) => e.key === 'Enter' && add());

      renderList();
      return [
        h('h1', null, 'Add your accounts'),
        h(
          'p.sub',
          null,
          'Enter the balance shown by your bank today. For credit cards and loans, enter the amount you owe as a positive number.'
        ),
        h('div.mt-16', null, list),
        h(
          'div.card.pad.mt-16',
          null,
          h(
            'div.grid',
            { style: { gridTemplateColumns: '1.6fr 1.2fr 1fr auto', alignItems: 'end', gap: '10px' } },
            field('Account name', nameI),
            field('Type', typeI),
            field('Balance today', balI),
            h('button.btn.soft', { onclick: add }, icon('plus', { size: 15 }), 'Add')
          )
        ),
        nextBtn('Continue', () => { step = 2; render(); }),
      ];
    }

    /* ---- step 3: security ---- */
    function stepSecurity() {
      const wantPw = h('input', { type: 'checkbox' });
      const pw1 = h('input.input', { type: 'password', placeholder: 'Password', disabled: true });
      const pw2 = h('input.input', { type: 'password', placeholder: 'Confirm password', disabled: true });
      const strength = h('div.hint');
      const err = h('div.err.hidden');
      const pwBlock = h(
        'div.col.mt-12',
        { style: { opacity: '0.45' } },
        field('Password', pw1, { hint: 'At least 8 characters. There is no recovery if you forget it.' }),
        field('Confirm', pw2),
        strength
      );
      wantPw.addEventListener('change', () => {
        const on = wantPw.checked;
        pw1.disabled = !on;
        pw2.disabled = !on;
        pwBlock.style.opacity = on ? '1' : '0.45';
        if (on) pw1.focus();
      });
      pw1.addEventListener('input', async () => {
        const res = await api.data.scorePassword(pw1.value);
        strength.textContent = pw1.value ? `Strength: ${res.label}` : '';
      });

      const finish = async () => {
        err.classList.add('hidden');
        if (wantPw.checked) {
          if (pw1.value.length < 8) {
            err.textContent = 'Use at least 8 characters.';
            err.classList.remove('hidden');
            return;
          }
          if (pw1.value !== pw2.value) {
            err.textContent = 'The two passwords do not match.';
            err.classList.remove('hidden');
            return;
          }
          draft.password = pw1.value;
        }
        await applyWizard(draft);
        resolve();
      };

      return [
        h('h1', null, 'Protect your data'),
        h(
          'p.sub',
          null,
          'Optional. A password encrypts your data file with AES-256 so it cannot be read without it. You can turn this on later in Settings.'
        ),
        h(
          'div.card.pad.mt-16',
          null,
          h(
            'label.check',
            null,
            wantPw,
            h('span.box', null, icon('check', { size: 12, stroke: 3 })),
            h('span.strong', null, 'Require a password to open FinFolio')
          ),
          pwBlock,
          err
        ),
        h(
          'div.card.pad.mt-16',
          null,
          h('div.row', null, icon('shield', { size: 18 }), h('div.strong', null, 'Backups are on by default')),
          h(
            'p.muted.small.mt-8',
            null,
            'FinFolio keeps automatic backups in your app data folder and can export a backup file you can store anywhere. Settings → Backup has the details.'
          )
        ),
        nextBtn('Finish setup', finish),
      ];
    }
  });
}

function accentPreview(name) {
  return {
    indigo: '#5b5bd6',
    blue: '#1d4ed8',
    violet: '#6d28d9',
    teal: '#0f766e',
    emerald: '#15803d',
    amber: '#b45309',
    rose: '#be123c',
  }[name];
}

async function applyWizard(draft) {
  commit('Initial setup', (doc) => {
    doc.settings.theme = draft.theme;
    doc.settings.accent = draft.accent;
    doc.settings.currency = draft.currency;
    doc.settings.firstRunComplete = true;
    for (const a of draft.accounts) {
      const liability = isLiability(a.type);
      doc.accounts.push({
        id: uid('acc'),
        name: a.name,
        type: a.type,
        openingBalance: liability ? -Math.abs(a.balance) : a.balance,
        openingDate: today(),
        institution: '',
        color: ACCOUNT_TYPES.find((t) => t.id === a.type)?.color || '#2a78d6',
        archived: false,
        notes: '',
      });
    }
  });
  configureFormat(state.doc.settings);
  applyAppearance(state.doc.settings);
  await saveNow();
  if (draft.password) {
    const res = await api.data.setPassword(draft.password);
    if (!res.ok) toastErr('Could not enable encryption. Your data is saved, but unencrypted.');
  }
}

/* ---------------------------- updates ----------------------------- */

function wireUpdates() {
  api.updates.onEvent((payload) => {
    state.update = payload;
    notify('updates');
    if (payload.status === 'downloaded') {
      toast('An update is ready to install.', {
        title: `FinFolio ${payload.info ? payload.info.version : ''}`,
        tone: 'good',
        timeout: 0,
        action: { label: 'Restart now', onClick: () => api.updates.install() },
      });
    }
  });
  const s = (state.doc && state.doc.settings) || {};
  api.updates.prefs({ autoDownload: !!s.updatesAutoDownload });
  if (s.updatesAutoCheck !== false) api.updates.check();
}

/* ---------------------------- backups ----------------------------- */

async function maybeAutoBackup() {
  const s = (state.doc && state.doc.settings) || {};
  if (!s.autoBackup) return;
  const last = s.lastAutoBackup || '';
  if (last.slice(0, 10) === today()) return;
  const res = await api.backup.now(s.backupKeep || 20);
  if (res && res.ok) {
    state.doc.settings.lastAutoBackup = new Date().toISOString();
    saveNow();
  }
}

function flushOnExit() {
  window.addEventListener('beforeunload', () => {
    if (state.dirty) saveNow();
  });
  // Belt and braces: flush every 30s if anything is pending.
  setInterval(() => {
    if (state.dirty && !state.saving) saveNow();
  }, 30000);
}

export { renderView };
