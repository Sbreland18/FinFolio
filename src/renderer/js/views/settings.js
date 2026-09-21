import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { money, fmtDate, fmtDateTime, bytes, configureFormat, today } from '../format.js';
import { uid, categoryName } from '../finance.js';
import {
  field, textInput, select, switchRow, checkbox, segmented, toast, toastOk, toastErr,
  confirm, modal, categorySelect, emptyState, badge, moneyInput,
} from '../ui.js';
import { state, commit, setSetting, saveNow, navigate, removeFrom, upsert } from '../state.js';
import { page, applyAppearance, applyTheme, lockApp, showAbout } from '../shell.js';
import { openCategoryManager } from '../editors.js';
import { changeDataFolder, explainSync, reloadFromDisk, resolveConflict } from '../sync.js';

const api = window.finfolio;
const ui = { tab: 'general' };

const TABS = [
  { id: 'general', label: 'General', icon: 'sliders' },
  { id: 'appearance', label: 'Appearance', icon: 'sun' },
  { id: 'security', label: 'Security', icon: 'shield' },
  { id: 'backup', label: 'Backup & restore', icon: 'database' },
  { id: 'sync', label: 'Sync across computers', icon: 'refresh' },
  { id: 'categories', label: 'Categories & rules', icon: 'tag' },
  { id: 'updates', label: 'Updates', icon: 'refresh' },
  { id: 'data', label: 'Data & storage', icon: 'folder' },
];

export default function settings(doc, params = {}) {
  if (params.tab && params.tab !== ui._lastParamTab) {
    ui.tab = params.tab;
    ui._lastParamTab = params.tab;
  }
  const s = doc.settings;

  const nav = h(
    'div.card.pad',
    null,
    h(
      'div.settings-nav',
      null,
      ...TABS.map((t) =>
        h(
          'button',
          {
            'aria-selected': String(ui.tab === t.id),
            onclick: () => {
              ui.tab = t.id;
              navigate('settings', { tab: t.id });
            },
          },
          h('div.row.gap-8', null, icon(t.icon, { size: 16 }), t.label)
        )
      )
    )
  );

  const panes = {
    general: () => generalPane(s),
    appearance: () => appearancePane(s),
    security: () => securityPane(),
    backup: () => backupPane(s),
    sync: () => syncPane(),
    categories: () => categoriesPane(doc),
    updates: () => updatesPane(s),
    data: () => dataPane(doc),
  };

  return page({
    title: 'Settings',
    subtitle: 'FinFolio stores everything locally on this computer',
    children: [
      h(
        'div',
        { style: { display: 'grid', gridTemplateColumns: '230px minmax(0,1fr)', gap: '16px', alignItems: 'start' } },
        nav,
        panes[ui.tab]()
      ),
    ],
  });
}

/* ----------------------------- general ---------------------------- */

