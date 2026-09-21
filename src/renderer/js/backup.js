/**
 * Backup and restore.
 *
 * A .finbak file is a JSON envelope holding the whole document — accounts,
 * transactions, schedules, budgets, goals and settings — optionally encrypted
 * with AES-256. Restoring always writes a safety snapshot of the current data
 * first, so an accidental restore is recoverable.
 */

import { h } from './dom.js';
import { icon } from './icons.js';
import { fmtDateTime, bytes, today } from './format.js';
import { modal, confirm, field, checkbox, toast, toastOk, toastErr, badge } from './ui.js';
import { state, saveNow, setDoc } from './state.js';
import { configureFormat } from './format.js';
import { statsList, describeStats } from './sync.js';

const api = window.finfolio;

export async function backupNow() {
  await saveNow();
  const keep = (state.doc && state.doc.settings.backupKeep) || 20;
  const res = await api.backup.now(keep);
  if (!res || !res.ok) {
    toastErr(`Backup failed (${(res && res.error) || 'unknown'})`);
    return res;
  }
  if (res.mirror && res.mirror.ok === false) {
    // The local backup succeeded; only the cloud copy did not.
    toast('Backup saved on this computer, but the cloud copy failed.', {
      title: `Cloud folder unavailable (${res.mirror.error})`,
      tone: 'warn',
      timeout: 7000,
    });
  } else if (res.mirror && res.mirror.ok) {
    toastOk('Backup created', { title: 'Saved here and copied to your cloud folder' });
  } else {
    toastOk('Backup created', { title: 'Saved to your backups folder' });
  }
  return res;
}

/* ----------------------------- export ----------------------------- */

export async function exportBackup() {
  await saveNow();
  const status = await api.data.status();

  const useAppPw = h('input', { type: 'radio', name: 'bkpw', checked: status.encrypted });
  const usePlain = h('input', { type: 'radio', name: 'bkpw', checked: !status.encrypted });
  const useCustom = h('input', { type: 'radio', name: 'bkpw' });
  const customPw = h('input.input', { type: 'password', placeholder: 'Password for this backup file', disabled: true });

  const sync = () => {
    customPw.disabled = !useCustom.checked;
    if (useCustom.checked) customPw.focus();
  };
  for (const r of [useAppPw, usePlain, useCustom]) r.addEventListener('change', sync);

  const m = modal({
    title: 'Export a backup file',
    size: 'sm',
    body: h(
      'div.col.gap-12',
      null,
      h('p.muted.small', null, 'Save this file somewhere safe — a USB drive, another PC, or cloud storage. Restoring it brings everything back exactly as it is now.'),
      status.encrypted
        ? h('label.check', null, useAppPw, h('span.box', null, icon('check', { size: 12, stroke: 3 })), h('span', null, 'Encrypt with my app password'))
        : null,
      h('label.check', null, useCustom, h('span.box', null, icon('check', { size: 12, stroke: 3 })), h('span', null, 'Encrypt with a different password')),
      customPw,
      h('label.check', null, usePlain, h('span.box', null, icon('check', { size: 12, stroke: 3 })), h('span', null, 'No encryption (plain, readable JSON)'))
    ),
    footer: [
      h('button.btn', { onclick: () => m.close() }, 'Cancel'),
      h(
        'button.btn.primary',
        {
          onclick: async () => {
            let password;
            if (useCustom.checked) {
              if (customPw.value.length < 8) {
                toast('Use at least 8 characters.', { tone: 'warn' });
                return;
              }
              password = customPw.value;
            } else if (usePlain.checked) {
              password = null;
            } else {
              password = undefined; // reuse the app password
            }
            m.close();
            const res = await api.backup.export({ password });
            if (res.ok) {
              toastOk(`Backup saved${res.encrypted ? ' (encrypted)' : ''}`, {
                action: { label: 'Open folder', onClick: () => api.files.openPath(res.file.replace(/[^\\/]*$/, '')) },
              });
            } else if (res.error !== 'CANCELED') {
              toastErr(`Export failed (${res.error})`);
            }
          },
        },
        icon('download', { size: 15 }),
        'Choose location'
      ),
    ],
  });
  sync();
}

/* ----------------------------- restore ---------------------------- */

export async function restoreFromFile() {
  const picked = await api.backup.pick();
  if (!picked.ok) return;
  await restoreFromPath(picked.file);
}

