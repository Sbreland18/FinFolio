'use strict';
/**
 * Merging two copies of the document.
 *
 * This is what makes FinFolio usable on more than one computer. Two machines
 * pointed at the same cloud folder (or swapping .finbak files) can both have
 * edits the other has not seen; merging keeps all of them instead of one
 * computer's copy silently winning.
 *
 * Rules, in order:
 *   1. A record deleted on either side stays deleted, unless the other side
 *      edited it *after* the deletion. That is what `tombstones` are for —
 *      without them a merge would quietly resurrect everything you deleted.
 *   2. A record edited on both sides resolves to the newer `updatedAt`.
 *   3. A record only one side has is kept.
 *   4. Settings that describe the finances merge; settings that describe the
 *      computer (theme, density, privacy) stay local.
 *
 * Nothing is ever dropped without a tombstone, so a merge cannot lose data by
 * accident — the worst case is a duplicate, which is visible and fixable.
 */

const { MERGEABLE, LOCAL_ONLY_SETTINGS, migrate, looksLikeDocument } = require('./schema');

const TOMBSTONE_LIMIT = 8000;

function time(value) {
  if (!value) return 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

function recordTime(record, doc) {
  return time(record && record.updatedAt) || time(doc && doc.meta && doc.meta.updatedAt);
}

function clone(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

/** Newest tombstone per "collection:id" across both documents. */
function tombstoneIndex(...docs) {
  const index = new Map();
  for (const doc of docs) {
    for (const t of (doc && doc.tombstones) || []) {
      if (!t || !t.id || !t.collection) continue;
      const key = `${t.collection}:${t.id}`;
      const at = time(t.at);
      const existing = index.get(key);
      if (!existing || at > existing.at) index.set(key, { ...t, at });
    }
  }
  return index;
}

/**
 * @param {object} mine    the document this computer has in memory
 * @param {object} theirs  the document found on disk / in a backup file
 * @returns {{ok:true, doc:object, stats:object}|{ok:false, error:string}}
 */
function mergeDocuments(mine, theirs) {
  if (!looksLikeDocument(mine) || !looksLikeDocument(theirs)) {
    return { ok: false, error: 'INVALID' };
  }

  const a = migrate(clone(mine));
  const b = migrate(clone(theirs));
  const tombs = tombstoneIndex(a, b);

  // If FinFolio was set up separately on each computer, the two copies have the
  // same starting categories under different ids. Matching them by name first
  // keeps "Groceries" one category instead of two. Accounts are deliberately
  // not treated this way — two accounts with the same name may hold genuinely
  // different money, and silently combining them would corrupt balances.
  const categoryRemap = matchCategoriesByName(a, b);
  if (categoryRemap.size) applyCategoryRemap(b, categoryRemap);

  const stats = { added: {}, updated: {}, removed: {}, totalAdded: 0, totalUpdated: 0, totalRemoved: 0 };
  const bump = (bucket, collection) => {
    stats[bucket][collection] = (stats[bucket][collection] || 0) + 1;
    const total = bucket === 'added' ? 'totalAdded' : bucket === 'updated' ? 'totalUpdated' : 'totalRemoved';
    stats[total] += 1;
  };

  const result = { ...a };

  for (const collection of MERGEABLE) {
    const byId = new Map();
    for (const record of a[collection] || []) {
      if (record && record.id) byId.set(record.id, record);
    }

    for (const incoming of b[collection] || []) {
      if (!incoming || !incoming.id) continue;
      const current = byId.get(incoming.id);
      if (!current) {
        // Only add it if this computer has not deleted it since they edited it.
        const tomb = tombs.get(`${collection}:${incoming.id}`);
        if (tomb && tomb.at >= recordTime(incoming, b)) continue;
        byId.set(incoming.id, incoming);
        bump('added', collection);
        continue;
      }
      // Skipped occurrences are additive facts about individual months. If the
      // whole record were resolved by "newest wins", a payment skipped on the
      // laptop would be silently un-skipped by an unrelated edit on the desk
      // machine, so they are reconciled date by date before that comparison.
      if (collection === 'recurring') {
        let changed = false;
        for (const key of ['skips', 'overrides']) {
          const merged = mergeDated(current[key], incoming[key]);
          if (JSON.stringify(merged) !== JSON.stringify(current[key] || [])) changed = true;
          current[key] = merged;
          incoming[key] = merged;
        }
        if (changed && recordTime(incoming, b) <= recordTime(current, a)) bump('updated', collection);
      }

      if (recordTime(incoming, b) > recordTime(current, a)) {
        byId.set(incoming.id, incoming);
        bump('updated', collection);
      }
    }

    // Apply every tombstone that is newer than the record it refers to.
    for (const [id, record] of [...byId]) {
      const tomb = tombs.get(`${collection}:${id}`);
      if (tomb && tomb.at >= recordTime(record, a)) {
        byId.delete(id);
        if ((a[collection] || []).some((r) => r && r.id === id)) bump('removed', collection);
      }
    }

    result[collection] = [...byId.values()];
  }

  // Settings: the newer document wins, except for the machine-local ones.
  const theirsIsNewer = time(b.meta && b.meta.updatedAt) > time(a.meta && a.meta.updatedAt);
  result.settings = { ...a.settings };
  if (theirsIsNewer) {
    for (const [key, value] of Object.entries(b.settings || {})) {
      if (LOCAL_ONLY_SETTINGS.includes(key)) continue;
      result.settings[key] = value;
    }
  }

  result.payees = [...new Set([...(a.payees || []), ...(b.payees || [])])].sort((x, y) => x.localeCompare(y));

  result.tombstones = [...tombs.values()]
    .sort((x, y) => x.at - y.at)
    .slice(-TOMBSTONE_LIMIT)
    .map((t) => ({ id: t.id, collection: t.collection, at: new Date(t.at).toISOString() }));

  result.meta = {
    ...a.meta,
    createdAt: earliest(a.meta && a.meta.createdAt, b.meta && b.meta.createdAt),
    updatedAt: new Date().toISOString(),
    lastMergedAt: new Date().toISOString(),
  };

  return { ok: true, doc: result, stats };
}

/** When an entry was last decided — withdrawing one is itself a decision. */
function skipTime(entry) {
  return Math.max(time(entry && entry.removedAt), time(entry && entry.createdAt));
}

/** Union two date-keyed lists, keeping whichever decision was made last. */
function mergeDated(mine, theirs) {
  const byDate = new Map();
  for (const entry of [...(mine || []), ...(theirs || [])]) {
    if (!entry || !entry.date) continue;
    const existing = byDate.get(entry.date);
    if (!existing || skipTime(entry) > skipTime(existing)) byDate.set(entry.date, entry);
  }
  return [...byDate.values()].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
}

function categoryKey(category) {
  return [category.group, category.name, category.kind]
    .map((part) => String(part || '').trim().toLowerCase())
    .join('|');
}

/** ids in `b` that mean the same category as an existing id in `a`. */
function matchCategoriesByName(a, b) {
  const mineByKey = new Map();
  const mineIds = new Set();
  for (const c of a.categories || []) {
    if (!c || !c.id) continue;
    mineIds.add(c.id);
    if (!mineByKey.has(categoryKey(c))) mineByKey.set(categoryKey(c), c.id);
  }
  const remap = new Map();
  for (const c of b.categories || []) {
    if (!c || !c.id || mineIds.has(c.id)) continue;
    const match = mineByKey.get(categoryKey(c));
    if (match) remap.set(c.id, match);
  }
  return remap;
}

function applyCategoryRemap(doc, remap) {
  const to = (id) => (remap.has(id) ? remap.get(id) : id);
  doc.categories = (doc.categories || []).filter((c) => !remap.has(c.id));
  for (const t of doc.transactions || []) {
    if (t.categoryId) t.categoryId = to(t.categoryId);
    for (const split of t.splits || []) {
      if (split.categoryId) split.categoryId = to(split.categoryId);
    }
  }
  for (const key of ['recurring', 'budgets', 'rules']) {
    for (const record of doc[key] || []) {
      if (record && record.categoryId) record.categoryId = to(record.categoryId);
    }
  }
  for (const tomb of doc.tombstones || []) {
    if (tomb.collection === 'categories' && remap.has(tomb.id)) tomb.id = remap.get(tomb.id);
  }
}

function earliest(x, y) {
  const tx = time(x);
  const ty = time(y);
  if (!tx) return y || x || new Date().toISOString();
  if (!ty) return x;
  return tx <= ty ? x : y;
}

/** Summary of what one document has that the other does not — used for previews. */
function compareDocuments(mine, theirs) {
  const merged = mergeDocuments(mine, theirs);
  if (!merged.ok) return merged;
  return { ok: true, stats: merged.stats };
}

module.exports = { mergeDocuments, compareDocuments, tombstoneIndex };
