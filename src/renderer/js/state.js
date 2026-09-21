/**
 * Renderer-side application state.
 *
 * The whole document lives in memory; every mutation goes through `commit()`,
 * which snapshots for undo, marks the document dirty and schedules a debounced
 * atomic save in the main process.
 */

import { uid } from './finance.js';
import { toast, toastErr } from './ui.js';

const api = window.finfolio;

const listeners = new Set();
const undoStack = [];
const redoStack = [];
const UNDO_LIMIT = 25;

export const state = {
  doc: null,
  route: 'dashboard',
  params: {},
  dirty: false,
  saving: false,
  lastSaved: null,
  locked: false,
  appInfo: null,
  update: { status: 'idle' },
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify(reason = 'change') {
  for (const fn of [...listeners]) {
    try {
      fn(reason);
    } catch (err) {
      console.error('listener failed', err);
      if (api) api.log.error(String(err && err.message), err && err.stack);
    }
  }
}

export function setDoc(doc) {
  state.doc = doc;
  undoStack.length = 0;
  redoStack.length = 0;
  notify('load');
}

/* ------------------------------- undo ----------------------------- */

function snapshot() {
  if (!state.doc) return null;
  // Undo is a convenience, not a guarantee — skip it on very large ledgers
  // rather than pausing the UI to clone tens of megabytes.
  if ((state.doc.transactions || []).length > 25000) return null;
  try {
    return { doc: structuredClone(state.doc) };
  } catch {
    return { doc: JSON.parse(JSON.stringify(state.doc)) };
  }
}

/**
 * Apply a mutation.
 * @param {string} label  shown in the undo toast
 * @param {(doc:object)=>any} mutator
 */
/** Stamp a record so a merge with another computer can order the edits. */
export function touch(record) {
  if (record && typeof record === 'object') record.updatedAt = new Date().toISOString();
  return record;
}

/**
 * Note that a record was deleted. Without this, merging two computers' files
 * would bring back everything either of them had deleted.
 */
export function tombstone(doc, collection, ids) {
  if (!Array.isArray(doc.tombstones)) doc.tombstones = [];
  const at = new Date().toISOString();
  for (const id of [].concat(ids)) {
    if (id) doc.tombstones.push({ id, collection, at });
  }
  if (doc.tombstones.length > 8000) {
    doc.tombstones.splice(0, doc.tombstones.length - 8000);
  }
}

export function commit(label, mutator) {
  if (!state.doc) return undefined;
  const snap = snapshot();
  const result = mutator(state.doc);
  if (snap) {
    undoStack.push({ ...snap, label });
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack.length = 0;
  }
  state.dirty = true;
  scheduleSave();
  notify('change');
  return result;
}

export function canUndo() {
  return undoStack.length > 0;
}

export function undo() {
  const entry = undoStack.pop();
  if (!entry) return false;
  const current = snapshot();
  if (current) redoStack.push({ ...current, label: entry.label });
  state.doc = entry.doc;
  state.dirty = true;
  scheduleSave();
  notify('change');
  toast(`Undid: ${entry.label}`);
  return true;
}

export function redo() {
  const entry = redoStack.pop();
  if (!entry) return false;
  const current = snapshot();
  if (current) undoStack.push({ ...current, label: entry.label });
  state.doc = entry.doc;
  state.dirty = true;
  scheduleSave();
  notify('change');
  return true;
}

/* ------------------------------- save ----------------------------- */

let saveTimer = null;
let savePromise = Promise.resolve();

export function scheduleSave(delay = 700) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveNow();
  }, delay);
}

/**
 * The interface registers a handler here so a save that collides with another
 * computer's edit can ask the user what to do. Kept as a callback so state.js
 * does not have to import the dialog code (which imports state.js).
 */
let conflictHandler = null;
export function onSaveConflict(fn) {
  conflictHandler = fn;
}

let conflictPending = false;