export async function restoreFromPath(filePath) {
  let res = await api.backup.read(filePath, null);

  if (!res.ok && res.error === 'PASSWORD_REQUIRED') {
    const password = await askPassword(filePath);
    if (password === null) return;
    res = await api.backup.read(filePath, password);
    if (!res.ok && res.error === 'BAD_PASSWORD') {
      toastErr('That password did not open the backup.');
      return;
    }
  }

  if (!res.ok) {
    toastErr(describe(res.error));
    return;
  }

  const doc = res.doc;
  const info = res.info || {};
  const counts = {
    accounts: (doc.accounts || []).length,
    transactions: (doc.transactions || []).length,
    recurring: (doc.recurring || []).length,
    budgets: (doc.budgets || []).length,
    goals: (doc.goals || []).length,
  };
  const current = {
    accounts: state.doc.accounts.length,
    transactions: state.doc.transactions.length,
  };

  // Merging is the right answer when the backup came from another computer;
  // replacing is the right answer when recovering after a reinstall.
  const preview = await api.data.mergeWith(state.doc, doc);
  const mode = await askRestoreMode({
    info,
    counts,
    current,
    stats: preview.ok ? preview.stats : null,
  });
  if (!mode) return;

  if (mode === 'merge') {
    if (!preview.ok) {
      toastErr('That backup could not be merged.');
      return;
    }
    const applied = await api.backup.restore(preview.doc);
    if (!applied.ok) {
      toastErr(`Merge failed (${applied.error})`);
      return;
    }
    setDoc(applied.doc);
    configureFormat(applied.doc.settings);
    toastOk(describeStats(preview.stats, 'Merged'));
    setTimeout(() => location.reload(), 900);
    return;
  }

  const applied = await api.backup.restore(doc);
  if (!applied.ok) {
    toastErr(`Restore failed (${applied.error})`);
    return;
  }
  setDoc(applied.doc);
  configureFormat(applied.doc.settings);
  toastOk('Backup restored');
  // A full reload guarantees every view, theme and format picks up the new data.
  setTimeout(() => location.reload(), 700);
}

function askRestoreMode({ info, counts, current, stats }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
      m.close();
    };
    const m = modal({
      title: 'Restore from this backup',
      body: h(
        'div.col.gap-16',
        null,
        h(
          'div.card.pad',
          null,
          h(
            'div.between',
            null,
            h('span.muted', null, 'Backup created'),
            h('span.strong', null, info.createdAt ? fmtDateTime(info.createdAt) : 'unknown')
          ),
          info.appVersion
            ? h('div.between.mt-4', null, h('span.muted', null, 'From version'), h('span', null, info.appVersion))
            : null,
          h('div.mt-8', null,
            row('Accounts', counts.accounts, current.accounts),
            row('Transactions', counts.transactions, current.transactions),
            row('Scheduled items', counts.recurring, state.doc.recurring.length),
            row('Budgets', counts.budgets, state.doc.budgets.length),
            row('Goals', counts.goals, state.doc.goals.length))
        ),
        h(
          'div.card.pad',
          null,
          h('div.h3', null, 'Merge — combine both'),
          h(
            'p.muted.small.mt-4',
            null,
            'Use this when the backup comes from another computer. Records only the backup has are added, records both have keep the newer edit, and deletions are respected.'
          ),
          h('div.mt-8', null, statsList(stats))
        ),
        h(
          'div.card.pad',
          { style: { borderLeft: '3px solid var(--st-warning)' } },
          h('div.h3', null, 'Replace — start from the backup'),
          h(
            'p.muted.small.mt-4',
            null,
            'Use this after a reinstall or on a new computer. Everything currently in FinFolio is discarded, though a safety copy is written first.'
          )
        )
      ),
      footer: [
        h('button.btn', { onclick: () => done(null) }, 'Cancel'),
        h('button.btn.danger-soft', { onclick: () => done('replace') }, 'Replace everything'),
        h(
          'button.btn.primary',
          { autofocus: true, disabled: !stats, onclick: () => done('merge') },
          icon('refresh', { size: 15 }),
          'Merge'
        ),
      ],
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      },
    });
  });
}

function row(label, incoming, currentValue) {
  return h(
    'div.between',
    null,
    h('span.muted', null, label),
    h(
      'span',
      null,
      h('span.strong', null, String(incoming)),
      h('span.dim', null, ` (now ${currentValue})`)
    )
  );
}

function askPassword(filePath) {
  return new Promise((resolve) => {
    const pw = h('input.input', { type: 'password', placeholder: 'Backup password', autofocus: true });
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const m = modal({
      title: 'This backup is encrypted',
      size: 'sm',
      body: h(
        'div.col.gap-12',
        null,
        h('p.muted.small', null, 'Enter the password that was used when the backup was made.'),
        pw
      ),
      footer: [
        h('button.btn', { onclick: () => { done(null); m.close(); } }, 'Cancel'),
        h('button.btn.primary', { onclick: () => { done(pw.value); m.close(); } }, 'Open backup'),
      ],
      onClose: () => done(null),
    });
    pw.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        done(pw.value);
        m.close();
      }
    });
  });
}

function describe(code) {
  return {
    UNREADABLE: 'That file could not be read as a FinFolio backup.',
    NOT_A_BACKUP: 'That file is not a FinFolio backup.',
    CORRUPT: 'The backup file is damaged.',
    BAD_PASSWORD: 'Incorrect password.',
  }[code] || `Could not read the backup (${code}).`;
}
