/**
 * Using FinFolio on more than one computer.
 *
 * There is no server. Syncing works by putting the data file in a folder that
 * something else already syncs — OneDrive, Dropbox, Google Drive, a network
 * share — and having FinFolio behave correctly when the file changes underneath
 * it. That means three things:
 *
 *   1. Noticing that another computer rewrote the file (main polls for it).
 *   2. Refusing to overwrite a newer file, and offering to merge instead.
 *   3. Merging record by record, honouring deletions, so nothing is lost.
 *
 * The same merge is offered when importing a backup file, which is the
 * no-cloud-folder version of the same idea.
 */

import { h } from './dom.js';
import { icon } from './icons.js';
import { fmtDateTime } from './format.js';
import { modal, toast, toastOk, toastErr, confirm, alertDialog } from './ui.js';
import { state, replaceDoc, saveNow, onSaveConflict, notify } from './state.js';
import { configureFormat } from './format.js';

const api = window.finfolio;

let busy = false;
let lastPrompt = 0;

export function installSyncHandlers() {
  onSaveConflict(() => resolveConflict({ triggeredBySave: true }));

  api.data.onExternalChange(() => {
    // Only nudge every 20 seconds — a cloud client can touch the file
    // repeatedly while it settles.
    if (busy || Date.now() - lastPrompt < 20000) return;
    lastPrompt = Date.now();
    announceExternalChange();
  });
}

/* --------------------------- external change ---------------------- */

function announceExternalChange() {
  toast('Another computer changed your data.', {
    title: 'Update available',
    tone: 'warn',
    timeout: 0,
    action: {
      label: state.dirty ? 'Merge' : 'Reload',
      onClick: () => (state.dirty ? resolveConflict({ triggeredBySave: false }) : reloadFromDisk()),
    },
  });
}

export async function reloadFromDisk() {
  busy = true;
  try {
    const res = await api.data.reload();
    if (!res.ok) {
      toastErr(`Could not re-read the file (${res.error}).`);
      return false;
    }
    replaceDoc(res.doc);
    configureFormat(res.doc.settings);
    toastOk('Reloaded the latest version');
    return true;
  } finally {
    busy = false;
  }
}

/* ------------------------------ conflict -------------------------- */

/**
 * Called when a save was refused because the file on disk is newer, or when the
 * user asks to reconcile after a change notification.
 */
export async function resolveConflict({ triggeredBySave = false } = {}) {
  if (busy) return;
  busy = true;
  try {
    const preview = await api.data.mergeWithDisk(state.doc);
    const stats = preview.ok ? preview.stats : null;

    if (preview.ok && stats && stats.totalAdded === 0 && stats.totalUpdated === 0 && stats.totalRemoved === 0) {
      // The other copy has nothing we do not already have — just claim the file.
      await saveNow({ force: true });
      return;
    }

    const choice = await askWhatToKeep(stats, preview.ok ? null : preview.error, triggeredBySave);
    if (!choice) return;

    if (choice === 'merge') {
      if (!preview.ok) {
        toastErr('That copy could not be read, so there is nothing to merge.');
        return;
      }
      replaceDoc(preview.doc, { dirty: true });
      configureFormat(preview.doc.settings);
      const res = await saveNow({ force: true });
      if (res && res.ok) toastOk(describeStats(stats, 'Merged'));
    } else if (choice === 'mine') {
      const res = await saveNow({ force: true });
      if (res && res.ok) toast('Kept this computer’s version.');
    } else if (choice === 'theirs') {
      await reloadFromDisk();
    }
  } finally {
    busy = false;
    notify('change');
  }
}

