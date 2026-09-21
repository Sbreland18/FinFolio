'use strict';
/**
 * The FinFolio document: default shape, seed content and forward migrations.
 *
 * The whole document is a single JSON object held in memory by the renderer and
 * written atomically by the main process. Personal-finance data is small (tens
 * of thousands of rows at most), so a document store keeps the code simple,
 * makes backup/restore a file copy, and avoids native database modules that
 * would otherwise require Visual Studio build tools on every machine.
 */

const SCHEMA_VERSION = 7;

function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
}

const DEFAULT_SETTINGS = {
  currency: 'USD',
  locale: 'en-US',
  dateFormat: 'MM/DD/YYYY',
  theme: 'system', // system | light | dark
  accent: 'indigo',
  density: 'comfortable', // comfortable | compact
  startOfWeek: 0, // 0 = Sunday
  hideAmounts: false,
  // type | name | balance | custom — how the Accounts tiles are ordered.
  accountSort: 'type',
  lockOnStart: false,
  autoLockMinutes: 0, // 0 = never
  // Interest and fee charges on a card or loan are posted by the lender, so
  // there is nothing pending about them — tick them cleared without asking.
  autoClearCharges: true,
  autoBackup: true,
  backupKeep: 20,
  backupOnQuit: true,
  // A folder on this computer that something else syncs (Google Drive,
  // OneDrive, Dropbox). Every automatic backup is copied there as well.
  backupMirrorDir: '',
  forecastDays: 90,
  lowBalanceThreshold: 100,
  upcomingWindowDays: 14,
  updatesAutoCheck: true,
  updatesAutoDownload: false,
  firstRunComplete: false,
  dashboardCards: null, // null = default order
};

const DEFAULT_CATEGORIES = [
  // group, name, icon, kind
  ['Income', 'Paycheck', '💵', 'income'],
  ['Income', 'Bonus', '🎉', 'income'],
  ['Income', 'Interest', '🏦', 'income'],
  ['Income', 'Refund', '↩️', 'income'],
  ['Income', 'Other Income', '➕', 'income'],
  ['Housing', 'Rent / Mortgage', '🏠', 'expense'],
  ['Housing', 'Escrow (tax & insurance)', '🏦', 'expense'],
  ['Housing', 'Property Tax', '🧾', 'expense'],
  ['Housing', 'Home Insurance', '🛡️', 'expense'],
  ['Housing', 'Repairs & Maintenance', '🔧', 'expense'],
  ['Utilities', 'Electric', '💡', 'expense'],
  ['Utilities', 'Gas', '🔥', 'expense'],
  ['Utilities', 'Water & Sewer', '🚰', 'expense'],
  ['Utilities', 'Trash', '🗑️', 'expense'],
  ['Utilities', 'Internet', '🌐', 'expense'],
  ['Utilities', 'Phone', '📱', 'expense'],
  ['Food', 'Groceries', '🛒', 'expense'],
  ['Food', 'Restaurants', '🍽️', 'expense'],
  ['Food', 'Coffee', '☕', 'expense'],
  ['Transportation', 'Fuel', '⛽', 'expense'],
  ['Transportation', 'Car Payment', '🚗', 'expense'],
  ['Transportation', 'Car Insurance', '🛡️', 'expense'],
  ['Transportation', 'Maintenance', '🔩', 'expense'],
  ['Transportation', 'Parking & Tolls', '🅿️', 'expense'],
  ['Health', 'Health Insurance', '🏥', 'expense'],
  ['Health', 'Doctor & Dental', '🩺', 'expense'],
  ['Health', 'Pharmacy', '💊', 'expense'],
  ['Health', 'Fitness', '🏋️', 'expense'],
  ['Personal', 'Clothing', '👕', 'expense'],
  ['Personal', 'Haircut & Grooming', '💈', 'expense'],
  ['Personal', 'Gifts', '🎁', 'expense'],
  ['Personal', 'Charity', '❤️', 'expense'],
  ['Entertainment', 'Subscriptions', '📺', 'expense'],
  ['Entertainment', 'Hobbies', '🎨', 'expense'],
  ['Entertainment', 'Travel', '✈️', 'expense'],
  ['Entertainment', 'Dining Out', '🍿', 'expense'],
  ['Family', 'Childcare', '🧸', 'expense'],
  ['Family', 'School & Tuition', '🎓', 'expense'],
  ['Family', 'Pets', '🐾', 'expense'],
  ['Financial', 'Loan Payment', '🏦', 'expense'],
  ['Financial', 'Credit Card Payment', '💳', 'expense'],
  ['Financial', 'Interest Charge', '📈', 'expense'],
  ['Financial', 'Bank Fees', '🏛️', 'expense'],
  ['Financial', 'Taxes', '🧾', 'expense'],
  ['Financial', 'Savings Transfer', '🐖', 'expense'],
  ['Other', 'Uncategorized', '❔', 'expense'],
];

function seedCategories() {
  return DEFAULT_CATEGORIES.map(([group, name, icon, kind], i) => ({
    id: uid('cat'),
    name,
    group,
    icon,
    kind,
    parentId: null,
    color: null,
    archived: false,
    sort: i,
    system: name === 'Uncategorized',
  }));
}