export async function saveNow({ force = false } = {}) {
  clearTimeout(saveTimer);
  if (!state.doc || !api) return { ok: false };
  state.saving = true;
  notify('saving');
  savePromise = savePromise.then(async () => {
    const res = await api.data.save(state.doc, force);
    state.saving = false;

    if (res && res.ok) {
      state.dirty = false;
      state.lastSaved = res.updatedAt || new Date().toISOString();
    } else if (res && res.error === 'CONFLICT') {
      // Another computer wrote the file after we loaded it. Nothing has been
      // overwritten; the interface now asks what to keep.
      state.dirty = true;
      if (conflictHandler && !conflictPending) {
        conflictPending = true;
        try {
          await conflictHandler();
        } finally {
          conflictPending = false;
        }
      }
    } else {
      toastErr(`Could not save: ${(res && res.error) || 'unknown error'}`);
    }
    notify('saved');
    return res;
  });
  return savePromise;
}

/** Replace the working document (after a merge or a reload from disk). */
export function replaceDoc(doc, { dirty = false } = {}) {
  state.doc = doc;
  undoStack.length = 0;
  redoStack.length = 0;
  state.dirty = dirty;
  notify('load');
}

/* --------------------------- CRUD helpers ------------------------- */

export function getSettings() {
  return (state.doc && state.doc.settings) || {};
}

export function setSetting(key, value) {
  return commit(`Change ${key}`, (doc) => {
    doc.settings[key] = value;
  });
}

export function addTransaction(tx) {
  return commit('Add transaction', (doc) => {
    const row = touch({ id: uid('tx'), cleared: false, tags: [], splits: [], ...tx });
    doc.transactions.push(row);
    rememberPayee(doc, row.payee);
    return row;
  });
}

export function addTransactions(list, label = 'Import transactions') {
  return commit(label, (doc) => {
    const rows = list.map((tx) => touch({ id: uid('tx'), cleared: false, tags: [], splits: [], ...tx }));
    doc.transactions.push(...rows);
    for (const r of rows) rememberPayee(doc, r.payee);
    return rows;
  });
}

export function updateTransaction(id, patch) {
  return commit('Edit transaction', (doc) => {
    const t = doc.transactions.find((x) => x.id === id);
    if (t) {
      Object.assign(t, patch);
      touch(t);
      rememberPayee(doc, t.payee);
    }
    return t;
  });
}

export function deleteTransaction(id) {
  return commit('Delete transaction', (doc) => {
    doc.transactions = doc.transactions.filter((t) => t.id !== id);
    tombstone(doc, 'transactions', id);
  });
}

export function deleteTransactions(ids) {
  const set = new Set(ids);
  return commit(`Delete ${ids.length} transactions`, (doc) => {
    doc.transactions = doc.transactions.filter((t) => !set.has(t.id));
    tombstone(doc, 'transactions', ids);
  });
}

function rememberPayee(doc, payee) {
  const name = String(payee || '').trim();
  if (!name) return;
  if (!Array.isArray(doc.payees)) doc.payees = [];
  if (!doc.payees.some((p) => p.toLowerCase() === name.toLowerCase())) {
    doc.payees.push(name);
    doc.payees.sort((a, b) => a.localeCompare(b));
    if (doc.payees.length > 2000) doc.payees.length = 2000;
  }
}

export function upsert(collection, item, label) {
  return commit(label || `Save ${collection.replace(/s$/, '')}`, (doc) => {
    if (!Array.isArray(doc[collection])) doc[collection] = [];
    const idx = doc[collection].findIndex((x) => x.id === item.id);
    if (idx >= 0) doc[collection][idx] = touch({ ...doc[collection][idx], ...item });
    else doc[collection].push(touch({ id: uid(collection.slice(0, 3)), ...item }));
    return item;
  });
}

export function removeFrom(collection, id, label) {
  return commit(label || `Delete ${collection.replace(/s$/, '')}`, (doc) => {
    doc[collection] = (doc[collection] || []).filter((x) => x.id !== id);
    tombstone(doc, collection, id);
  });
}

/* ------------------------------ routing --------------------------- */

export function navigate(route, params = {}) {
  state.route = route;
  state.params = params;
  notify('route');
}
