/**
 * All financial calculation. Pure functions over the document — no DOM, no IO —
 * which is what makes them testable from Node (see scripts/test-core.js).
 *
 * Sign convention: every balance is signed from the owner's point of view.
 * Assets are positive, liabilities negative. A credit-card purchase is an
 * expense on the card (more negative); paying the card is a transfer from
 * checking to the card (checking down, card up toward zero).
 */

import {
  today, iso, dt, addDays, addMonths, diffDays, monthKey, startOfMonth, endOfMonth, round2, money,
} from './format.js';
import { occurrences, nextDue, perYear } from './recurrence.js';

/* ------------------------------------------------------------------ */
/* Account types                                                       */
/* ------------------------------------------------------------------ */

export const ACCOUNT_TYPES = [
  { id: 'checking', label: 'Checking', group: 'asset', icon: '🏦', color: '#2a78d6' },
  { id: 'savings', label: 'Savings', group: 'asset', icon: '🐖', color: '#1baf7a' },
  { id: 'cash', label: 'Cash', group: 'asset', icon: '💵', color: '#008300' },
  { id: 'investment', label: 'Investment', group: 'asset', icon: '📈', color: '#4a3aa7' },
  { id: 'other-asset', label: 'Other asset', group: 'asset', icon: '🏠', color: '#eda100' },
  { id: 'credit', label: 'Credit card', group: 'liability', icon: '💳', color: '#eb6834' },
  { id: 'loan', label: 'Loan', group: 'liability', icon: '🏛️', color: '#e34948' },
  { id: 'mortgage', label: 'Mortgage', group: 'liability', icon: '🏡', color: '#c2622f' },
  { id: 'student-loan', label: 'Student loan', group: 'liability', icon: '🎓', color: '#7b4fd4' },
  { id: 'other-liability', label: 'Other debt', group: 'liability', icon: '📄', color: '#e87ba4' },
];

export const SERIES = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8'];

export function accountType(id) {
  return ACCOUNT_TYPES.find((t) => t.id === id) || ACCOUNT_TYPES[0];
}
export function isLiability(type) {
  return accountType(type).group === 'liability';
}
export function isSpendable(type) {
  return type === 'checking' || type === 'savings' || type === 'cash';
}
/**
 * Debts where each payment is split between interest and principal by the
 * lender. A credit card is not one of these: its interest is charged to the
 * card separately and shows on the statement, rather than being taken out of
 * whatever you choose to pay.
 */
export function isAmortising(type) {
  return type === 'loan' || type === 'mortgage' || type === 'student-loan';
}

/* ------------------------------------------------------------------ */
/* Lookups                                                             */
/* ------------------------------------------------------------------ */

export function byId(list, id) {
  return (list || []).find((x) => x.id === id) || null;
}
export function indexBy(list, key = 'id') {
  const m = new Map();
  for (const item of list || []) m.set(item[key], item);
  return m;
}
export function activeAccounts(doc) {
  return (doc.accounts || []).filter((a) => !a.archived);
}
export function categoryName(doc, id) {
  const c = byId(doc.categories, id);
  return c ? c.name : 'Uncategorized';
}

/* ------------------------------------------------------------------ */
/* The category tree                                                   */
/*                                                                     */
/* `group` is a heading for tidiness. `parentId` is different: a child */
/* is part of its parent, so spending on "Pet food" is spending on     */
/* "Pets". Nesting is one level deep on purpose — two is a filing      */
/* system nobody keeps up, and the totals stop being legible.          */
/* ------------------------------------------------------------------ */

/** Direct children of a category. */
export function categoryChildren(doc, parentId, { includeArchived = false } = {}) {
  return (doc.categories || []).filter(
    (c) => c.parentId === parentId && (includeArchived || !c.archived)
  );
}

/** A category and every child of it — what a total on the parent means. */
export function categoryFamily(doc, id) {
  if (!id) return [];
  const ids = [id];
  for (const c of doc.categories || []) if (c.parentId === id) ids.push(c.id);
  return ids;
}

/** "Pets › Vet bills" when it has a parent, otherwise just the name. */
export function categoryLabel(doc, id, { full = false, separator = ' › ' } = {}) {
  const c = byId(doc.categories, id);
  if (!c) return 'Uncategorized';
  if (!full || !c.parentId) return c.name;
  const parent = byId(doc.categories, c.parentId);
  return parent ? `${parent.name}${separator}${c.name}` : c.name;
}

/** True when this category can take children — only top-level ones can. */
export function canHaveChildren(doc, id) {
  const c = byId(doc.categories, id);
  return !!c && !c.parentId;
}

/**
 * Categories in display order: each top-level one followed by its children.
 * @returns {{category:object, depth:number}[]}
 */
export function categoryTree(doc, { kind = null, includeArchived = false, group = null } = {}) {
  const all = (doc.categories || []).filter(
    (c) => (includeArchived || !c.archived) && (!kind || c.kind === kind) && (!group || c.group === group)
  );
  const bySort = (a, b) => (a.sort || 0) - (b.sort || 0) || String(a.name).localeCompare(String(b.name));
  const tops = all.filter((c) => !c.parentId).sort(bySort);
  const out = [];
  for (const top of tops) {
    out.push({ category: top, depth: 0 });
    for (const child of all.filter((c) => c.parentId === top.id).sort(bySort)) {
      out.push({ category: child, depth: 1 });
    }
  }
  // A child whose parent is archived or filtered out would otherwise vanish.
  const placed = new Set(out.map((x) => x.category.id));
  for (const orphan of all.filter((c) => c.parentId && !placed.has(c.id)).sort(bySort)) {
    out.push({ category: orphan, depth: 0 });
  }
  return out;
}
export function accountName(doc, id) {
  const a = byId(doc.accounts, id);
  return a ? a.name : '—';
}

/* ------------------------------------------------------------------ */
/* Balances                                                            */
/* ------------------------------------------------------------------ */

/** Effect of a transaction on one account's balance. */
export function signedDelta(tx, accountId) {
  const amount = Number(tx.amount) || 0;
  if (tx.type === 'transfer') {
    if (tx.accountId === accountId) return -amount;
    if (tx.transferAccountId === accountId) return amount;
    return 0;
  }
  if (tx.accountId !== accountId) return 0;
  return tx.type === 'income' ? amount : -amount;
}

/** Balance of one account as of a date (inclusive). */
export function balanceOf(doc, accountId, asOf = null) {
  const acct = byId(doc.accounts, accountId);
  if (!acct) return 0;
  let total = Number(acct.openingBalance) || 0;
  for (const tx of doc.transactions || []) {
    if (asOf && tx.date > asOf) continue;
    if (acct.openingDate && tx.date < acct.openingDate) continue;
    total += signedDelta(tx, accountId);
  }
  return round2(total);
}

/** All balances at once — one pass over transactions. */
export function allBalances(doc, asOf = null) {
  const map = new Map();
  for (const a of doc.accounts || []) map.set(a.id, Number(a.openingBalance) || 0);
  for (const tx of doc.transactions || []) {
    if (asOf && tx.date > asOf) continue;
    if (tx.type === 'transfer') {
      if (map.has(tx.accountId)) map.set(tx.accountId, map.get(tx.accountId) - (Number(tx.amount) || 0));
      if (map.has(tx.transferAccountId)) {
        map.set(tx.transferAccountId, map.get(tx.transferAccountId) + (Number(tx.amount) || 0));
      }
    } else if (map.has(tx.accountId)) {
      const d = tx.type === 'income' ? Number(tx.amount) || 0 : -(Number(tx.amount) || 0);
      map.set(tx.accountId, map.get(tx.accountId) + d);
    }
  }
  for (const [k, v] of map) map.set(k, round2(v));
  return map;
}

/** Balance that has actually cleared the bank (ignores pending rows). */
export function clearedBalance(doc, accountId, asOf = null) {
  const acct = byId(doc.accounts, accountId);
  if (!acct) return 0;
  let total = Number(acct.openingBalance) || 0;
  for (const tx of doc.transactions || []) {
    if (asOf && tx.date > asOf) continue;
    if (!tx.cleared) continue;
    total += signedDelta(tx, accountId);
  }
  return round2(total);
}

export function netWorth(doc, asOf = null) {
  const balances = allBalances(doc, asOf);
  let assets = 0;
  let liabilities = 0;
  for (const a of doc.accounts || []) {
    if (a.archived) continue;
    const b = balances.get(a.id) || 0;
    if (isLiability(a.type)) liabilities += b;
    else assets += b;
  }
  return {
    assets: round2(assets),
    liabilities: round2(liabilities), // negative
    debt: round2(-liabilities),
    net: round2(assets + liabilities),
  };
}