function askWhatToKeep(stats, error, triggeredBySave) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
      m.close();
    };

    const body = h(
      'div.col.gap-16',
      null,
      h(
        'p.muted',
        null,
        triggeredBySave
          ? 'Your data file was changed by another computer after this one opened it. Nothing has been overwritten.'
          : 'Another computer has written a newer version of your data file, and this computer has unsaved changes.'
      ),
      error
        ? h(
            'div.card.pad',
            { style: { borderLeft: '3px solid var(--st-critical)' } },
            h('div.strong.neg', null, 'The other version could not be read'),
            h('p.muted.small.mt-4', null, describeError(error))
          )
        : h(
            'div.card.pad',
            null,
            h('div.h3.mb-8', null, 'What merging would do'),
            statsList(stats)
          ),
      h(
        'p.tiny.dim',
        null,
        'Merging keeps both sides: records only one computer has are added, records both changed keep the newer edit, and anything deleted stays deleted.'
      )
    );

    const m = modal({
      title: 'Your data changed somewhere else',
      size: 'sm',
      dismissable: false,
      body,
      footer: [
        h('button.btn.left', { onclick: () => done('theirs') }, 'Use the other version'),
        h('button.btn', { onclick: () => done('mine') }, 'Keep mine'),
        h(
          'button.btn.primary',
          { autofocus: true, disabled: !!error, onclick: () => done('merge') },
          icon('refresh', { size: 15 }),
          'Merge both'
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

export function statsList(stats) {
  if (!stats) return h('p.muted.small', null, 'Nothing to compare.');
  const rows = [];
  const label = {
    accounts: 'accounts',
    transactions: 'transactions',
    categories: 'categories',
    recurring: 'scheduled items',
    budgets: 'budgets',
    goals: 'goals',
    rules: 'rules',
  };
  for (const [bucket, verb, tone] of [
    ['added', 'brought in from the other computer', 'pos'],
    ['updated', 'updated with a newer edit', ''],
    ['removed', 'removed (deleted on the other computer)', 'neg'],
  ]) {
    for (const [collection, count] of Object.entries(stats[bucket] || {})) {
      rows.push(
        h(
          'div.between.small',
          null,
          h('span', null, `${count} ${label[collection] || collection}`),
          h(`span.${tone || 'dim'}`, null, verb)
        )
      );
    }
  }
  if (!rows.length) return h('p.muted.small', null, 'Both copies already match.');
  return h('div.col.gap-6', null, ...rows);
}

export function describeStats(stats, prefix = 'Merged') {
  if (!stats) return `${prefix}.`;
  const bits = [];
  if (stats.totalAdded) bits.push(`${stats.totalAdded} added`);
  if (stats.totalUpdated) bits.push(`${stats.totalUpdated} updated`);
  if (stats.totalRemoved) bits.push(`${stats.totalRemoved} removed`);
  return bits.length ? `${prefix}: ${bits.join(', ')}` : `${prefix} — both copies already matched.`;
}

function describeError(code) {
  return {
    MISSING: 'The file is no longer there. It may still be syncing.',
    CORRUPT: 'The file is damaged or half-written. If it is in a cloud folder, wait for syncing to finish and try again.',
    PASSWORD_REQUIRED: 'It is encrypted with a different password.',
    BAD_PASSWORD: 'It is encrypted with a different password than this computer uses.',
  }[code] || `Unexpected problem (${code}).`;
}

/* -------------------------- change the folder --------------------- */

/**
 * The Settings flow for moving the data file somewhere synced. The important
 * moment is when the chosen folder already contains a FinFolio file — that is
 * the second computer joining, and it must not be silently overwritten.
 */
export async function changeDataFolder(preselected = null) {
  let dir = preselected;
  // A suggested cloud folder is a "FinFolio" subfolder that does not exist yet,
  // so it gets created; a folder the user picked by hand already exists.
  const createIfMissing = !!preselected;
  if (!dir) {
    const picked = await api.data.pickFolder();
    if (!picked.ok) return false;
    dir = picked.dir;
  }

  const inspected = await api.data.inspectLocation(dir, createIfMissing);
  if (!inspected.ok) {
    toastErr(folderProblem(inspected, dir), { title: 'Could not use that folder' });
    return false;
  }

  let mode = 'move';
  if (inspected.existing) {
    mode = await askAboutExistingFile(dir, inspected.existing);
    if (!mode) return false;
  } else {
    const ok = await confirm({
      title: 'Move your data there?',
      message: `FinFolio will keep your data in this folder from now on. The copy in the old location is left behind, renamed so it is not mistaken for the live file.`,
      confirmLabel: 'Move it',
      detail: h('div.mono.tiny.selectable', null, dir),
    });
    if (!ok) return false;
  }

  await saveNow({ force: true });
  const res = await api.data.setLocation(dir, mode);
  if (!res.ok) {
    toastErr(folderProblem(res, dir), { title: 'Could not use that folder' });
    return false;
  }

  if (res.doc) {
    replaceDoc(res.doc);
    configureFormat(res.doc.settings);
  }
  toastOk(mode === 'adopt' ? 'Now using the data already in that folder' : 'Data folder changed');
  return true;
}

/** Say what actually went wrong with a folder, and what to do about it. */
function folderProblem(result, dir) {
  const detail = result.detail ? ` (${result.detail})` : '';
  switch (result.error) {
    case 'NOT_A_FOLDER':
      return `${dir} is a file, not a folder.`;
    case 'SAME_FOLDER':
      return 'Your data is already stored there.';
    case 'MISSING':
      return `${dir} does not exist. Create it first, or use "Choose a folder…".`;
    case 'CANNOT_CREATE':
      return `FinFolio could not create ${dir}${detail}. If this is a cloud folder, make sure the app is signed in and finished setting up.`;
    case 'UNWRITABLE':
      return `FinFolio cannot write to ${dir}${detail}. On a work computer this folder may be read-only, or the cloud app may still be syncing.`;
    case 'COPY_FAILED':
      return `Your data could not be copied there${detail}. Check the folder is available and try again.`;
    case 'NOTHING_TO_ADOPT':
      return 'There is no FinFolio data in that folder after all.';
    default:
      return `Could not use that folder (${result.error}${detail}).`;
  }
}

function askAboutExistingFile(dir, existing) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
      m.close();
    };
    const m = modal({
      title: 'There is already FinFolio data there',
      size: 'sm',
      body: h(
        'div.col.gap-12',
        null,
        h('div.mono.tiny.dim.selectable', null, dir),
        h(
          'div.card.pad',
          null,
          h(
            'dl.kv',
            null,
            h('dt', null, 'Last changed'),
            h('dd', null, fmtDateTime(existing.modified)),
            ...(existing.counts
              ? [
                  h('dt', null, 'Accounts'),
                  h('dd', null, String(existing.counts.accounts)),
                  h('dt', null, 'Transactions'),
                  h('dd', null, String(existing.counts.transactions)),
                ]
              : [h('dt', null, 'Contents'), h('dd', null, 'encrypted')])
          )
        ),
        h(
          'p.muted.small',
          null,
          'If this is the same household data from another computer, use it — this computer will join in. Choosing to replace it keeps a renamed copy of the old file, nothing is deleted.'
        )
      ),
      footer: [
        h('button.btn', { onclick: () => done(null) }, 'Cancel'),
        h('button.btn.danger-soft', { onclick: () => done('move') }, 'Replace it with mine'),
        h('button.btn.primary', { autofocus: true, onclick: () => done('adopt') }, 'Use the data there'),
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

/** Explain the sync arrangement, shown from Settings. */
export function explainSync() {
  return alertDialog({
    title: 'Using FinFolio on more than one computer',
    size: '',
    body: h(
      'div.col.gap-12',
      null,
      h('p.muted', null, 'FinFolio has no server and sends your data nowhere. There are two ways to use it on several computers.'),
      h(
        'div.card.pad',
        null,
        h('div.h3', null, 'A synced folder (automatic)'),
        h(
          'p.muted.small.mt-4',
          null,
          'Put the data file in OneDrive, Dropbox or Google Drive on the first computer, then on each other computer choose the same folder and pick “Use the data there”. Everyone reads and writes one file.'
        ),
        h('p.muted.small.mt-8', null, 'FinFolio checks the file every few seconds. If another computer changed it, you are offered a reload or a merge rather than one side quietly winning.')
      ),
      h(
        'div.card.pad',
        null,
        h('div.h3', null, 'Backup files (manual)'),
        h(
          'p.muted.small.mt-4',
          null,
          'Export a backup on one computer and import it on the other, choosing “Merge”. Useful for a computer that is rarely online, or if you would rather not use a cloud folder at all.'
        )
      ),
      h(
        'div.card.pad',
        { style: { borderLeft: '3px solid var(--st-warning)' } },
        h('div.strong', null, 'One at a time is best'),
        h(
          'p.muted.small.mt-4',
          null,
          'Cloud folders sync files, not live edits. If two computers are open at once the second one to save is asked to merge, which works — but closing FinFolio when you finish on a machine keeps things simplest.'
        )
      )
    ),
  });
}