function emptyDocument() {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    meta: { createdAt: now, updatedAt: now, appVersion: null },
    settings: { ...DEFAULT_SETTINGS },
    accounts: [],
    categories: seedCategories(),
    transactions: [],
    recurring: [],
    budgets: [],
    goals: [],
    rules: [],
    payees: [],
    netWorth: [],
    notes: [],
    // Records deleted on this computer. Without these, merging two computers'
    // files would resurrect anything the other one deleted.
    tombstones: [],
  };
}

/* ------------------------------------------------------------------ */
/* Migrations                                                          */
/* ------------------------------------------------------------------ */

const MIGRATIONS = {
  // v1 -> v2: goals gained explicit contributions + priority
  2(doc) {
    for (const g of doc.goals || []) {
      if (!Array.isArray(g.contributions)) g.contributions = [];
      if (typeof g.priority !== 'number') g.priority = 0;
    }
    return doc;
  },
  // v2 -> v3: transactions gained tags/splits; rules gained enabled flag
  3(doc) {
    for (const t of doc.transactions || []) {
      if (!Array.isArray(t.tags)) t.tags = [];
      if (!Array.isArray(t.splits)) t.splits = [];
    }
    for (const r of doc.rules || []) {
      if (typeof r.enabled !== 'boolean') r.enabled = true;
    }
    return doc;
  },
  // v3 -> v4: sync support — deletion tombstones and per-record timestamps.
  4(doc) {
    if (!Array.isArray(doc.tombstones)) doc.tombstones = [];
    const stamp = (doc.meta && doc.meta.updatedAt) || new Date().toISOString();
    for (const key of MERGEABLE) {
      for (const record of doc[key] || []) {
        if (record && !record.updatedAt) record.updatedAt = stamp;
      }
    }
    return doc;
  },
  // v4 -> v5: a schedule can now be adjusted one occurrence at a time — a
  // bank's holiday "skip a pay", a month already paid ahead, or a payday whose
  // amount is known for December but not in general — without deleting the
  // schedule or pausing the whole thing.
  5(doc) {
    for (const rule of doc.recurring || []) {
      if (!rule) continue;
      if (!Array.isArray(rule.skips)) rule.skips = [];
      if (!Array.isArray(rule.overrides)) rule.overrides = [];
    }
    return doc;
  },
  // v5 -> v6: mortgages carry an escrow portion that never touches the loan,
  // and a loan can be heading for forgiveness rather than a payoff.
  6(doc) {
    const escrow = (doc.categories || []).some((c) => /^escrow/i.test(String(c && c.name)));
    if (!escrow) {
      const housing = (doc.categories || []).find((c) => c && c.group === 'Housing');
      doc.categories.push({
        id: uid('cat'),
        name: 'Escrow (tax & insurance)',
        group: housing ? housing.group : 'Housing',
        icon: '🏦',
        kind: 'expense',
        color: null,
        archived: false,
        sort: (doc.categories || []).length,
        updatedAt: new Date().toISOString(),
      });
    }
    for (const account of doc.accounts || []) {
      if (!account) continue;
      if (typeof account.escrowAmount !== 'number') account.escrowAmount = 0;
      if (typeof account.forgiveness !== 'boolean') account.forgiveness = false;
    }
    return doc;
  },
  // v6 -> v7: a category can sit under another one, so "Pets" can hold food,
  // toys and vet bills without three separate top-level entries.
  7(doc) {
    for (const category of doc.categories || []) {
      if (category && category.parentId === undefined) category.parentId = null;
    }
    return doc;
  },
};

/** Collections that merge record-by-record when two computers are synced. */
const MERGEABLE = ['accounts', 'transactions', 'categories', 'recurring', 'budgets', 'goals', 'rules'];

/**
 * Settings that describe this computer rather than the finances. They are
 * deliberately not carried across when two documents are merged.
 */
const LOCAL_ONLY_SETTINGS = [
  'theme', 'accent', 'density', 'hideAmounts', 'firstRunComplete',
  'lastAutoBackup', 'lockOnStart', 'autoLockMinutes', 'dashboardCards',
  // A filesystem path that only makes sense on the computer that set it.
  'backupMirrorDir',
];

/** Bring any older document up to the current schema, filling gaps. */
function migrate(input) {
  let doc = input && typeof input === 'object' ? input : {};
  const base = emptyDocument();

  // Guarantee every top-level collection exists before migrating.
  for (const key of Object.keys(base)) {
    if (doc[key] === undefined) doc[key] = Array.isArray(base[key]) ? [] : base[key];
  }
  if (!Array.isArray(doc.categories) || doc.categories.length === 0) {
    doc.categories = seedCategories();
  }
  doc.settings = { ...DEFAULT_SETTINGS, ...(doc.settings || {}) };
  doc.meta = { ...base.meta, ...(doc.meta || {}) };

  let v = Number(doc.schemaVersion) || 1;
  while (v < SCHEMA_VERSION) {
    v += 1;
    const step = MIGRATIONS[v];
    if (step) doc = step(doc) || doc;
    doc.schemaVersion = v;
  }
  doc.schemaVersion = SCHEMA_VERSION;
  return doc;
}

/** Cheap structural check used before accepting an imported file. */
function looksLikeDocument(doc) {
  return !!(
    doc &&
    typeof doc === 'object' &&
    Array.isArray(doc.accounts) &&
    Array.isArray(doc.transactions) &&
    Array.isArray(doc.categories)
  );
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_SETTINGS,
  MERGEABLE,
  LOCAL_ONLY_SETTINGS,
  emptyDocument,
  seedCategories,
  migrate,
  looksLikeDocument,
  uid,
};