/** Total of spendable (cash-like) accounts — what you can actually pay with. */
export function cashOnHand(doc, asOf = null) {
  const balances = allBalances(doc, asOf);
  let total = 0;
  for (const a of doc.accounts || []) {
    if (a.archived || !isSpendable(a.type)) continue;
    total += balances.get(a.id) || 0;
  }
  return round2(total);
}

/* ------------------------------------------------------------------ */
/* Transaction queries                                                 */
/* ------------------------------------------------------------------ */

export function filterTransactions(doc, f = {}) {
  const {
    from, to, accountIds, categoryIds, types, search, cleared, minAmount, maxAmount, tags,
  } = f;
  const q = (search || '').trim().toLowerCase();
  const accSet = accountIds && accountIds.length ? new Set(accountIds) : null;
  const catSet = categoryIds && categoryIds.length ? new Set(categoryIds) : null;
  const typeSet = types && types.length ? new Set(types) : null;
  const tagSet = tags && tags.length ? new Set(tags) : null;

  return (doc.transactions || []).filter((t) => {
    if (from && t.date < from) return false;
    if (to && t.date > to) return false;
    if (accSet && !accSet.has(t.accountId) && !accSet.has(t.transferAccountId)) return false;
    if (catSet && !catSet.has(t.categoryId)) return false;
    if (typeSet && !typeSet.has(t.type)) return false;
    if (cleared === true && !t.cleared) return false;
    if (cleared === false && t.cleared) return false;
    const amt = Math.abs(Number(t.amount) || 0);
    if (Number.isFinite(minAmount) && amt < minAmount) return false;
    if (Number.isFinite(maxAmount) && amt > maxAmount) return false;
    if (tagSet && !(t.tags || []).some((x) => tagSet.has(x))) return false;
    if (q) {
      const hay = `${t.payee || ''} ${t.notes || ''} ${(t.tags || []).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function sortTransactions(list, key = 'date', dir = 'desc') {
  const sorted = [...list].sort((a, b) => {
    let av = a[key];
    let bv = b[key];
    if (key === 'amount') {
      av = Number(a.amount) || 0;
      bv = Number(b.amount) || 0;
    }
    if (av === bv) return (a.date < b.date ? 1 : -1);
    if (av === undefined || av === null) return 1;
    if (bv === undefined || bv === null) return -1;
    return av < bv ? -1 : 1;
  });
  return dir === 'desc' ? sorted.reverse() : sorted;
}

/** Running balance for a register view (oldest → newest). */
export function withRunningBalance(doc, accountId, txns) {
  const acct = byId(doc.accounts, accountId);
  const opening = acct ? Number(acct.openingBalance) || 0 : 0;
  const ordered = [...txns].sort((a, b) =>
    a.date === b.date ? String(a.id).localeCompare(String(b.id)) : a.date < b.date ? -1 : 1
  );
  let run = opening;
  const out = ordered.map((t) => {
    run = round2(run + signedDelta(t, accountId));
    return { ...t, _balance: run };
  });
  return out.reverse();
}

/* ------------------------------------------------------------------ */
/* Aggregations                                                        */
/* ------------------------------------------------------------------ */

/** Spending or income per category over a window. Splits are respected. */
export function categoryTotals(doc, { from, to, kind = 'expense', accountIds, rollUp = false } = {}) {
  const totals = new Map();
  const accSet = accountIds && accountIds.length ? new Set(accountIds) : null;
  for (const t of doc.transactions || []) {
    if (t.type !== kind) continue;
    if (from && t.date < from) continue;
    if (to && t.date > to) continue;
    if (accSet && !accSet.has(t.accountId)) continue;
    if (Array.isArray(t.splits) && t.splits.length) {
      for (const s of t.splits) {
        const k = s.categoryId || t.categoryId || 'uncat';
        totals.set(k, round2((totals.get(k) || 0) + (Number(s.amount) || 0)));
      }
    } else {
      const k = t.categoryId || 'uncat';
      totals.set(k, round2((totals.get(k) || 0) + (Number(t.amount) || 0)));
    }
  }
  const rows = [...totals.entries()].map(([categoryId, amount]) => ({
    categoryId,
    amount,
    name: categoryName(doc, categoryId),
  }));
  if (!rollUp) return rows.sort((a, b) => b.amount - a.amount);

  // Fold children into their parent, keeping them on the row so a report can
  // show "Pets $180" and still break it into food, toys and the vet.
  const byParent = new Map();
  for (const row of rows) {
    const category = byId(doc.categories, row.categoryId);
    const parentId = category && category.parentId ? category.parentId : row.categoryId;
    if (!byParent.has(parentId)) {
      byParent.set(parentId, {
        categoryId: parentId,
        amount: 0,
        name: categoryName(doc, parentId),
        children: [],
      });
    }
    const bucket = byParent.get(parentId);
    bucket.amount = round2(bucket.amount + row.amount);
    if (parentId !== row.categoryId) bucket.children.push(row);
  }
  for (const bucket of byParent.values()) bucket.children.sort((a, b) => b.amount - a.amount);
  return [...byParent.values()].sort((a, b) => b.amount - a.amount);
}

/** Income / expense / net for each of the last `months` calendar months. */
export function monthlyTotals(doc, months = 12, endRef = today()) {
  const out = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const ref = addMonths(endRef, -i);
    const key = monthKey(ref);
    const from = startOfMonth(ref);
    const to = endOfMonth(ref);
    let income = 0;
    let expense = 0;
    for (const t of doc.transactions || []) {
      if (t.date < from || t.date > to) continue;
      if (t.type === 'income') income += Number(t.amount) || 0;
      else if (t.type === 'expense') expense += Number(t.amount) || 0;
    }
    out.push({ key, from, to, income: round2(income), expense: round2(expense), net: round2(income - expense) });
  }
  return out;
}

/** Daily or monthly net-worth history reconstructed from the ledger. */
export function netWorthSeries(doc, months = 12, endRef = today()) {
  const points = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const ref = addMonths(endRef, -i);
    const at = i === 0 ? endRef : endOfMonth(ref);
    const nw = netWorth(doc, at);
    points.push({ date: at, key: monthKey(at), ...nw });
  }
  return points;
}

/**
 * Month-by-month totals for one slice of spending — a category, a payee, or
 * everything. The input to both the drill-down chart and the projection.
 * @returns {{key:string, amount:number, count:number}[]} oldest first
 */
export function spendingSeries(doc, {
  categoryId = null, payee = null, months = 12, to = today(), kind = 'expense',
  accountIds = null, includeChildren = true,
} = {}) {
  const keys = [];
  for (let i = months - 1; i >= 0; i -= 1) keys.push(monthKey(addMonths(to, -i)));
  const index = new Map(keys.map((k) => [k, { key: k, amount: 0, count: 0 }]));
  const wanted = payee === null ? null : String(payee).trim().toLowerCase();
  const accSet = accountIds && accountIds.length ? new Set(accountIds) : null;
  const cats = categoryId === null
    ? null
    : new Set(includeChildren ? categoryFamily(doc, categoryId) : [categoryId]);

  for (const t of doc.transactions || []) {
    if (t.type !== kind) continue;
    if (cats && !cats.has(t.categoryId)) continue;
    if (accSet && !accSet.has(t.accountId)) continue;
    if (wanted !== null && String(t.payee || '').trim().toLowerCase() !== wanted) continue;
    const bucket = index.get(monthKey(t.date));
    if (!bucket) continue;
    bucket.amount = round2(bucket.amount + (Number(t.amount) || 0));
    bucket.count += 1;
  }
  return keys.map((k) => index.get(k));
}

/**
 * What next month probably looks like, from the months that came before.
 *
 * Deliberately two numbers rather than one: a plain average, and a
 * least-squares trend. When they disagree the spending is moving, and saying
 * so is more use than picking one and sounding certain.
 */
export function projectFromSeries(series, { ignoreEmptyLeading = true } = {}) {
  let rows = series || [];
  if (ignoreEmptyLeading) {
    // Months before the first transaction are absence of data, not zero spend,
    // and averaging them in quietly halves every figure.
    const first = rows.findIndex((r) => r.count > 0);
    rows = first <= 0 ? rows : rows.slice(first);
  }
  const n = rows.length;
  if (!n) return { average: 0, projected: 0, trendPerMonth: 0, months: 0, total: 0, confident: false };

  const total = round2(rows.reduce((s, r) => s + r.amount, 0));
  const average = round2(total / n);

  // Least squares on (index, amount).
  let slope = 0;
  if (n >= 3) {
    const meanX = (n - 1) / 2;
    let num = 0;
    let den = 0;
    rows.forEach((r, i) => {
      num += (i - meanX) * (r.amount - average);
      den += (i - meanX) ** 2;
    });
    slope = den ? num / den : 0;
  }
  const trended = average + slope * ((n - 1) / 2 + 1);
  return {
    months: n,
    total,
    average,
    trendPerMonth: round2(slope),
    // Never project a negative spend, and never let a steep trend run away
    // further than doubling the average from the history we actually have.
    projected: round2(Math.max(0, Math.min(trended, average * 2 + Math.abs(slope)))),
    confident: n >= 3 && rows.filter((r) => r.count > 0).length >= 3,
  };
}

export function payeeTotals(doc, { from, to, limit = 10, accountIds = null } = {}) {
  const map = new Map();
  const accSet = accountIds && accountIds.length ? new Set(accountIds) : null;
  for (const t of doc.transactions || []) {
    if (t.type !== 'expense') continue;
    if (from && t.date < from) continue;
    if (to && t.date > to) continue;
    if (accSet && !accSet.has(t.accountId)) continue;
    const key = (t.payee || '').trim() || '(no payee)';
    map.set(key, round2((map.get(key) || 0) + (Number(t.amount) || 0)));
  }
  return [...map.entries()]
    .map(([payee, amount]) => ({ payee, amount }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* Recurring items & upcoming                                          */
/* ------------------------------------------------------------------ */

/**
 * True when this occurrence has already been paid.
 *
 * A transaction recorded *from* the schedule carries its id and is definitive.
 * A card or loan payment can also arrive without one — entered by hand, typed
 * in from the Debt Payoff screen, or imported from the bank — and money landing
 * in the account being paid off is still that payment.
 *
 * That second route only counts when it covers what was due. An extra $100
 * against the principal a day before the real payment must not make the real
 * payment vanish from the list, which is the failure that actually hurts.
 *
 * @param {{expected?:number}} [options] the amount already resolved for this
 *        date by the caller, so a loop does not recompute balances per row.
 */
export function isOccurrencePosted(doc, rule, date, windowDays = 4, { expected = null } = {}) {
  const lo = addDays(date, -windowDays);
  const hi = addDays(date, windowDays);
  const linked = rule.linkedAccountId || '';
  let inbound = 0;
  for (const t of doc.transactions || []) {
    if (t.date < lo || t.date > hi) continue;
    if (t.recurringId === rule.id) return true;
    if (linked && t.type === 'transfer' && t.transferAccountId === linked) {
      inbound = round2(inbound + Math.abs(Number(t.amount) || 0));
    }
  }
  if (!linked || inbound <= 0) return false;
  const due = expected === null ? resolveOccurrenceAmount(doc, rule, date).amount : expected;
  // A hair under, so a rounded-down bank payment still counts.
  return due > 0 && inbound >= round2(due * 0.995);
}

/** Every payment made into a card or loan, newest last. */
export function paymentsInto(doc, accountId) {
  return (doc.transactions || [])
    .filter((t) => t.type === 'transfer' && t.transferAccountId === accountId)
    .map((t) => ({ id: t.id, date: t.date, amount: round2(Math.abs(Number(t.amount) || 0)) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** The most recent payment recorded against a card or loan. */
export function lastPaymentInto(doc, accountId) {
  const list = paymentsInto(doc, accountId);
  return list.length ? list[list.length - 1] : null;
}

/* ------------------------------------------------------------------ */
/* Skipped occurrences                                                 */
/*                                                                     */
/* Deleting a schedule removes it everywhere and pausing one stops all */
/* of it, but a lender's holiday "skip a pay" — or a month paid ahead  */
/* — is about one occurrence. A skip names that single date and leaves */
/* the rest of the schedule exactly as it was.                         */
/*                                                                     */
/* A withdrawn skip is kept as a record with `removedAt` rather than   */
/* spliced out, so that merging two computers can tell "she un-skipped */
/* December" from "he never saw the skip at all".                      */
/* ------------------------------------------------------------------ */

/** The skip record for one occurrence, live or withdrawn. */
export function skipEntry(rule, date) {
  return ((rule && rule.skips) || []).find((s) => s && s.date === date) || null;
}

/** True when this one occurrence has been deliberately skipped. */
export function isOccurrenceSkipped(rule, date) {
  const entry = skipEntry(rule, date);
  return !!entry && !entry.removedAt;
}

/** Live skips on a rule, earliest first. */
export function skippedOccurrences(rule, { from = null, to = null } = {}) {
  return ((rule && rule.skips) || [])
    .filter((s) => s && s.date && !s.removedAt && (!from || s.date >= from) && (!to || s.date <= to))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Every live skip in the document, with its rule attached. */
export function allSkips(doc, { from = null } = {}) {
  const out = [];
  for (const rule of doc.recurring || []) {
    for (const skip of skippedOccurrences(rule, { from })) out.push({ rule, ...skip });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Interest a liability still charges during a skipped month. A bank's
 * skip-a-pay does not pause interest — that is how the offer pays for itself —
 * so this is what quietly gets added to the balance instead.
 */
export function skipInterest(account, balanceOwed) {
  const owed = Math.abs(Number(balanceOwed) || 0);
  const apr = Number(account && account.apr) || 0;
  if (owed <= 0 || apr <= 0) return 0;
  return round2((owed * (apr / 100)) / 12);
}

/** Drop withdrawn skips nobody will ever ask about again. */
export function pruneSkips(skips, before) {
  return (skips || []).filter((s) => s && s.date && (!s.removedAt || s.date >= before));
}

/* ------------------------------------------------------------------ */
/* One-off amounts                                                     */
/*                                                                     */
/* A payday that varies, a quarterly water bill that came in high: the */
/* schedule is right, one date's amount is not. An override names that */
/* date and leaves the rule's own amount alone, so the forecast can be */
/* accurate about the month in hand without lying about the average.   */
/* ------------------------------------------------------------------ */

/** The live amount override for one occurrence, if there is one. */
export function occurrenceOverride(rule, date) {
  const entry = ((rule && rule.overrides) || []).find((o) => o && o.date === date);
  return entry && !entry.removedAt ? entry : null;
}

/** Live overrides on a rule, earliest first. */
export function occurrenceOverrides(rule, { from = null, to = null } = {}) {
  return ((rule && rule.overrides) || [])
    .filter((o) => o && o.date && !o.removedAt && (!from || o.date >= from) && (!to || o.date <= to))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * What one dated occurrence is worth: the override if there is one, otherwise
 * whatever the rule works out to.
 * @param {{balances?:Map, base?:object}} [options] `base` reuses a resolution
 *        already computed for the rule, so a loop does not redo it per date.
 */
export function resolveOccurrenceAmount(doc, rule, date, { balances = null, base = null } = {}) {
  const override = occurrenceOverride(rule, date);
  if (override) {
    return {
      amount: round2(Number(override.amount) || 0),
      estimated: false,
      overridden: true,
      note: override.note || 'Set for this date',
    };
  }
  const resolved = base || resolveRuleAmount(doc, rule, { balances });
  return { ...resolved, overridden: false };
}

/** Drop withdrawn overrides that are safely in the past. */
export function pruneOverrides(overrides, before) {
  return (overrides || []).filter((o) => o && o.date && (!o.removedAt || o.date >= before));
}

/**
 * Scheduled items falling in a window, with posted occurrences filtered out.
 * @returns {{rule:object, date:string, amount:number, kind:string, overdue:boolean}[]}
 */
export function upcomingItems(
  doc,
  { days = 30, from = today(), includePosted = false, includeSkipped = false } = {}
) {
  const to = addDays(from, days);
  const start = addDays(from, -60); // look back so overdue bills still surface
  const out = [];
  // Walked once, then reused for every occurrence, so card minimums resolve
  // without re-reading the ledger per row.
  const balances = allBalances(doc);
  for (const rule of doc.recurring || []) {
    if (rule.active === false) continue;
    const resolved = resolveRuleAmount(doc, rule, { balances });
    for (const date of occurrences(rule, start, to, { max: 200 })) {
      const forDate = resolveOccurrenceAmount(doc, rule, date, { base: resolved });
      const posted = isOccurrencePosted(doc, rule, date, 4, { expected: forDate.amount });
      if (posted && !includePosted) continue;
      const skipped = !posted && isOccurrenceSkipped(rule, date);
      if (skipped && !includeSkipped) continue;
      const row = {
        rule,
        date,
        amount: forDate.amount,
        estimated: forDate.estimated,
        note: forDate.note,
        overridden: forDate.overridden,
        kind: rule.kind,
        posted,
        skipped,
        skip: skipped ? skipEntry(rule, date) : null,
      };
      // A skipped payment is settled, not late — it must never read "overdue".
      if (date < from && !posted && !skipped) out.push({ ...row, overdue: true });
      else if (date >= from || skipped) out.push({ ...row, overdue: false });
    }
  }
  return out.sort((a, b) => (a.date === b.date ? a.rule.name.localeCompare(b.rule.name) : a.date < b.date ? -1 : 1));
}

/**
 * One calendar month of the schedule, paid and unpaid together.
 *
 * "Upcoming" answers "what is coming at me"; this answers "how is this month
 * going" — which is a different question and the one people ask when they are
 * deciding whether they can afford something this week.
 */
export function monthSchedule(doc, month = monthKey(today())) {
  const from = startOfMonth(`${month}-01`);
  const to = endOfMonth(`${month}-01`);
  const balances = allBalances(doc);
  const items = [];

  for (const rule of doc.recurring || []) {
    if (rule.active === false) continue;
    const base = resolveRuleAmount(doc, rule, { balances });
    for (const date of occurrences(rule, from, to, { max: 100 })) {
      const forDate = resolveOccurrenceAmount(doc, rule, date, { base });
      const posted = isOccurrencePosted(doc, rule, date, 4, { expected: forDate.amount });
      const skipped = !posted && isOccurrenceSkipped(rule, date);
      items.push({
        rule,
        date,
        amount: forDate.amount,
        estimated: forDate.estimated,
        note: forDate.note,
        overridden: forDate.overridden,
        kind: rule.kind,
        posted,
        skipped,
        skip: skipped ? skipEntry(rule, date) : null,
        overdue: !posted && !skipped && date < today(),
      });
    }
  }
  items.sort((a, b) => (a.date === b.date ? a.rule.name.localeCompare(b.rule.name) : a.date < b.date ? -1 : 1));

  const live = items.filter((i) => !i.skipped);
  const incomeRows = live.filter((i) => i.kind === 'income');
  const billRows = live.filter((i) => i.kind !== 'income');
  const sum = (rows) => round2(rows.reduce((s, r) => s + r.amount, 0));

  return {
    month,
    from,
    to,
    items,
    income: sum(incomeRows),
    incomeReceived: sum(incomeRows.filter((i) => i.posted)),
    incomeToCome: sum(incomeRows.filter((i) => !i.posted)),
    bills: sum(billRows),
    billsPaid: sum(billRows.filter((i) => i.posted)),
    billsLeft: sum(billRows.filter((i) => !i.posted)),
    countBills: billRows.length,
    countPaid: billRows.filter((i) => i.posted).length,
    countLeft: billRows.filter((i) => !i.posted).length,
    countOverdue: billRows.filter((i) => i.overdue).length,
    skipped: items.filter((i) => i.skipped).length,
  };
}

/* ------------------------------------------------------------------ */
/* Charges that clear themselves                                       */
/* ------------------------------------------------------------------ */

/** Categories the issuer posts directly, so there is nothing to wait for. */
export const AUTO_CLEAR_CATEGORIES = ['Interest Charge', 'Bank Fees'];

/**
 * True when a charge should be marked cleared without being asked.
 * Interest posted to a card is not pending — the issuer has already applied it.
 */
export function shouldAutoClear(doc, { accountId, categoryId, type = 'expense' } = {}) {
  if ((doc.settings || {}).autoClearCharges === false) return false;
  if (type !== 'expense') return false;
  const account = byId(doc.accounts, accountId);
  if (!account || !isLiability(account.type)) return false;
  const category = byId(doc.categories, categoryId);
  if (!category) return false;
  const name = String(category.name).toLowerCase();
  return AUTO_CLEAR_CATEGORIES.some((n) => n.toLowerCase() === name);
}

export function monthlyRecurringLoad(doc) {
  const balances = allBalances(doc);
  let billsPerMonth = 0;
  let incomePerMonth = 0;
  let debtPerMonth = 0;
  for (const r of doc.recurring || []) {
    if (r.active === false) continue;
    const monthly = (resolveRuleAmount(doc, r, { balances }).amount * perYear(r.frequency)) / 12;
    if (r.kind === 'income') incomePerMonth += monthly;
    else if (r.kind === 'transfer') {
      // A transfer to a liability is a debt payment, not an internal move.
      if (isLiability((byId(doc.accounts, r.transferAccountId) || {}).type)) debtPerMonth += monthly;
    } else billsPerMonth += monthly;
  }
  return {
    bills: round2(billsPerMonth),
    debt: round2(debtPerMonth),
    income: round2(incomePerMonth),
    net: round2(incomePerMonth - billsPerMonth - debtPerMonth),
  };
}

/* ------------------------------------------------------------------ */
/* Cash-flow forecast                                                  */
/* ------------------------------------------------------------------ */

/**
 * Projected day-by-day balance of spendable accounts.
 * Combines already-entered future transactions with scheduled recurring items.
 */
export function forecast(doc, { days = 90, accountIds = null, from = today() } = {}) {
  const ids = accountIds && accountIds.length
    ? accountIds
    : (doc.accounts || []).filter((a) => !a.archived && isSpendable(a.type)).map((a) => a.id);
  const idSet = new Set(ids);

  const balances = allBalances(doc, from);
  let running = 0;
  for (const id of ids) running += balances.get(id) || 0;
  running = round2(running);

  const to = addDays(from, days);

  // Future transactions already in the ledger.
  const byDate = new Map();
  const push = (date, item) => {
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(item);
  };
  for (const t of doc.transactions || []) {
    if (t.date <= from || t.date > to) continue;
    let delta = 0;
    for (const id of ids) delta += signedDelta(t, id);
    if (delta === 0) continue;
    push(t.date, {
      label: t.payee || categoryName(doc, t.categoryId),
      amount: round2(delta),
      kind: t.type,
      source: 'transaction',
      id: t.id,
    });
  }
  // Scheduled items not yet posted.
  for (const rule of doc.recurring || []) {
    if (rule.active === false) continue;
    const base = resolveRuleAmount(doc, rule, { balances });
    // A rule worth nothing can still have a single date overridden to an
    // amount, so the zero check has to happen per occurrence, not per rule.
    if (!base.amount && !occurrenceOverrides(rule).length) continue;
    for (const date of occurrences(rule, addDays(from, 1), to, { max: 400 })) {
      const amt = resolveOccurrenceAmount(doc, rule, date, { base }).amount;
      if (isOccurrencePosted(doc, rule, date, 4, { expected: amt })) continue;
      // A skipped payment never leaves the account, so it must not dent the
      // projection either — that is half the point of recording the skip.
      if (isOccurrenceSkipped(rule, date)) continue;
      if (!amt) continue;
      let delta = 0;
      if (rule.kind === 'income') delta = idSet.has(rule.accountId) ? amt : 0;
      else if (rule.kind === 'transfer') {
        delta =
          (idSet.has(rule.accountId) ? -amt : 0) + (idSet.has(rule.transferAccountId) ? amt : 0);
      } else delta = idSet.has(rule.accountId) ? -amt : 0;
      if (delta === 0) continue;
      push(date, {
        label: rule.name,
        amount: round2(delta),
        kind: rule.kind,
        source: 'recurring',
        id: rule.id,
      });
    }
  }

  const series = [];
  let min = { date: from, balance: running };
  for (let i = 0; i <= days; i += 1) {
    const date = addDays(from, i);
    const events = byDate.get(date) || [];
    for (const e of events) running = round2(running + e.amount);
    if (running < min.balance) min = { date, balance: running };
    series.push({ date, balance: running, events });
  }

  return {
    series,
    start: round2(series[0] ? series[0].balance : 0),
    end: round2(running),
    min,
    accountIds: ids,
  };
}

/* ------------------------------------------------------------------ */
/* Loans & credit cards                                                */
/* ------------------------------------------------------------------ */

/** Level payment for a fully amortising loan. */
export function levelPayment(principal, annualRatePct, months) {
  const p = Math.abs(Number(principal) || 0);
  const n = Math.max(1, Math.round(Number(months) || 0));
  const r = (Number(annualRatePct) || 0) / 100 / 12;
  if (r <= 0) return round2(p / n);
  return round2((p * r) / (1 - Math.pow(1 + r, -n)));
}

/**
 * Amortisation schedule.
 * @returns {{rows:Array, months:number, totalInterest:number, payoffDate:string, error?:string}}
 */
export function amortize({
  principal,
  annualRate = 0,
  payment = 0,
  termMonths = 0,
  startDate = today(),
  extra = 0,
  maxMonths = 720,
  // `YYYY-MM` months in which no payment is made. Matched by month rather than
  // by exact date because a schedule's own dates shift for weekends.
  skipMonths = null,
}) {
  let balance = Math.abs(Number(principal) || 0);
  const r = (Number(annualRate) || 0) / 100 / 12;
  let pay = Number(payment) || 0;
  if (!pay && termMonths) pay = levelPayment(balance, annualRate, termMonths);
  const extraPay = Math.max(0, Number(extra) || 0);

  const firstInterest = balance * r;
  if (pay + extraPay <= firstInterest && balance > 0) {
    return {
      rows: [],
      months: Infinity,
      totalInterest: Infinity,
      payoffDate: null,
      error: 'PAYMENT_TOO_LOW',
      minimumViable: round2(firstInterest + 1),
    };
  }

  const rows = [];
  const skipped = skipMonths && skipMonths.length ? new Set(skipMonths) : null;
  let totalInterest = 0;
  let date = startDate;
  let n = 0;
  while (balance > 0.005 && n < maxMonths) {
    n += 1;
    const interest = round2(balance * r);

    // A lender's skip-a-pay does not pause interest — the balance goes up by
    // exactly one month's worth and everything after it moves out a month.
    if (skipped && skipped.has(monthKey(date))) {
      balance = round2(balance + interest);
      totalInterest = round2(totalInterest + interest);
      rows.push({ n, date, payment: 0, interest, principal: 0, balance, skipped: true });
      date = addMonths(date, 1);
      continue;
    }

    let principalPart = round2(pay + extraPay - interest);
    if (principalPart > balance) principalPart = round2(balance);
    const paid = round2(principalPart + interest);
    balance = round2(balance - principalPart);
    totalInterest = round2(totalInterest + interest);
    rows.push({
      n,
      date,
      payment: paid,
      interest,
      principal: principalPart,
      balance,
    });
    date = addMonths(date, 1);
  }
  return {
    rows,
    months: rows.length,
    totalInterest,
    totalPaid: round2(rows.reduce((s, x) => s + x.payment, 0)),
    payoffDate: rows.length ? rows[rows.length - 1].date : null,
  };
}

/* ------------------------------------------------------------------ */
/* Scheduled amounts that are not fixed                                */
/*                                                                     */
/* A credit-card payment is a bill you must not miss, but its amount   */
/* moves with the balance. Rather than make people retype it every     */
/* month, a recurring item can say where its amount comes from.        */
/* ------------------------------------------------------------------ */

export const AMOUNT_SOURCES = {
  FIXED: 'fixed',
  CARD_MINIMUM: 'card-minimum',
  CARD_FULL: 'card-full',
  LOAN_PAYMENT: 'loan-payment',
};

/**
 * What a scheduled item is actually worth right now.
 * @param {object} doc
 * @param {object} rule
 * @param {{balances?:Map}} [options] pass a precomputed balance map when
 *        resolving many occurrences at once, so the ledger is walked once.
 * @returns {{amount:number, estimated:boolean, note:string|null}}
 */
export function resolveRuleAmount(doc, rule, { balances = null } = {}) {
  const fixed = round2(Number(rule.amount) || 0);
  const source = rule.amountSource || AMOUNT_SOURCES.FIXED;
  if (source === AMOUNT_SOURCES.FIXED) return { amount: fixed, estimated: false, note: null };

  const account = byId(doc.accounts, rule.linkedAccountId || rule.transferAccountId);
  if (!account) return { amount: fixed, estimated: false, note: null };

  const balance = balances ? balances.get(account.id) || 0 : balanceOf(doc, account.id);
  const owed = Math.max(0, -balance);

  switch (source) {
    case AMOUNT_SOURCES.CARD_MINIMUM: {
      if (owed <= 0.005) {
        return { amount: 0, estimated: true, note: 'Nothing owed — no payment due' };
      }
      return {
        amount: minimumPayment(account, balance),
        estimated: true,
        note: `Minimum on ${money0(owed)} owed`,
      };
    }
    case AMOUNT_SOURCES.CARD_FULL: {
      if (owed <= 0.005) return { amount: 0, estimated: true, note: 'Nothing owed — no payment due' };
      return { amount: round2(owed), estimated: true, note: 'Paying the balance in full' };
    }
    case AMOUNT_SOURCES.LOAN_PAYMENT: {
      const payment = round2(Number(account.paymentAmount) || fixed);
      if (owed <= 0.005) return { amount: 0, estimated: true, note: 'Loan is paid off' };
      return { amount: Math.min(payment, round2(owed)), estimated: false, note: null };
    }
    default:
      return { amount: fixed, estimated: false, note: null };
  }
}

function money0(n) {
  return money(n, { cents: false });
}

/** Does this scheduled item's amount move on its own? */
export function hasDynamicAmount(rule) {
  return !!rule && !!rule.amountSource && rule.amountSource !== AMOUNT_SOURCES.FIXED;
}

/** The payment reminder linked to an account, if one exists. */
export function paymentRuleFor(doc, accountId) {
  return (doc.recurring || []).find((r) => r.linkedAccountId === accountId) || null;
}

/**
 * When this card or loan is next actually due.
 *
 * The schedule in Bills & Income is the authority, because that is what the
 * person edits and what the calendar and forecast already obey. Falling back
 * to `today()` — as the payoff schedule used to — silently re-dates the whole
 * amortisation to whenever the screen happened to be opened.
 */
export function nextPaymentDate(doc, accountId, from = today()) {
  const rule = paymentRuleFor(doc, accountId);
  if (rule && rule.active !== false) {
    // Walk forward past anything already paid or deliberately skipped: the next
    // payment is the next one that still has to happen. Starting a little in
    // the past means a genuinely missed payment is named rather than glossed
    // over by pointing at next month.
    const start = addDays(from, -45);
    const horizon = addMonths(from, 26);
    for (const date of occurrences(rule, start, horizon, { max: 40 })) {
      if (isOccurrenceSkipped(rule, date)) continue;
      if (isOccurrencePosted(doc, rule, date)) continue;
      return date;
    }
  }
  const account = byId(doc.accounts, accountId);
  const day = Number(account && account.dueDay) || 0;
  if (day) return nextDayOfMonth(day);
  if (account && account.firstPaymentDate && account.firstPaymentDate >= from) {
    return account.firstPaymentDate;
  }
  return from;
}

/** Months (`YYYY-MM`) in which this account's payment is being skipped. */
export function skippedPaymentMonths(doc, accountId, { from = today() } = {}) {
  const rule = paymentRuleFor(doc, accountId);
  if (!rule) return [];
  return skippedOccurrences(rule, { from }).map((s) => monthKey(s.date));
}

/** Liability accounts that have a due day but no reminder yet. */
export function accountsMissingPaymentReminder(doc) {
  return (doc.accounts || []).filter(
    (a) => !a.archived && isLiability(a.type) && !paymentRuleFor(doc, a.id)
  );
}

/**
 * Build the recurring item for a card or loan payment. The amount is left to
 * `resolveRuleAmount`, so it tracks the balance instead of going stale.
 */
export function buildPaymentRule(doc, account, { fromAccountId = null, dayOfMonth = null } = {}) {
  const isCard = account.type === 'credit';
  const day = Number(dayOfMonth || account.dueDay) || 1;
  const from =
    fromAccountId ||
    (doc.accounts || []).find((a) => !a.archived && a.type === 'checking')?.id ||
    (doc.accounts || []).find((a) => !a.archived && isSpendable(a.type))?.id ||
    '';

  const balances = allBalances(doc);
  const owed = Math.max(0, -(balances.get(account.id) || 0));

  return {
    id: uid('rec'),
    name: `${account.name} payment`,
    kind: 'transfer',
    accountId: from,
    transferAccountId: account.id,
    linkedAccountId: account.id,
    amountSource: isCard ? AMOUNT_SOURCES.CARD_MINIMUM : AMOUNT_SOURCES.LOAN_PAYMENT,
    amount: isCard ? minimumPayment(account, -owed) : round2(Number(account.paymentAmount) || 0),
    categoryId: '',
    payee: account.institution || account.name,
    frequency: 'monthly',
    interval: 1,
    startDate: nextDayOfMonth(day),
    dayOfMonth: day,
    endDate: '',
    autoPay: false,
    reminderDays: 5,
    weekendShift: 'before',
    variableAmount: isCard,
    active: true,
    notes: isCard
      ? 'Amount follows the card balance. Edit it when you record the payment if you are paying more than the minimum.'
      : '',
  };
}

/** The next occurrence of a day-of-month, on or after today. */
function nextDayOfMonth(day) {
  const now = dt(today());
  const target = Math.min(Math.max(1, day), 31);
  const thisMonth = clampDay(now.getFullYear(), now.getMonth(), target);
  if (thisMonth >= today()) return thisMonth;
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return clampDay(next.getFullYear(), next.getMonth(), target);
}

function clampDay(year, monthIndex, day) {
  const last = new Date(year, monthIndex + 1, 0).getDate();
  const d = new Date(year, monthIndex, Math.min(day, last));
  return iso(d);
}

/* ------------------------------------------------------------------ */
/* What a loan payment is actually made of                             */
/*                                                                     */
/* Money moved into a loan does not reduce the debt by the amount you  */
/* paid. The lender takes a month's interest first, and on a mortgage  */
/* the escrow for taxes and insurance never touches the loan at all.   */
/* Recording the payment as one transfer overstates the principal by   */
/* the interest every single month, and the balance drifts away from   */
/* the lender's.                                                       */
/* ------------------------------------------------------------------ */

/**
 * Split one payment into escrow, interest and principal.
 * @returns {{total,escrow,toLoan,interest,principal,owed,rate,shortfall:boolean}}
 */
export function paymentBreakdown(doc, account, { amount = null, balance = null } = {}) {
  const owed = Math.abs(balance === null ? balanceOf(doc, account.id) : balance);
  const total = round2(Math.abs(amount === null ? Number(account.paymentAmount) || 0 : amount));
  const escrow = Math.min(total, round2(Math.abs(Number(account.escrowAmount) || 0)));
  const toLoan = round2(total - escrow);
  const rate = (Number(account.apr) || Number(account.interestRate) || 0) / 100 / 12;
  const accrued = round2(owed * rate);
  // Never more interest than the payment covers, and never more than is owed.
  const interest = round2(Math.min(accrued, toLoan, owed));
  const principal = round2(Math.max(0, Math.min(toLoan - interest, owed - interest)));
  return {
    total,
    escrow,
    toLoan,
    interest,
    principal,
    owed,
    rate,
    // The payment does not even cover the month's interest: the balance grows.
    shortfall: accrued > toLoan && toLoan >= 0 && owed > 0,
    accrued,
  };
}

/* ------------------------------------------------------------------ */
/* Loan forgiveness (PSLF and friends)                                 */
/*                                                                     */
/* Some loans are never paid off — they are forgiven after a count of  */
/* qualifying payments. What matters is the count, not the balance, so */
/* paying extra is money thrown away and the payoff date is a fiction. */
/* ------------------------------------------------------------------ */

export const DEFAULT_FORGIVENESS_PAYMENTS = 120;

/**
 * Qualifying payments so far: the number already made before FinFolio existed,
 * plus the payments recorded here since counting began. The cut-off date is
 * what stops the two halves counting the same month twice.
 */
export function qualifyingPayments(doc, account) {
  const prior = Math.max(0, Math.round(Number(account.forgivenessPaymentsMade) || 0));
  const from = account.forgivenessCountFrom || '';
  const here = (doc.transactions || []).filter(
    (t) => t.type === 'transfer' && t.transferAccountId === account.id && (!from || t.date >= from)
  ).length;
  return prior + here;
}

/**
 * Progress toward forgiveness.
 * @returns {null|{required,made,remaining,percent,projectedDate,complete}}
 */
export function forgivenessProgress(doc, account) {
  if (!account || !account.forgiveness) return null;
  const required = Math.max(
    1,
    Math.round(Number(account.forgivenessRequired) || DEFAULT_FORGIVENESS_PAYMENTS)
  );
  const made = qualifyingPayments(doc, account);
  const remaining = Math.max(0, required - made);
  const rule = paymentRuleFor(doc, account.id);
  const each = rule ? perYear(rule.frequency) || 12 : 12;
  const monthsLeft = Math.ceil((remaining * 12) / Math.max(1, each));
  const start = nextPaymentDate(doc, account.id);
  return {
    required,
    made,
    remaining,
    percent: Math.min(100, (made / required) * 100),
    // The last qualifying payment is the one that earns it.
    projectedDate: remaining ? addMonths(start, Math.max(0, monthsLeft - 1)) : null,
    complete: remaining === 0,
  };
}

/** Minimum payment for a card, using percent-of-balance with a floor. */
export function minimumPayment(card, balanceOwed) {
  const owed = Math.abs(balanceOwed);
  if (owed <= 0) return 0;
  const pctPart = owed * ((Number(card.minPaymentPct) || 2) / 100);
  const floor = Number(card.minPaymentFloor) || 25;
  return round2(Math.min(owed, Math.max(pctPart, floor)));
}

export function utilization(card, balanceOwed) {
  const limit = Number(card.creditLimit) || 0;
  if (limit <= 0) return null;
  return Math.max(0, (Math.abs(balanceOwed) / limit) * 100);
}

/**
 * Headroom left on a card, in money rather than percent — which is what
 * anyone standing at a till is actually asking. Negative when over the limit.
 */
export function availableCredit(card, balanceOwed) {
  const limit = Number(card.creditLimit) || 0;
  if (limit <= 0) return null;
  return round2(limit - Math.abs(balanceOwed));
}

/* ------------------------------------------------------------------ */
/* How a schedule looks and where it belongs                           */
/* ------------------------------------------------------------------ */

/**
 * The icon for a scheduled item: its own if it has one, then its category's,
 * then the account it pays, then a default for its kind.
 *
 * Bills used to draw a hardcoded page glyph, so every category icon someone
 * chose was thrown away and every bill looked like a blank sheet of paper.
 */
export function scheduleIcon(doc, rule) {
  if (!rule) return '📄';
  if (rule.icon) return rule.icon;
  const category = byId(doc.categories, rule.categoryId);
  if (category && category.icon && category.icon !== '•') return category.icon;
  const linked = rule.linkedAccountId ? byId(doc.accounts, rule.linkedAccountId) : null;
  if (linked) return accountType(linked.type).icon;
  if (rule.kind === 'income') return '💰';
  if (rule.kind === 'subscription') return '📺';
  if (rule.kind === 'transfer') return '↔';
  return '📄';
}

/** The sections a list of schedules is broken into, in display order. */
export const SCHEDULE_GROUPS = [
  { id: 'income', label: 'Income & paydays' },
  { id: 'card', label: 'Credit cards' },
  { id: 'loan', label: 'Loans & mortgage' },
  { id: 'subscription', label: 'Subscriptions' },
  { id: 'transfer', label: 'Transfers & saving' },
  { id: 'bill', label: 'Bills' },
];

/** Which section a schedule belongs to. */
export function scheduleGroup(doc, rule) {
  if (!rule) return 'bill';
  if (rule.kind === 'income') return 'income';
  const linked = rule.linkedAccountId ? byId(doc.accounts, rule.linkedAccountId) : null;
  if (linked && linked.type === 'credit') return 'card';
  if (linked && isLiability(linked.type)) return 'loan';
  if (rule.kind === 'subscription') return 'subscription';
  if (rule.kind === 'transfer') return 'transfer';
  return 'bill';
}

/**
 * Break a list into those sections, keeping each one's order and dropping the
 * empty ones.
 * @param {(item:any)=>object} ruleOf how to get the rule out of a list item
 */
export function groupSchedules(doc, items, ruleOf = (i) => i.rule || i) {
  const buckets = new Map(SCHEDULE_GROUPS.map((g) => [g.id, { ...g, items: [] }]));
  for (const item of items || []) {
    const bucket = buckets.get(scheduleGroup(doc, ruleOf(item)));
    (bucket || buckets.get('bill')).items.push(item);
  }
  return [...buckets.values()].filter((g) => g.items.length);
}

/* ------------------------------------------------------------------ */
/* Subscriptions                                                       */
/*                                                                     */
/* Small amounts on a monthly repeat are the easiest money to lose     */
/* track of, and the easiest to get back. The point of this is the     */
/* annual figure, which is where a $12 habit stops looking like $12.   */
/* ------------------------------------------------------------------ */

export function subscriptionSummary(doc, { cancelling = [] } = {}) {
  const balances = allBalances(doc);
  const cut = new Set(cancelling);
  const items = (doc.recurring || [])
    .filter((r) => r.kind === 'subscription')
    .map((rule) => {
      const amount = resolveRuleAmount(doc, rule, { balances }).amount;
      const perMonth = round2((amount * perYear(rule.frequency)) / 12);
      return {
        rule,
        amount,
        perMonth,
        perYear: round2(perMonth * 12),
        active: rule.active !== false,
        cutting: cut.has(rule.id),
        nextDue: nextDue(rule),
      };
    })
    .sort((a, b) => b.perMonth - a.perMonth);

  const live = items.filter((i) => i.active);
  const monthly = round2(live.reduce((s, i) => s + i.perMonth, 0));
  const saving = round2(live.filter((i) => i.cutting).reduce((s, i) => s + i.perMonth, 0));
  const load = monthlyRecurringLoad(doc);

  return {
    items,
    count: items.length,
    activeCount: live.length,
    pausedCount: items.length - live.length,
    monthly,
    yearly: round2(monthly * 12),
    saving,
    savingYearly: round2(saving * 12),
    remaining: round2(monthly - saving),
    cuttingCount: live.filter((i) => i.cutting).length,
    // What the whole habit costs against what comes in — the number that makes
    // people sit up, rather than any individual line.
    shareOfIncome: load.income > 0 ? (monthly / load.income) * 100 : null,
  };
}

/* ------------------------------------------------------------------ */
/* Debt payoff planner                                                 */
/* ------------------------------------------------------------------ */

/**
 * Simulate paying several debts with a fixed monthly budget.
 * @param {{id:string,name:string,balance:number,apr:number,minPayment:number}[]} debts
 * @param {number} extra  extra dollars per month above the minimums
 * @param {'avalanche'|'snowball'|'custom'} strategy
 */
export function debtPlan(debts, extra = 0, strategy = 'avalanche', { startDate = today(), maxMonths = 600 } = {}) {
  const items = debts
    .filter((d) => Math.abs(Number(d.balance) || 0) > 0.005)
    .map((d) => ({
      id: d.id,
      name: d.name,
      balance: Math.abs(Number(d.balance) || 0),
      apr: Number(d.apr) || 0,
      min: Math.max(0, Number(d.minPayment) || 0),
      order: Number(d.order) || 0,
      interest: 0,
      payoffDate: null,
      months: 0,
      // Forgiven loans keep paying their minimum — that is what earns the
      // forgiveness — but never receive extra, because clearing the balance
      // early only means paying money that was going to be written off.
      forgivenessDate: (d.forgiveness && d.forgiveness.projectedDate) || null,
      forgiven: false,
    }));
  if (!items.length) {
    return { months: 0, totalInterest: 0, totalPaid: 0, payoffDate: null, debts: [], timeline: [] };
  }

  const rank = (a, b) => {
    if (strategy === 'snowball') return a.balance - b.balance || b.apr - a.apr;
    if (strategy === 'custom') return a.order - b.order;
    return b.apr - a.apr || a.balance - b.balance;
  };

  const timeline = [];
  let date = startDate;
  let month = 0;
  let totalInterest = 0;
  let totalPaid = 0;
  const budget = items.reduce((s, d) => s + d.min, 0) + Math.max(0, Number(extra) || 0);

  while (items.some((d) => d.balance > 0.005) && month < maxMonths) {
    month += 1;
    let available = budget;
    let monthInterest = 0;

    // 1. accrue interest
    for (const d of items) {
      if (d.balance <= 0.005) continue;
      const i = round2((d.balance * (d.apr / 100)) / 12);
      d.balance = round2(d.balance + i);
      d.interest = round2(d.interest + i);
      monthInterest = round2(monthInterest + i);
    }

    // 2. minimums on everything still open
    for (const d of items) {
      if (d.balance <= 0.005) continue;
      const pay = Math.min(d.min, d.balance, available);
      d.balance = round2(d.balance - pay);
      available = round2(available - pay);
      totalPaid = round2(totalPaid + pay);
    }

    // 3. everything left goes to the target debt, cascading as debts clear
    const queue = items.filter((d) => d.balance > 0.005 && !d.forgivenessDate).sort(rank);
    for (const d of queue) {
      if (available <= 0.005) break;
      const pay = Math.min(available, d.balance);
      d.balance = round2(d.balance - pay);
      available = round2(available - pay);
      totalPaid = round2(totalPaid + pay);
    }

    totalInterest = round2(totalInterest + monthInterest);
    for (const d of items) {
      // Forgiveness ends the debt whatever is left on it.
      if (d.forgivenessDate && !d.payoffDate && date >= d.forgivenessDate) {
        d.payoffDate = d.forgivenessDate;
        d.months = month;
        d.forgiven = true;
        d.balance = 0;
        continue;
      }
      if (d.balance <= 0.005 && !d.payoffDate) {
        d.payoffDate = date;
        d.months = month;
        d.balance = 0;
      }
    }
    timeline.push({
      month,
      date,
      interest: monthInterest,
      remaining: round2(items.reduce((s, d) => s + d.balance, 0)),
      balances: Object.fromEntries(items.map((d) => [d.id, d.balance])),
    });
    date = addMonths(date, 1);
  }

  return {
    months: month,
    totalInterest,
    totalPaid,
    monthlyBudget: round2(budget),
    payoffDate: timeline.length ? timeline[timeline.length - 1].date : null,
    debts: items.map((d) => ({
      id: d.id,
      name: d.name,
      interest: d.interest,
      payoffDate: d.payoffDate,
      months: d.months,
      forgiven: d.forgiven,
    })),
    timeline,
  };
}

/** Build the debt list straight from the document's liability accounts. */
export function debtsFromAccounts(doc) {
  const balances = allBalances(doc);
  return (doc.accounts || [])
    .filter((a) => !a.archived && isLiability(a.type))
    .map((a) => {
      const owed = Math.abs(balances.get(a.id) || 0);
      return {
        id: a.id,
        name: a.name,
        type: a.type,
        balance: owed,
        apr: Number(a.apr) || Number(a.interestRate) || 0,
        // Escrow is taxes and insurance passing through — it never touches the
        // loan, so it must not be counted as money paying the debt down.
        minPayment:
          a.type === 'credit'
            ? minimumPayment(a, owed)
            : Math.max(
                0,
                round2(
                  (Number(a.paymentAmount) || minimumPayment({ minPaymentPct: 2, minPaymentFloor: 25 }, owed)) -
                    (Number(a.escrowAmount) || 0)
                )
              ),
        escrow: round2(Number(a.escrowAmount) || 0),
        limit: Number(a.creditLimit) || 0,
        order: Number(a.payoffOrder) || 0,
        // Carried so the payoff schedule starts on the real due date rather
        // than on whatever day the screen was opened.
        nextPayment: nextPaymentDate(doc, a.id),
        skipMonths: skippedPaymentMonths(doc, a.id),
        lastPayment: lastPaymentInto(doc, a.id),
        // A loan heading for forgiveness is never "paid off", and putting extra
        // money at it buys nothing — the plan must leave it alone.
        forgiveness: forgivenessProgress(doc, a),
        // Set aside from the payoff plan. A 30-year mortgage at 5% swamps an
        // avalanche and is not the debt anyone is trying to attack; leaving it
        // out is a legitimate plan, not a way of pretending it is gone.
        inPlan: a.inPayoffPlan !== false,
      };
    })
    .filter((d) => d.balance > 0.005);
}

/* ------------------------------------------------------------------ */
/* Budgets                                                             */
/* ------------------------------------------------------------------ */

export function budgetFor(doc, categoryId, month) {
  const list = doc.budgets || [];
  return (
    list.find((b) => b.categoryId === categoryId && b.month === month) ||
    list.find((b) => b.categoryId === categoryId && (!b.month || b.month === 'default')) ||
    null
  );
}

/**
 * Spending in a month against a category.
 *
 * A parent includes its children, because "Pet food" is pet spending. Any
 * child with a budget of its own is left out via `exclude` — a sub-budget is
 * carved out of the parent, not counted on top of it.
 */
export function spentInMonth(doc, categoryId, month, { includeChildren = true, exclude = null } = {}) {
  const from = `${month}-01`;
  const to = endOfMonth(from);
  const wanted = new Set(includeChildren ? categoryFamily(doc, categoryId) : [categoryId]);
  if (exclude) for (const id of exclude) wanted.delete(id);
  let total = 0;
  for (const t of doc.transactions || []) {
    if (t.type !== 'expense' || t.date < from || t.date > to) continue;
    if (Array.isArray(t.splits) && t.splits.length) {
      for (const s of t.splits) if (wanted.has(s.categoryId)) total += Number(s.amount) || 0;
    } else if (wanted.has(t.categoryId)) {
      total += Number(t.amount) || 0;
    }
  }
  return round2(total);
}

/**
 * Budget rows for a month, including rollover carry-in when enabled.
 */
export function budgetProgress(doc, month = monthKey(today())) {
  const rows = [];
  const seen = new Set();
  // Children that carry their own budget line are reported on their own, so
  // their parent must not count them again.
  const budgetedChildren = new Set(
    (doc.budgets || [])
      .map((b) => byId(doc.categories, b.categoryId))
      .filter((c) => c && c.parentId)
      .map((c) => c.id)
  );
  for (const b of doc.budgets || []) {
    if (seen.has(b.categoryId)) continue;
    const budget = budgetFor(doc, b.categoryId, month);
    if (!budget) continue;
    seen.add(b.categoryId);
    const planned = Number(budget.amount) || 0;
    // A category never excludes itself — only the *other* children that are
    // reporting on their own line.
    const others = new Set(budgetedChildren);
    others.delete(b.categoryId);
    const spent = spentInMonth(doc, b.categoryId, month, { exclude: others });
    const carry = budget.rollover ? rolloverInto(doc, b.categoryId, month) : 0;
    const available = round2(planned + carry);
    rows.push({
      categoryId: b.categoryId,
      name: categoryLabel(doc, b.categoryId, { full: true }),
      planned: round2(planned),
      carry: round2(carry),
      available,
      spent,
      remaining: round2(available - spent),
      pct: available > 0 ? (spent / available) * 100 : spent > 0 ? 100 : 0,
      rollover: !!budget.rollover,
    });
  }
  rows.sort((a, b) => b.spent - a.spent);
  const totals = rows.reduce(
    (acc, r) => ({
      planned: round2(acc.planned + r.planned),
      available: round2(acc.available + r.available),
      spent: round2(acc.spent + r.spent),
      remaining: round2(acc.remaining + r.remaining),
    }),
    { planned: 0, available: 0, spent: 0, remaining: 0 }
  );
  return { month, rows, totals };
}

function rolloverInto(doc, categoryId, month, depth = 12) {
  let carry = 0;
  const months = [];
  let m = month;
  for (let i = 0; i < depth; i += 1) {
    m = monthKey(addMonths(`${m}-01`, -1));
    months.unshift(m);
  }
  for (const key of months) {
    const b = budgetFor(doc, categoryId, key);
    if (!b || !b.rollover) {
      carry = 0;
      continue;
    }
    const planned = Number(b.amount) || 0;
    const spent = spentInMonth(doc, categoryId, key);
    carry = round2(Math.max(0, planned + carry - spent));
  }
  return carry;
}

/* ------------------------------------------------------------------ */
/* Goals                                                               */
/* ------------------------------------------------------------------ */

export function goalProgress(doc, goal) {
  const target = Number(goal.targetAmount) || 0;
  let saved = 0;
  if (goal.accountId) {
    const bal = balanceOf(doc, goal.accountId);
    saved = Math.max(0, bal - (Number(goal.baseline) || 0));
  }
  saved += (goal.contributions || []).reduce((s, c) => s + (Number(c.amount) || 0), 0);
  saved = round2(saved);
  const pct = target > 0 ? Math.min(100, (saved / target) * 100) : 0;
  const remaining = round2(Math.max(0, target - saved));
  let perMonth = null;
  let monthsLeft = null;
  if (goal.targetDate) {
    const d = diffDays(today(), goal.targetDate);
    monthsLeft = Math.max(0, d / 30.44);
    perMonth = monthsLeft > 0.1 ? round2(remaining / monthsLeft) : remaining;
  }
  let projectedDate = null;
  if (goal.monthlyContribution > 0 && remaining > 0) {
    projectedDate = addMonths(today(), Math.ceil(remaining / goal.monthlyContribution));
  }
  return { saved, target, pct, remaining, perMonth, monthsLeft, projectedDate, done: remaining <= 0.005 };
}

/* ------------------------------------------------------------------ */
/* Auto-categorisation rules                                           */
/* ------------------------------------------------------------------ */

export function matchRule(rule, tx) {
  if (rule.enabled === false) return false;
  const field = rule.field || 'payee';
  const haystack = String((field === 'notes' ? tx.notes : tx.payee) || '').toLowerCase();
  const needle = String(rule.value || '').toLowerCase().trim();
  if (!needle) return false;
  switch (rule.op) {
    case 'equals':
      return haystack === needle;
    case 'startsWith':
      return haystack.startsWith(needle);
    case 'endsWith':
      return haystack.endsWith(needle);
    case 'regex':
      try {
        return new RegExp(rule.value, 'i').test(field === 'notes' ? tx.notes || '' : tx.payee || '');
      } catch {
        return false;
      }
    default:
      return haystack.includes(needle);
  }
}

/** Apply the first matching rule; returns a patch, not a mutated object. */
export function applyRules(doc, tx) {
  const rules = [...(doc.rules || [])].sort((a, b) => (a.priority || 0) - (b.priority || 0));
  for (const r of rules) {
    if (matchRule(r, tx)) {
      const patch = {};
      if (r.categoryId) patch.categoryId = r.categoryId;
      if (r.renamePayee) patch.payee = r.renamePayee;
      if (r.setTags && r.setTags.length) patch.tags = [...new Set([...(tx.tags || []), ...r.setTags])];
      if (r.accountId) patch.accountId = r.accountId;
      return { rule: r, patch };
    }
  }
  return null;
}

/** Category suggestion learned from history when no rule matches. */
export function suggestCategory(doc, payee) {
  const p = String(payee || '').trim().toLowerCase();
  if (!p) return null;
  const counts = new Map();
  for (const t of doc.transactions || []) {
    if (!t.categoryId) continue;
    if (String(t.payee || '').trim().toLowerCase() !== p) continue;
    counts.set(t.categoryId, (counts.get(t.categoryId) || 0) + 1);
  }
  let best = null;
  for (const [id, n] of counts) if (!best || n > best.n) best = { id, n };
  return best ? best.id : null;
}

/* ------------------------------------------------------------------ */
/* Insights                                                            */
/* ------------------------------------------------------------------ */

/** Short, actionable observations for the dashboard. */
export function insights(doc) {
  const out = [];
  const settings = doc.settings || {};
  const fc = forecast(doc, { days: settings.forecastDays || 90 });
  const threshold = Number(settings.lowBalanceThreshold) || 0;

  if (fc.min.balance < threshold) {
    out.push({
      tone: fc.min.balance < 0 ? 'critical' : 'warning',
      title: fc.min.balance < 0 ? 'Projected overdraft' : 'Low balance ahead',
      body: `Spendable balance dips to ${fc.min.balance.toFixed(2)} around ${fc.min.date}.`,
      action: { view: 'calendar' },
    });
  }

  const overdue = upcomingItems(doc, { days: 0 }).filter((i) => i.overdue);
  if (overdue.length) {
    out.push({
      tone: 'critical',
      title: `${overdue.length} bill${overdue.length > 1 ? 's' : ''} past due`,
      body: overdue.slice(0, 3).map((i) => i.rule.name).join(', '),
      action: { view: 'recurring' },
    });
  }

  const balances = allBalances(doc);
  for (const a of doc.accounts || []) {
    if (a.archived || a.type !== 'credit') continue;
    const u = utilization(a, balances.get(a.id) || 0);
    if (u !== null && u >= 30) {
      out.push({
        tone: u >= 70 ? 'critical' : 'warning',
        title: `${a.name} is ${u.toFixed(0)}% utilised`,
        body: 'Keeping utilisation under 30% generally helps your credit score.',
        action: { view: 'debt' },
      });
    }
  }

  const months = monthlyTotals(doc, 4);
  const complete = months.slice(0, -1);
  if (complete.length >= 3) {
    const avg = complete.reduce((s, m) => s + m.expense, 0) / complete.length;
    const current = months[months.length - 1];
    if (avg > 0 && current.expense > avg * 1.25) {
      out.push({
        tone: 'warning',
        title: 'Spending is running high',
        body: `This month is ${(((current.expense - avg) / avg) * 100).toFixed(0)}% above your 3-month average.`,
        action: { view: 'reports' },
      });
    }
  }

  const uncategorised = (doc.transactions || []).filter(
    (t) => t.type === 'expense' && !t.categoryId
  ).length;
  if (uncategorised >= 5) {
    out.push({
      tone: 'info',
      title: `${uncategorised} transactions need a category`,
      body: 'Categorising them makes budgets and reports accurate.',
      action: { view: 'transactions', filter: 'uncategorized' },
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Misc helpers                                                        */
/* ------------------------------------------------------------------ */

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
}

export function transactionHash(t) {
  return [t.date, Math.abs(Number(t.amount) || 0).toFixed(2), String(t.payee || '').trim().toLowerCase()].join('|');
}

/** Detect likely duplicates when importing. */
export function findDuplicate(doc, candidate, windowDays = 4) {
  const amt = Math.abs(Number(candidate.amount) || 0);
  const payee = String(candidate.payee || '').trim().toLowerCase();
  const lo = addDays(candidate.date, -windowDays);
  const hi = addDays(candidate.date, windowDays);
  return (
    (doc.transactions || []).find((t) => {
      if (t.accountId !== candidate.accountId) return false;
      if (t.date < lo || t.date > hi) return false;
      if (Math.abs(Math.abs(Number(t.amount) || 0) - amt) > 0.005) return false;
      const p = String(t.payee || '').trim().toLowerCase();
      return !payee || !p || p === payee || p.includes(payee) || payee.includes(p);
    }) || null
  );
}

export { today, iso, dt, addDays, addMonths, diffDays, monthKey, startOfMonth, endOfMonth, round2, nextDue };