function generalPane(s) {
  const rerender = () => navigate('settings', { tab: 'general' });
  return card('General', [
    settingRow(
      'Currency',
      'Used for every amount in the app.',
      select(
        ['USD', 'CAD', 'EUR', 'GBP', 'AUD', 'NZD', 'MXN', 'JPY', 'INR', 'ZAR', 'BRL', 'CHF', 'SEK'].map((c) => ({ value: c, label: c })),
        {
          value: s.currency,
          onchange: (e) => {
            setSetting('currency', e.target.value);
            configureFormat(state.doc.settings);
            rerender();
          },
        }
      )
    ),
    settingRow(
      'Date format',
      'How dates appear in tables and cards.',
      select(
        [
          { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY' },
          { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY' },
          { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD' },
        ],
        {
          value: s.dateFormat,
          onchange: (e) => {
            setSetting('dateFormat', e.target.value);
            configureFormat(state.doc.settings);
            rerender();
          },
        }
      )
    ),
    settingRow(
      'Week starts on',
      'Affects the calendar grid.',
      select(
        [
          { value: '0', label: 'Sunday' },
          { value: '1', label: 'Monday' },
        ],
        { value: String(s.startOfWeek), onchange: (e) => setSetting('startOfWeek', Number(e.target.value)) }
      )
    ),
    settingRow(
      'Forecast horizon',
      'How far ahead the dashboard projects your balance.',
      select(
        [30, 60, 90, 180, 365].map((d) => ({ value: String(d), label: `${d} days` })),
        { value: String(s.forecastDays), onchange: (e) => setSetting('forecastDays', Number(e.target.value)) }
      )
    ),
    settingRow(
      'Low balance warning',
      'FinFolio warns when the forecast dips below this.',
      numberField(s.lowBalanceThreshold, (v) => setSetting('lowBalanceThreshold', v))
    ),
    settingRow(
      'Upcoming window',
      'Bills due within this window appear on the dashboard and in the sidebar badge.',
      select(
        [7, 14, 21, 30].map((d) => ({ value: String(d), label: `${d} days` })),
        { value: String(s.upcomingWindowDays), onchange: (e) => setSetting('upcomingWindowDays', Number(e.target.value)) }
      )
    ),
    switchRow(
      'Clear interest and fees automatically',
      'Interest and bank fees charged to a card or loan are posted by the lender, so there is ' +
        'nothing pending about them. FinFolio ticks “cleared” for you.',
      {
        checked: s.autoClearCharges !== false,
        onchange: (e) => setSetting('autoClearCharges', e.target.checked),
      }
    ),
  ]);
}

/* --------------------------- appearance --------------------------- */

function appearancePane(s) {
  const accents = ['indigo', 'blue', 'violet', 'teal', 'emerald', 'amber', 'rose'];
  const preview = {
    indigo: '#5b5bd6', blue: '#1d4ed8', violet: '#6d28d9',
    teal: '#0f766e', emerald: '#15803d', amber: '#b45309', rose: '#be123c',
  };
  return card('Appearance', [
    settingRow(
      'Theme',
      'Dark mode uses its own palette, not an inverted one.',
      segmented(
        [
          { value: 'system', label: 'System' },
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ],
        s.theme,
        (v) => {
          setSetting('theme', v);
          applyTheme(v);
        }
      )
    ),
    settingRow(
      'Accent colour',
      'Used for highlights, buttons and the active navigation item.',
      h(
        'div.swatches',
        null,
        ...accents.map((a) =>
          h('button.swatch-btn', {
            'aria-pressed': String(s.accent === a),
            title: a,
            style: { background: preview[a] },
            onclick: () => {
              setSetting('accent', a);
              document.documentElement.setAttribute('data-accent', a);
              navigate('settings', { tab: 'appearance' });
            },
          })
        )
      )
    ),
    settingRow(
      'Density',
      'Compact fits more rows on screen.',
      segmented(
        [
          { value: 'comfortable', label: 'Comfortable' },
          { value: 'compact', label: 'Compact' },
        ],
        s.density,
        (v) => {
          setSetting('density', v);
          document.documentElement.setAttribute('data-density', v);
        }
      )
    ),
    switchRow('Privacy mode', 'Blur every amount until you hover it. Handy when sharing a screen.', {
      checked: !!s.hideAmounts,
      onchange: (e) => {
        setSetting('hideAmounts', e.target.checked);
        document.documentElement.setAttribute('data-privacy', e.target.checked ? 'on' : 'off');
      },
    }),
  ]);
}

/* ---------------------------- security ---------------------------- */

function securityPane() {
  const box = h('div.col.gap-16');

  const render = async () => {
    const status = await api.data.status();
    mount(
      box,
      card('Security', [
        h(
          'div.card.pad',
          {
            style: {
              background: status.encrypted ? 'var(--pos-soft)' : 'var(--surface-2)',
              borderColor: 'transparent',
            },
          },
          h(
            'div.row',
            null,
            h(
              'span',
              { style: { color: status.encrypted ? 'var(--pos)' : 'var(--text-3)', display: 'flex' } },
              icon(status.encrypted ? 'lock' : 'unlock', { size: 20 })
            ),
            h(
              'div.grow',
              null,
              h('div.strong', null, status.encrypted ? 'Your data file is encrypted' : 'Your data file is not encrypted'),
              h(
                'div.small.muted.mt-4',
                null,
                status.encrypted
                  ? 'AES-256-GCM with a key derived from your password (scrypt). FinFolio asks for it on every launch.'
                  : 'Anyone with access to this Windows account can open the data file. Turning on a password encrypts it.'
              )
            )
          )
        ),
        status.encrypted
          ? h(
              'div.row.gap-8',
              null,
              h('button.btn', { onclick: () => changePassword(render) }, icon('edit', { size: 15 }), 'Change password'),
              h('button.btn', { onclick: () => lockApp() }, icon('lock', { size: 15 }), 'Lock now'),
              h(
                'button.btn.danger-soft',
                { onclick: () => removePassword(render) },
                icon('unlock', { size: 15 }),
                'Turn off encryption'
              )
            )
          : h('button.btn.primary', { onclick: () => setPassword(render) }, icon('lock', { size: 15 }), 'Set a password'),
        h(
          'div.card.pad.mt-8',
          null,
          h('div.h3', null, 'Important'),
          h(
            'ul.col.gap-8.mt-8.muted.small',
            null,
            h('li', null, '• There is no password recovery. The password is never stored or transmitted.'),
            h('li', null, '• Encrypted backups need the password that was set when the backup was made.'),
            h('li', null, '• Keep at least one backup somewhere other than this computer.')
          )
        ),
      ])
    );
  };
  render();
  return box;
}

function setPassword(after) {
  const p1 = h('input.input', { type: 'password', placeholder: 'New password', autofocus: true });
  const p2 = h('input.input', { type: 'password', placeholder: 'Confirm password' });
  const strength = h('div.hint');
  const err = h('div.err.hidden');
  p1.addEventListener('input', async () => {
    const r = await api.data.scorePassword(p1.value);
    strength.textContent = p1.value ? `Strength: ${r.label}` : '';
  });
  const m = modal({
    title: 'Set a password',
    size: 'sm',
    body: h(
      'div.col.gap-12',
      null,
      h('p.muted.small', null, 'This encrypts your data file. Write the password down somewhere safe — it cannot be recovered.'),
      p1,
      strength,
      p2,
      err
    ),
    footer: [
      h('button.btn', { onclick: () => m.close() }, 'Cancel'),
      h(
        'button.btn.primary',
        {
          onclick: async () => {
            if (p1.value.length < 8) {
              err.textContent = 'Use at least 8 characters.';
              err.classList.remove('hidden');
              return;
            }
            if (p1.value !== p2.value) {
              err.textContent = 'The passwords do not match.';
              err.classList.remove('hidden');
              return;
            }
            const res = await api.data.setPassword(p1.value);
            m.close();
            if (res.ok) toastOk('Encryption enabled');
            else toastErr('Could not enable encryption');
            after();
          },
        },
        'Enable encryption'
      ),
    ],
  });
}

function changePassword(after) {
  const cur = h('input.input', { type: 'password', placeholder: 'Current password', autofocus: true });
  const p1 = h('input.input', { type: 'password', placeholder: 'New password' });
  const p2 = h('input.input', { type: 'password', placeholder: 'Confirm new password' });
  const err = h('div.err.hidden');
  const m = modal({
    title: 'Change password',
    size: 'sm',
    body: h('div.col.gap-12', null, cur, p1, p2, err),
    footer: [
      h('button.btn', { onclick: () => m.close() }, 'Cancel'),
      h(
        'button.btn.primary',
        {
          onclick: async () => {
            const check = await api.data.verifyPassword(cur.value);
            if (!check.matches) {
              err.textContent = 'Current password is incorrect.';
              err.classList.remove('hidden');
              return;
            }
            if (p1.value.length < 8 || p1.value !== p2.value) {
              err.textContent = 'New passwords must match and be at least 8 characters.';
              err.classList.remove('hidden');
              return;
            }
            await api.data.setPassword(p1.value);
            m.close();
            toastOk('Password changed');
            after();
          },
        },
        'Change it'
      ),
    ],
  });
}

async function removePassword(after) {
  const cur = h('input.input', { type: 'password', placeholder: 'Current password', autofocus: true });
  const err = h('div.err.hidden');
  const m = modal({
    title: 'Turn off encryption?',
    size: 'sm',
    body: h(
      'div.col.gap-12',
      null,
      h('p.muted.small', null, 'Your data file will be stored as readable JSON on this computer.'),
      cur,
      err
    ),
    footer: [
      h('button.btn', { onclick: () => m.close() }, 'Cancel'),
      h(
        'button.btn.danger',
        {
          onclick: async () => {
            const check = await api.data.verifyPassword(cur.value);
            if (!check.matches) {
              err.textContent = 'Password is incorrect.';
              err.classList.remove('hidden');
              return;
            }
            await api.data.setPassword(null);
            m.close();
            toast('Encryption turned off');
            after();
          },
        },
        'Turn it off'
      ),
    ],
  });
}

/* ----------------------------- backup ----------------------------- */

function backupPane(s) {
  const listBox = h('div.col.gap-8');

  const refresh = async () => {
    const res = await api.backup.list();
    const items = (res && res.items) || [];
    mount(
      listBox,
      items.length
        ? h(
            'div.card',
            null,
            h('div.card-body.flush', null,
              ...items.slice(0, 12).map((b) =>
                h(
                  'div.list-row',
                  null,
                  h('div.avatar', null, icon('database', { size: 16 })),
                  h(
                    'div.l-main',
                    null,
                    h('div.l-title', null, fmtDateTime(b.modified)),
                    h('div.l-sub.mono', null, `${b.name} · ${bytes(b.size)}`)
                  ),
                  h(
                    'button.btn.sm',
                    { onclick: () => import('../backup.js').then((m) => m.restoreFromPath(b.path)) },
                    'Restore'
                  ),
                  h(
                    'button.btn.ghost.icon.sm',
                    {
                      title: 'Delete',
                      onclick: async () => {
                        if (await confirm({ title: 'Delete this backup?', confirmLabel: 'Delete', tone: 'danger' })) {
                          await api.backup.remove(b.path);
                          refresh();
                        }
                      },
                    },
                    icon('trash', { size: 14 })
                  )
                )
              )
            )
          )
        : h('p.muted.small', null, 'No automatic backups yet.')
    );
  };
  refresh();

  return h(
    'div.col.gap-16',
    null,
    cloudBackupCard(s),
    card('Backup & restore', [
      h(
        'div.row.wrap.gap-8',
        null,
        h(
          'button.btn.primary',
          { onclick: () => import('../backup.js').then((m) => m.exportBackup()) },
          icon('download', { size: 15 }),
          'Export a backup file'
        ),
        h(
          'button.btn',
          { onclick: () => import('../backup.js').then((m) => m.restoreFromFile()) },
          icon('upload', { size: 15 }),
          'Restore from a file'
        ),
        h(
          'button.btn',
          {
            onclick: async () => {
              await import('../backup.js').then((m) => m.backupNow());
              refresh();
            },
          },
          icon('save', { size: 15 }),
          'Back up now'
        ),
        h('button.btn', { onclick: () => api.backup.openFolder() }, icon('folder', { size: 15 }), 'Open backup folder')
      ),
      h(
        'p.muted.small.mt-12',
        null,
        'A backup file (.finbak) contains everything: accounts, transactions, bills, budgets, goals and settings. Keep a copy on a USB drive or in cloud storage — if you ever reinstall FinFolio, “Restore from a file” brings it all back.'
      ),
      switchRow('Automatic daily backup', 'Creates a backup the first time you open FinFolio each day.', {
        checked: !!s.autoBackup,
        onchange: (e) => setSetting('autoBackup', e.target.checked),
      }),
      switchRow('Back up when closing', 'Also writes a backup when you quit the app.', {
        checked: !!s.backupOnQuit,
        onchange: (e) => setSetting('backupOnQuit', e.target.checked),
      }),
      settingRow(
        'Backups to keep',
        'Older automatic backups are deleted beyond this count.',
        select([5, 10, 20, 50, 100].map((n) => ({ value: String(n), label: String(n) })), {
          value: String(s.backupKeep),
          onchange: (e) => setSetting('backupKeep', Number(e.target.value)),
        })
      ),
    ]),
    h('div', null, h('div.eyebrow.mb-8', null, 'Recent automatic backups'), listBox)
  );
}

/* ----------------------- cloud backup copies ---------------------- */

/**
 * Automatic backups are written next to the data file, which is no help at all
 * if the computer is lost. This keeps a second copy in a folder that Google
 * Drive, OneDrive or Dropbox already syncs.
 */
function cloudBackupCard(s) {
  const box = h('div.card');

  const render = async () => {
    const status = await api.backup.mirrorStatus();
    const suggestions = ((await api.backup.suggestFolders()) || {}).folders || [];
    const on = !!status.configured;

    const choose = async (dir, createIfMissing) => {
      const test = await api.backup.testFolder(dir, createIfMissing);
      if (!test.ok) {
        toastErr(describeFolderError(test, dir), { title: 'Could not use that folder' });
        return;
      }
      setSetting('backupMirrorDir', test.dir);
      await saveNow();
      const synced = await api.backup.syncMirror(s.backupKeep || 20);
      if (synced.ok) {
        toastOk(
          synced.copied
            ? `Backups will be copied there. ${synced.copied} existing backup${synced.copied === 1 ? '' : 's'} copied over.`
            : 'Backups will be copied there from now on.'
        );
      } else {
        toastErr(`The folder was set, but copying existing backups failed (${synced.error}).`);
      }
      render();
    };

    mount(
      box,
      h(
        'div.card-head',
        null,
        h(
          'div',
          null,
          h('div.h2', null, 'Keep a copy in the cloud'),
          h('div.small.muted', null, 'So a lost computer does not mean lost records')
        ),
        on ? badge('On', 'good') : badge('Off')
      ),
      h(
        'div.card-body',
        null,
        on
          ? h(
              'div.card.pad',
              {
                style: {
                  background: status.reachable ? 'var(--pos-soft)' : 'var(--warn-soft)',
                  borderColor: 'transparent',
                },
              },
              h(
                'div.row',
                null,
                h(
                  'span',
                  { style: { color: status.reachable ? 'var(--pos)' : 'var(--warn)', display: 'flex' } },
                  icon(status.reachable ? 'shield' : 'alert', { size: 20 })
                ),
                h(
                  'div.grow',
                  null,
                  h(
                    'div.strong',
                    null,
                    status.reachable
                      ? `${status.count} backup${status.count === 1 ? '' : 's'} in your cloud folder`
                      : 'That folder is not reachable right now'
                  ),
                  h('div.mono.tiny.dim.mt-4.selectable', null, status.dir),
                  status.newest
                    ? h('div.small.muted.mt-4', null, `Newest copy ${fmtDateTime(status.newest)}`)
                    : null
                )
              )
            )
          : h(
              'p.muted.small',
              null,
              'Pick a folder that Google Drive, OneDrive or Dropbox already syncs. Every automatic backup is copied there as well as kept on this computer, so the cloud app uploads it for you.'
            ),
        suggestions.length
          ? h(
              'div.mt-16',
              null,
              h('div.label.mb-8', null, on ? 'Move it to' : 'Detected on this computer'),
              h(
                'div.row.wrap.gap-8',
                null,
                ...suggestions.map((f) =>
                  h(
                    'button.btn.sm',
                    { title: f.dir, onclick: () => choose(f.dir, true) },
                    icon('folder', { size: 14 }),
                    f.label
                  )
                )
              )
            )
          : h(
              'p.tiny.dim.mt-12',
              null,
              'No cloud folders detected. If Google Drive or OneDrive is installed, sign in and let it finish setting up, then reopen this screen — or use “Choose a folder…”.'
            ),
        h(
          'div.row.wrap.gap-8.mt-16',
          null,
          h(
            'button.btn.primary',
            {
              onclick: async () => {
                const picked = await api.data.pickFolder();
                if (picked.ok) choose(picked.dir, false);
              },
            },
            icon('folder', { size: 15 }),
            'Choose a folder…'
          ),
          on
            ? h(
                'button.btn',
                {
                  onclick: async () => {
                    const res = await api.backup.syncMirror(s.backupKeep || 20);
                    if (res.ok) toastOk(res.copied ? `Copied ${res.copied} backup(s)` : 'Already up to date');
                    else toastErr(`Could not copy backups (${res.error}).`);
                    render();
                  },
                },
                icon('refresh', { size: 15 }),
                'Copy now'
              )
            : null,
          on ? h('button.btn', { onclick: () => api.backup.openMirror() }, icon('folder', { size: 15 }), 'Open folder') : null,
          on
            ? h(
                'button.btn.ghost',
                {
                  onclick: async () => {
                    const ok = await confirm({
                      title: 'Stop copying backups there?',
                      message: 'Backups already in that folder are left alone. This computer keeps its own backups either way.',
                      confirmLabel: 'Turn off',
                    });
                    if (!ok) return;
                    setSetting('backupMirrorDir', '');
                    await saveNow();
                    toast('Cloud copies turned off');
                    render();
                  },
                },
                'Turn off'
              )
            : null
        ),
        on
          ? h(
              'p.tiny.dim.mt-12',
              null,
              'Only the backup files are copied — your live data file stays on this computer. To share the live file between computers instead, use Sync across computers.'
            )
          : null
      )
    );
  };
  render();
  return box;
}

function describeFolderError(result, dir) {
  const detail = result.detail ? ` (${result.detail})` : '';
  return (
    {
      NOT_A_FOLDER: `${dir} is a file, not a folder.`,
      MISSING: `${dir} does not exist.`,
      CANNOT_CREATE: `FinFolio could not create ${dir}${detail}. If this is a cloud folder, make sure the app is signed in and has finished setting up.`,
      UNWRITABLE: `FinFolio cannot write to ${dir}${detail}. On a work computer the folder may be read-only, or the cloud app may still be syncing.`,
    }[result.error] || `Could not use that folder (${result.error}${detail}).`
  );
}

/* ------------------------------- sync ----------------------------- */

function syncPane() {
  const box = h('div.col.gap-16');

  const render = async () => {
    const status = await api.data.status();
    const suggestions = (await api.data.suggestFolders()).folders || [];
    const synced = !status.isDefaultLocation;

    mount(
      box,
      h(
        'div.card',
        null,
        h('div.card-head', null, h('div.h2', null, 'Where your data is stored')),
        h(
          'div.card-body',
          null,
          h(
            'div.card.pad',
            {
              style: {
                background: synced ? 'var(--pos-soft)' : 'var(--surface-2)',
                borderColor: 'transparent',
              },
            },
            h(
              'div.row',
              null,
              h(
                'span',
                { style: { color: synced ? 'var(--pos)' : 'var(--text-3)', display: 'flex' } },
                icon(synced ? 'refresh' : 'monitor', { size: 20 })
              ),
              h(
                'div.grow',
                null,
                h('div.strong', null, synced ? 'Stored in a shared folder' : 'Stored on this computer only'),
                h('div.mono.tiny.dim.mt-4.selectable', null, status.path || '')
              )
            ),
            h(
              'p.muted.small.mt-8',
              null,
              synced
                ? 'Other computers that point at this same folder share the data. FinFolio watches the file and offers to merge when another computer changes it.'
                : 'To use FinFolio on more than one computer, move the data file into a folder that OneDrive, Dropbox or Google Drive already syncs.'
            )
          ),
          suggestions.length
            ? h(
                'div.mt-16',
                null,
                h('div.label.mb-8', null, 'Detected on this computer'),
                h(
                  'div.row.wrap.gap-8',
                  null,
                  ...suggestions.map((f) =>
                    h(
                      'button.btn.sm',
                      {
                        title: f.dir,
                        onclick: async () => {
                          if (await changeDataFolder(f.dir)) render();
                        },
                      },
                      icon('folder', { size: 14 }),
                      `Use ${f.label}`
                    )
                  )
                )
              )
            : null,
          h(
            'div.row.wrap.gap-8.mt-16',
            null,
            h(
              'button.btn.primary',
              {
                onclick: async () => {
                  if (await changeDataFolder()) render();
                },
              },
              icon('folder', { size: 15 }),
              'Choose a folder…'
            ),
            synced
              ? h(
                  'button.btn',
                  {
                    onclick: async () => {
                      const ok = await confirm({
                        title: 'Store data on this computer again?',
                        message: 'The data is copied back into this computer’s own folder and will no longer be shared with your other computers.',
                        confirmLabel: 'Bring it back',
                      });
                      if (!ok) return;
                      const res = await api.data.resetLocation();
                      if (res.ok) {
                        toastOk('Data is back on this computer');
                        render();
                      } else toastErr(`Could not move it back (${res.error}).`);
                    },
                  },
                  'Store on this computer again'
                )
              : null,
            h('button.btn', { onclick: () => api.data.revealInFolder() }, icon('folder', { size: 15 }), 'Show the file'),
            h('button.btn.ghost', { onclick: () => explainSync() }, icon('help', { size: 15 }), 'How this works')
          )
        )
      ),
      synced
        ? h(
            'div.card',
            null,
            h('div.card-head', null, h('div.h3', null, 'Right now')),
            h(
              'div.card-body',
              null,
              h(
                'dl.kv',
                null,
                h('dt', null, 'File last changed'),
                h('dd', null, status.modified ? fmtDateTime(status.modified) : '—'),
                h('dt', null, 'Changed by another computer'),
                h('dd', { class: status.changedElsewhere ? 'neg' : '' }, status.changedElsewhere ? 'yes — not loaded yet' : 'no')
              ),
              h(
                'div.row.gap-8.mt-16',
                null,
                h(
                  'button.btn',
                  {
                    onclick: async () => {
                      const res = await api.data.changedElsewhere();
                      if (res.changed) {
                        toast('There is a newer version — choose what to keep.', { tone: 'warn' });
                        await resolveConflict({ triggeredBySave: false });
                      } else {
                        toastOk('Already up to date');
                      }
                      render();
                    },
                  },
                  icon('refresh', { size: 15 }),
                  'Check for changes now'
                ),
                h(
                  'button.btn',
                  {
                    onclick: async () => {
                      if (
                        state.dirty &&
                        !(await confirm({
                          title: 'Discard this computer’s unsaved changes?',
                          message: 'Reloading takes the version in the shared folder.',
                          confirmLabel: 'Reload anyway',
                          tone: 'danger',
                        }))
                      ) {
                        return;
                      }
                      await reloadFromDisk();
                      render();
                    },
                  },
                  'Reload from the folder'
                )
              )
            )
          )
        : null,
      h(
        'div.card',
        null,
        h('div.card-head', null, h('div.h3', null, 'No cloud folder? Use backup files')),
        h(
          'div.card-body',
          null,
          h(
            'p.muted.small',
            null,
            'Export a backup on one computer, then on the other choose Restore and pick “Merge”. Both computers’ records are combined, newer edits win, and anything you deleted stays deleted.'
          ),
          h(
            'div.row.gap-8.mt-12',
            null,
            h(
              'button.btn',
              { onclick: () => import('../backup.js').then((m) => m.exportBackup()) },
              icon('download', { size: 15 }),
              'Export a backup'
            ),
            h(
              'button.btn',
              { onclick: () => import('../backup.js').then((m) => m.restoreFromFile()) },
              icon('upload', { size: 15 }),
              'Import & merge a backup'
            )
          )
        )
      )
    );
  };
  render();
  return box;
}

/* --------------------------- categories --------------------------- */

function categoriesPane(doc) {
  const rules = doc.rules || [];
  return h(
    'div.col.gap-16',
    null,
    card('Categories', [
      h('p.muted.small', null, `${doc.categories.filter((c) => !c.archived).length} active categories.`),
      h('button.btn.mt-12', { onclick: () => openCategoryManager() }, icon('tag', { size: 15 }), 'Manage categories'),
    ]),
    h(
      'div.card',
      null,
      h(
        'div.card-head',
        null,
        h('div', null, h('div.h2', null, 'Auto-categorisation rules'), h('div.small.muted', null, 'Applied when importing statements')),
        h('button.btn.sm.primary', { onclick: () => editRule(null) }, icon('plus', { size: 14 }), 'New rule')
      ),
      rules.length
        ? h(
            'div.card-body.flush',
            null,
            ...rules.map((r) =>
              h(
                'div.list-row',
                null,
                h('div.avatar', null, icon('wand', { size: 15 })),
                h(
                  'div.l-main',
                  null,
                  h(
                    'div.l-title',
                    null,
                    `If ${r.field || 'payee'} ${opLabel(r.op)} “${r.value}”`
                  ),
                  h(
                    'div.l-sub',
                    null,
                    [
                      r.categoryId ? `set category to ${categoryName(doc, r.categoryId)}` : null,
                      r.renamePayee ? `rename payee to “${r.renamePayee}”` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ') || 'no action'
                  )
                ),
                r.enabled === false ? badge('Off') : null,
                h('button.btn.ghost.icon.sm', { onclick: () => editRule(r) }, icon('edit', { size: 14 })),
                h(
                  'button.btn.ghost.icon.sm',
                  {
                    onclick: async () => {
                      if (await confirm({ title: 'Delete this rule?', confirmLabel: 'Delete', tone: 'danger' })) {
                        removeFrom('rules', r.id, 'Delete rule');
                      }
                    },
                  },
                  icon('trash', { size: 14 })
                )
              )
            )
          )
        : h(
            'div.card-body',
            null,
            h(
              'p.muted.small',
              null,
              'No rules yet. A rule like “payee contains KROGER → Groceries” saves a lot of clicking when you import a statement.'
            )
          )
    )
  );
}

function opLabel(op) {
  return { equals: 'is', startsWith: 'starts with', endsWith: 'ends with', regex: 'matches', contains: 'contains' }[op || 'contains'];
}

function editRule(rule) {
  const doc = state.doc;
  const fieldSel = select(
    [
      { value: 'payee', label: 'Payee' },
      { value: 'notes', label: 'Note / memo' },
    ],
    { value: (rule && rule.field) || 'payee' }
  );
  const opSel = select(
    [
      { value: 'contains', label: 'contains' },
      { value: 'equals', label: 'is exactly' },
      { value: 'startsWith', label: 'starts with' },
      { value: 'endsWith', label: 'ends with' },
      { value: 'regex', label: 'matches regex' },
    ],
    { value: (rule && rule.op) || 'contains' }
  );
  const valueI = textInput({ value: (rule && rule.value) || '', placeholder: 'KROGER' });
  const catSel = categorySelect(doc, { value: rule && rule.categoryId, kind: 'expense' });
  const renameI = textInput({ value: (rule && rule.renamePayee) || '', placeholder: 'Optional clean name' });
  const enabledI = checkbox('Enabled', { checked: !rule || rule.enabled !== false });

  const m = modal({
    title: rule ? 'Edit rule' : 'New rule',
    body: h(
      'div.col.gap-16',
      null,
      h('div.grid.grid-3', null, field('Field', fieldSel), field('Test', opSel), field('Value', valueI)),
      field('Set category to', catSel),
      field('Rename payee to', renameI, { hint: 'Leave blank to keep the imported name.' }),
      enabledI
    ),
    footer: [
      h('button.btn', { onclick: () => m.close() }, 'Cancel'),
      h(
        'button.btn.primary',
        {
          onclick: () => {
            if (!valueI.value.trim()) {
              toast('Enter a value to match.', { tone: 'warn' });
              return;
            }
            upsert(
              'rules',
              {
                id: rule ? rule.id : uid('rule'),
                field: fieldSel.value,
                op: opSel.value,
                value: valueI.value.trim(),
                categoryId: catSel.value,
                renamePayee: renameI.value.trim(),
                enabled: enabledI.querySelector('input').checked,
                priority: rule ? rule.priority || 0 : (state.doc.rules || []).length,
              },
              rule ? 'Edit rule' : 'Add rule'
            );
            m.close();
          },
        },
        'Save rule'
      ),
    ],
  });
}

/* ----------------------------- updates ---------------------------- */

function updatesPane(s) {
  const box = h('div.col.gap-16');

  const paint = (u) => {
    const status = u.status || 'idle';
    const map = {
      checking: ['Checking for updates…', 'info'],
      available: [`Version ${u.info ? u.info.version : ''} is available`, 'accent'],
      downloading: [`Downloading… ${u.progress ? u.progress.percent : 0}%`, 'info'],
      downloaded: ['Update ready to install', 'good'],
      current: ['You are on the latest version', 'good'],
      error: [`Update check failed: ${u.error || ''}`, 'bad'],
      dev: ['Updates are disabled while running from source', ''],
      unsupported: ['Updates are unavailable in this build', ''],
      idle: ['Not checked yet', ''],
    };
    const [text, tone] = map[status] || map.idle;

    mount(
      box,
      card('Updates', [
        h(
          'div.row.gap-12',
          null,
          h(
            'div.grow',
            null,
            h('div.h3', null, `FinFolio ${u.currentVersion || (state.appInfo && state.appInfo.version) || ''}`),
            h('div.row.gap-8.mt-4', null, badge(text, tone))
          ),
          status === 'available'
            ? h('button.btn.primary', { onclick: () => api.updates.download() }, icon('download', { size: 15 }), 'Download')
            : status === 'downloaded'
              ? h('button.btn.primary', { onclick: () => api.updates.install() }, icon('refresh', { size: 15 }), 'Restart & install')
              : h(
                  'button.btn',
                  { onclick: async () => { await api.updates.check(); } },
                  icon('refresh', { size: 15 }),
                  'Check now'
                )
        ),
        u.progress && status === 'downloading'
          ? h('div.bar.tall.mt-12', null, h('i', { style: { width: `${u.progress.percent}%` } }))
          : null,
        u.info && u.info.releaseNotes
          ? h(
              'div.card.pad.mt-12',
              null,
              h('div.h3.mb-8', null, `What’s new in ${u.info.version}`),
              h('div.small.muted.selectable', { html: sanitise(u.info.releaseNotes) })
            )
          : null,
        switchRow('Check for updates automatically', 'On launch and every six hours.', {
          checked: s.updatesAutoCheck !== false,
          onchange: (e) => setSetting('updatesAutoCheck', e.target.checked),
        }),
        switchRow('Download updates automatically', 'Otherwise FinFolio asks first.', {
          checked: !!s.updatesAutoDownload,
          onchange: (e) => {
            setSetting('updatesAutoDownload', e.target.checked);
            api.updates.prefs({ autoDownload: e.target.checked });
          },
        }),
        h(
          'p.muted.small.mt-12',
          null,
          'Updates are published as GitHub Releases on ',
          h(
            'a',
            { href: '#', onclick: (e) => { e.preventDefault(); api.shell.openExternal('https://github.com/Sbreland18/finfolio/releases'); } },
            'Sbreland18/finfolio'
          ),
          '. Your data is never sent anywhere — only the release feed is fetched.'
        ),
      ])
    );
  };

  api.updates.state().then(paint);
  api.updates.onEvent(paint);
  return box;
}

function sanitise(html) {
  // Release notes come from GitHub; strip anything executable before injecting.
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/ on\w+="[^"]*"/gi, '')
    .replace(/javascript:/gi, '');
}

/* ------------------------------ data ------------------------------ */

function dataPane(doc) {
  const box = h('div.col.gap-16');
  api.data.status().then((status) => {
    mount(
      box,
      card('Data & storage', [
        h(
          'dl.kv',
          null,
          h('dt', null, 'Accounts'), h('dd', null, String(doc.accounts.length)),
          h('dt', null, 'Transactions'), h('dd', null, String(doc.transactions.length)),
          h('dt', null, 'Scheduled items'), h('dd', null, String(doc.recurring.length)),
          h('dt', null, 'Categories'), h('dd', null, String(doc.categories.length)),
          h('dt', null, 'Budgets'), h('dd', null, String(doc.budgets.length)),
          h('dt', null, 'Goals'), h('dd', null, String(doc.goals.length)),
          h('dt', null, 'File size'), h('dd', null, bytes(status.size || 0)),
          h('dt', null, 'Last saved'), h('dd', null, doc.meta && doc.meta.updatedAt ? fmtDateTime(doc.meta.updatedAt) : '—')
        ),
        h('div.mono.tiny.dim.mt-12.selectable', null, status.path || ''),
        h(
          'div.row.gap-8.mt-12',
          null,
          h('button.btn', { onclick: () => api.data.revealInFolder() }, icon('folder', { size: 15 }), 'Show data file'),
          h(
            'button.btn',
            { onclick: () => import('../exporter.js').then((m) => m.exportTransactionsCsv()) },
            icon('download', { size: 15 }),
            'Export all transactions (CSV)'
          ),
          h('button.btn', { onclick: () => showAbout() }, icon('info', { size: 15 }), 'About')
        ),
      ]),
      h(
        'div.card',
        { style: { borderColor: 'var(--neg)' } },
        h('div.card-head', null, h('div.h3.neg', null, 'Danger zone')),
        h(
          'div.card-body',
          null,
          h('p.muted.small', null, 'Erasing starts a brand-new empty file. A backup of the current data is written first, but export your own copy too.'),
          h(
            'button.btn.danger.mt-12',
            {
              onclick: async () => {
                const ok = await confirm({
                  title: 'Erase all data?',
                  message: 'Every account, transaction, bill, budget and goal will be removed from this computer.',
                  confirmLabel: 'Erase everything',
                  tone: 'danger',
                });
                if (!ok) return;
                await api.backup.now(50);
                commit('Erase all data', (d) => {
                  d.accounts = [];
                  d.transactions = [];
                  d.recurring = [];
                  d.budgets = [];
                  d.goals = [];
                  d.rules = [];
                  d.payees = [];
                });
                await saveNow();
                toast('All data erased. A backup was saved first.');
                navigate('dashboard');
              },
            },
            icon('trash', { size: 15 }),
            'Erase all data'
          )
        )
      )
    );
  });
  return box;
}

/* ---------------------------- helpers ----------------------------- */

function card(title, children) {
  return h(
    'div.card',
    null,
    h('div.card-head', null, h('div.h2', null, title)),
    h('div.card-body', null, ...[].concat(children).filter(Boolean))
  );
}

function settingRow(title, desc, control) {
  return h(
    'div.setting-row',
    null,
    h('div.s-main', null, h('div.s-title', null, title), desc ? h('div.s-desc', null, desc) : null),
    h('div.s-control', null, control)
  );
}

function numberField(value, onChange) {
  return h('input.input.amount', {
    type: 'number',
    value: Number(value) || 0,
    style: { width: '120px' },
    onchange: (e) => onChange(Number(e.target.value) || 0),
  });
}
