/**
 * Unit tests for the parts that must never be wrong: balances, recurrence
 * dates, amortisation, the payoff planner, budgets, parsing, encryption and
 * the atomic store.
 *
 *   npm test
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const R = (p) => path.join(here, '..', 'src', 'renderer', 'js', p);

const finance = await import(`file://${R('finance.js')}`);
const recur = await import(`file://${R('recurrence.js')}`);
const fmt = await import(`file://${R('format.js')}`);
const parsers = await import(`file://${R('parsers.js')}`);

const crypto = require('../src/main/crypto.js');
const schema = require('../src/main/schema.js');
const { Store } = require('../src/main/store.js');
const { mergeDocuments } = require('../src/main/merge.js');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => { passed += 1; },
        (err) => { failed += 1; failures.push([name, err]); }
      );
    }
    passed += 1;
  } catch (err) {
    failed += 1;
    failures.push([name, err]);
  }
  return Promise.resolve();
}

const near = (a, b, tol = 0.02) =>
  assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b} (±${tol})`);

/* ------------------------------ fixtures -------------------------- */

function makeDoc() {
  const doc = schema.emptyDocument();
  doc.accounts = [
    { id: 'chk', name: 'Checking', type: 'checking', openingBalance: 1000, openingDate: '2026-01-01' },
    { id: 'sav', name: 'Savings', type: 'savings', openingBalance: 5000, openingDate: '2026-01-01' },
    { id: 'cc', name: 'Visa', type: 'credit', openingBalance: -800, openingDate: '2026-01-01', creditLimit: 4000, apr: 19.99, minPaymentPct: 2, minPaymentFloor: 25 },
    { id: 'loan', name: 'Car loan', type: 'loan', openingBalance: -12000, openingDate: '2026-01-01', interestRate: 6, paymentAmount: 350, originalPrincipal: 20000 },
  ];
  doc.categories = [
    { id: 'groceries', name: 'Groceries', group: 'Food', kind: 'expense' },
    { id: 'salary', name: 'Salary', group: 'Income', kind: 'income' },
    { id: 'gas', name: 'Fuel', group: 'Transport', kind: 'expense' },
  ];
  doc.transactions = [
    { id: 't1', type: 'income', date: '2026-02-01', amount: 2500, accountId: 'chk', categoryId: 'salary', cleared: true },
    { id: 't2', type: 'expense', date: '2026-02-03', amount: 150.5, accountId: 'chk', categoryId: 'groceries', payee: 'Kroger', cleared: true },
    { id: 't3', type: 'expense', date: '2026-02-05', amount: 60, accountId: 'cc', categoryId: 'gas', payee: 'Shell', cleared: false },
    { id: 't4', type: 'transfer', date: '2026-02-06', amount: 400, accountId: 'chk', transferAccountId: 'sav', cleared: true },
    { id: 't5', type: 'transfer', date: '2026-02-10', amount: 200, accountId: 'chk', transferAccountId: 'cc', cleared: true },
  ];
  return doc;
}

/* ------------------------------ balances -------------------------- */

await test('balances: income, expense and transfers apply with the right sign', () => {
  const doc = makeDoc();
  const b = finance.allBalances(doc);
  // 1000 + 2500 − 150.50 − 400 − 200
  near(b.get('chk'), 2749.5);
  near(b.get('sav'), 5400);
  // −800 − 60 + 200
  near(b.get('cc'), -660);
  near(b.get('loan'), -12000);
});

await test('balances: as-of date excludes later transactions', () => {
  const doc = makeDoc();
  near(finance.balanceOf(doc, 'chk', '2026-02-04'), 3349.5);
});

await test('balances: cleared balance ignores pending rows', () => {
  const doc = makeDoc();
  near(finance.clearedBalance(doc, 'cc'), -600); // the $60 pending charge is excluded
});

await test('net worth nets assets against liabilities', () => {
  const doc = makeDoc();
  const nw = finance.netWorth(doc);
  near(nw.assets, 8149.5);
  near(nw.debt, 12660);
  near(nw.net, 8149.5 - 12660);
});

await test('cash on hand counts only spendable accounts', () => {
  const doc = makeDoc();
  near(finance.cashOnHand(doc), 2749.5 + 5400);
});

await test('running balance walks oldest → newest', () => {
  const doc = makeDoc();
  const rows = finance.withRunningBalance(doc, 'chk', doc.transactions.filter((t) => t.accountId === 'chk'));
  near(rows[rows.length - 1]._balance, 3500); // oldest row: 1000 + 2500
  near(rows[0]._balance, 2749.5); // newest row
});

/* ----------------------------- recurrence ------------------------- */

await test('monthly on the 31st clamps to short months and returns', () => {
  const rule = { frequency: 'monthly', startDate: '2026-01-31', dayOfMonth: 31 };
  assert.equal(recur.nth(rule, 0), '2026-01-31');
  assert.equal(recur.nth(rule, 1), '2026-02-28');
  assert.equal(recur.nth(rule, 2), '2026-03-31');
  assert.equal(recur.nth(rule, 3), '2026-04-30');
});

await test('monthly on the 15th does not drift', () => {
  const rule = { frequency: 'monthly', startDate: '2026-01-15', dayOfMonth: 15 };
  assert.equal(recur.nth(rule, 12), '2027-01-15');
});

await test('biweekly steps exactly 14 days', () => {
  const rule = { frequency: 'biweekly', startDate: '2026-01-02' };
  assert.equal(recur.nth(rule, 1), '2026-01-16');
  assert.equal(recur.nth(rule, 26), '2027-01-01');
});

await test('semimonthly alternates the two chosen days', () => {
  const rule = { frequency: 'semimonthly', startDate: '2026-01-01', dayOfMonth: 1, dayOfMonth2: 15 };
  const list = recur.occurrences(rule, '2026-01-01', '2026-02-28');
  assert.deepEqual(list, ['2026-01-01', '2026-01-15', '2026-02-01', '2026-02-15']);
});

await test('weekend shift moves a Saturday due date', () => {
  // 2026-08-01 is a Saturday.
  const before = { frequency: 'monthly', startDate: '2026-08-01', dayOfMonth: 1, weekendShift: 'before' };
  const after = { frequency: 'monthly', startDate: '2026-08-01', dayOfMonth: 1, weekendShift: 'after' };
  assert.equal(recur.occurrences(before, '2026-07-01', '2026-08-31')[0], '2026-07-31');
  assert.equal(recur.occurrences(after, '2026-08-01', '2026-08-31')[0], '2026-08-03');
});

await test('occurrences respects an end date and a window', () => {
  const rule = { frequency: 'monthly', startDate: '2026-01-10', dayOfMonth: 10, endDate: '2026-04-30' };
  const list = recur.occurrences(rule, '2026-01-01', '2026-12-31');
  assert.deepEqual(list, ['2026-01-10', '2026-02-10', '2026-03-10', '2026-04-10']);
});

await test('occurrences far from the start date stay cheap and correct', () => {
  const rule = { frequency: 'weekly', startDate: '2000-01-01' };
  const list = recur.occurrences(rule, '2026-09-01', '2026-09-30');
  assert.ok(list.length >= 4 && list.length <= 5);
  for (const d of list) assert.equal(new Date(`${d}T00:00:00`).getDay(), 6); // all Saturdays
});

await test('one-time rules fire exactly once', () => {
  const rule = { frequency: 'once', startDate: '2026-05-05' };
  assert.deepEqual(recur.occurrences(rule, '2026-01-01', '2027-01-01'), ['2026-05-05']);
});

await test('nextDue finds the next date on or after today', () => {
  const rule = { frequency: 'monthly', startDate: '2026-01-05', dayOfMonth: 5 };
  assert.equal(recur.nextDue(rule, '2026-03-06'), '2026-04-05');
  assert.equal(recur.nextDue(rule, '2026-03-05'), '2026-03-05');
});

/* ---------------------------- amortisation ------------------------ */

await test('level payment matches the standard annuity formula', () => {
  // $200,000 at 6% for 360 months ≈ $1,199.10
  near(finance.levelPayment(200000, 6, 360), 1199.1, 0.5);
});

await test('amortisation pays the loan off and totals are consistent', () => {
  const s = finance.amortize({ principal: 12000, annualRate: 6, payment: 350, startDate: '2026-01-01' });
  assert.ok(s.months > 0 && s.months < 48);
  near(s.rows[s.rows.length - 1].balance, 0, 0.01);
  near(s.totalPaid, 12000 + s.totalInterest, 0.05);
  // First month interest = 12000 * 0.06/12
  near(s.rows[0].interest, 60);
});

await test('amortisation refuses a payment that never clears the balance', () => {
  const s = finance.amortize({ principal: 5000, annualRate: 24, payment: 50 });
  assert.equal(s.error, 'PAYMENT_TOO_LOW');
  assert.ok(s.minimumViable > 100);
});

await test('zero-interest loans divide evenly', () => {
  const s = finance.amortize({ principal: 1200, annualRate: 0, payment: 100 });
  assert.equal(s.months, 12);
  near(s.totalInterest, 0);
});

await test('extra payments shorten the term', () => {
  const base = finance.amortize({ principal: 12000, annualRate: 6, payment: 350 });
  const fast = finance.amortize({ principal: 12000, annualRate: 6, payment: 350, extra: 150 });
  assert.ok(fast.months < base.months);
  assert.ok(fast.totalInterest < base.totalInterest);
});

/* ---------------------------- debt planner ------------------------ */

const DEBTS = [
  { id: 'a', name: 'Card A', balance: 1000, apr: 24, minPayment: 30 },
  { id: 'b', name: 'Card B', balance: 5000, apr: 12, minPayment: 100 },
];

await test('avalanche clears the highest rate first', () => {
  const plan = finance.debtPlan(DEBTS, 200, 'avalanche');
  const a = plan.debts.find((d) => d.id === 'a');
  const b = plan.debts.find((d) => d.id === 'b');
  assert.ok(a.months <= b.months);
  assert.ok(plan.months > 0 && plan.months < 120);
});

await test('snowball clears the smallest balance first', () => {
  const plan = finance.debtPlan(DEBTS, 200, 'snowball');
  const a = plan.debts.find((d) => d.id === 'a');
  const b = plan.debts.find((d) => d.id === 'b');
  assert.ok(a.months < b.months);
});

await test('avalanche costs no more interest than snowball', () => {
  const av = finance.debtPlan(DEBTS, 200, 'avalanche');
  const sn = finance.debtPlan(DEBTS, 200, 'snowball');
  assert.ok(av.totalInterest <= sn.totalInterest + 0.01);
});

await test('extra payments reduce both time and interest', () => {
  const none = finance.debtPlan(DEBTS, 0, 'avalanche');
  const extra = finance.debtPlan(DEBTS, 300, 'avalanche');
  assert.ok(extra.months < none.months);
  assert.ok(extra.totalInterest < none.totalInterest);
});

await test('debt planner returns an empty plan when there is no debt', () => {
  const plan = finance.debtPlan([], 100, 'avalanche');
  assert.equal(plan.months, 0);
  assert.deepEqual(plan.debts, []);
});

await test('debts are read from liability accounts with the right sign', () => {
  const doc = makeDoc();
  const debts = finance.debtsFromAccounts(doc);
  const visa = debts.find((d) => d.id === 'cc');
  near(visa.balance, 660);
  assert.equal(visa.apr, 19.99);
});

/* ------------------------------ forecast -------------------------- */

await test('forecast applies scheduled items to the projected balance', () => {
  const doc = makeDoc();
  const start = fmt.today();
  doc.transactions = [
    { id: 'x', type: 'income', date: fmt.addDays(start, -1), amount: 1000, accountId: 'chk' },
  ];
  doc.accounts = [{ id: 'chk', name: 'Checking', type: 'checking', openingBalance: 0 }];
  doc.recurring = [
    {
      id: 'r1', name: 'Rent', kind: 'bill', amount: 400, accountId: 'chk',
      frequency: 'monthly', startDate: fmt.addDays(start, 5), dayOfMonth: fmt.dt(fmt.addDays(start, 5)).getDate(), active: true,
    },
  ];
  const fc = finance.forecast(doc, { days: 20, from: start });
  near(fc.start, 1000);
  near(fc.series[20].balance, 600);
  near(fc.min.balance, 600);
});

await test('forecast does not double count an occurrence already recorded', () => {
  const doc = schema.emptyDocument();
  const start = fmt.today();
  const due = fmt.addDays(start, 3);
  doc.accounts = [{ id: 'chk', name: 'Checking', type: 'checking', openingBalance: 500 }];
  doc.recurring = [
    { id: 'r1', name: 'Power', kind: 'bill', amount: 100, accountId: 'chk', frequency: 'monthly', startDate: due, dayOfMonth: fmt.dt(due).getDate(), active: true },
  ];
  doc.transactions = [
    { id: 't1', type: 'expense', date: due, amount: 100, accountId: 'chk', recurringId: 'r1' },
  ];
  const fc = finance.forecast(doc, { days: 10, from: start });
  near(fc.series[10].balance, 400); // charged once, not twice
});

await test('upcoming items flag overdue schedules', () => {
  const doc = schema.emptyDocument();
  const start = fmt.today();
  doc.accounts = [{ id: 'chk', name: 'Checking', type: 'checking', openingBalance: 0 }];
  doc.recurring = [
    { id: 'r1', name: 'Late bill', kind: 'bill', amount: 50, accountId: 'chk', frequency: 'monthly', startDate: fmt.addDays(start, -10), dayOfMonth: fmt.dt(fmt.addDays(start, -10)).getDate(), active: true },
  ];
  const items = finance.upcomingItems(doc, { days: 5, from: start });
  assert.ok(items.some((i) => i.overdue));
});

/* ------------------------------ budgets --------------------------- */

await test('budget progress sums spending in the month only', () => {
  const doc = makeDoc();
  doc.budgets = [{ id: 'b1', categoryId: 'groceries', month: '2026-02', amount: 400 }];
  const p = finance.budgetProgress(doc, '2026-02');
  const row = p.rows.find((r) => r.categoryId === 'groceries');
  near(row.spent, 150.5);
  near(row.remaining, 249.5);
});

await test('rollover carries unspent budget into the next month', () => {
  const doc = makeDoc();
  doc.transactions = [
    { id: 'a', type: 'expense', date: '2026-01-10', amount: 100, accountId: 'chk', categoryId: 'groceries' },
    { id: 'b', type: 'expense', date: '2026-02-10', amount: 50, accountId: 'chk', categoryId: 'groceries' },
  ];
  doc.budgets = [
    { id: 'b1', categoryId: 'groceries', month: '2026-01', amount: 300, rollover: true },
    { id: 'b2', categoryId: 'groceries', month: '2026-02', amount: 300, rollover: true },
  ];
  const p = finance.budgetProgress(doc, '2026-02');
  const row = p.rows.find((r) => r.categoryId === 'groceries');
  near(row.carry, 200); // 300 budgeted − 100 spent in January
  near(row.available, 500);
  near(row.remaining, 450);
});

await test('splits are counted per category', () => {
  const doc = makeDoc();
  doc.transactions = [
    {
      id: 's1', type: 'expense', date: '2026-02-12', amount: 100, accountId: 'chk',
      splits: [{ categoryId: 'groceries', amount: 70 }, { categoryId: 'gas', amount: 30 }],
    },
  ];
  const totals = finance.categoryTotals(doc, { from: '2026-02-01', to: '2026-02-28' });
  near(totals.find((t) => t.categoryId === 'groceries').amount, 70);
  near(totals.find((t) => t.categoryId === 'gas').amount, 30);
});

/* ------------------------------ matching -------------------------- */

await test('duplicate detection matches on date window, amount and payee', () => {
  const doc = makeDoc();
  const dup = finance.findDuplicate(doc, { accountId: 'chk', date: '2026-02-04', amount: 150.5, payee: 'KROGER' });
  assert.ok(dup);
  assert.equal(dup.id, 't2');
  assert.equal(finance.findDuplicate(doc, { accountId: 'chk', date: '2026-02-20', amount: 150.5, payee: 'Kroger' }), null);
});

await test('rules set the category and can rename the payee', () => {
  const doc = makeDoc();
  doc.rules = [{ id: 'r', field: 'payee', op: 'contains', value: 'shell', categoryId: 'gas', renamePayee: 'Shell', enabled: true }];
  const res = finance.applyRules(doc, { payee: 'SHELL OIL 4471', amount: 40 });
  assert.equal(res.patch.categoryId, 'gas');
  assert.equal(res.patch.payee, 'Shell');
});

await test('category suggestion learns from history', () => {
  const doc = makeDoc();
  assert.equal(finance.suggestCategory(doc, 'kroger'), 'groceries');
  assert.equal(finance.suggestCategory(doc, 'nowhere'), null);
});

await test('minimum payment uses percent with a floor', () => {
  near(finance.minimumPayment({ minPaymentPct: 2, minPaymentFloor: 25 }, -5000), 100);
  near(finance.minimumPayment({ minPaymentPct: 2, minPaymentFloor: 25 }, -300), 25);
  near(finance.minimumPayment({ minPaymentPct: 2, minPaymentFloor: 25 }, -10), 10);
});

await test('utilisation is a percentage of the limit', () => {
  near(finance.utilization({ creditLimit: 4000 }, -1000), 25);
  assert.equal(finance.utilization({ creditLimit: 0 }, -100), null);
});

/* ------------------------------ formats --------------------------- */

await test('dates are treated as local calendar days', () => {
  assert.equal(fmt.addDays('2026-03-08', 1), '2026-03-09'); // DST boundary in the US
  assert.equal(fmt.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(fmt.endOfMonth('2028-02-10'), '2028-02-29'); // leap year
  assert.equal(fmt.diffDays('2026-01-01', '2026-12-31'), 364);
});

await test('amount entry accepts the ways people actually type', () => {
  assert.equal(fmt.parseAmount('1,234.50'), 1234.5);
  assert.equal(fmt.parseAmount('$40'), 40);
  assert.equal(fmt.parseAmount('(25)'), -25);
  assert.equal(fmt.parseAmount('12+3'), 15);
  assert.equal(fmt.parseAmount(''), 0);
  assert.equal(fmt.parseAmount('abc'), 0);
});

/* ------------------------------ parsers --------------------------- */

await test('CSV parser handles quotes, embedded commas and newlines', () => {
  const rows = parsers.parseCSV('Date,Description,Amount\n2026-01-02,"Shop, Downtown",-12.50\n2026-01-03,"He said ""hi""",5');
  assert.equal(rows.length, 3);
  assert.equal(rows[1][1], 'Shop, Downtown');
  assert.equal(rows[2][1], 'He said "hi"');
});

await test('CSV delimiter detection handles semicolons and tabs', () => {
  assert.equal(parsers.detectDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(parsers.detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
});

await test('date parsing covers the common bank formats', () => {
  assert.equal(parsers.parseDate('2026-03-07'), '2026-03-07');
  assert.equal(parsers.parseDate('20260307'), '2026-03-07');
  assert.equal(parsers.parseDate('03/07/2026', 'MDY'), '2026-03-07');
  assert.equal(parsers.parseDate('07/03/2026', 'DMY'), '2026-03-07');
  assert.equal(parsers.parseDate('07-Mar-2026'), '2026-03-07');
  assert.equal(parsers.parseDate('Mar 7, 2026'), '2026-03-07');
  assert.equal(parsers.parseDate('25/12/2026'), '2026-12-25'); // auto-detects DMY
});

await test('number parsing handles European and accounting formats', () => {
  assert.equal(parsers.parseNumber('1.234,56'), 1234.56);
  assert.equal(parsers.parseNumber('1,234.56'), 1234.56);
  assert.equal(parsers.parseNumber('(45.00)'), -45);
  assert.equal(parsers.parseNumber('-12.5'), -12.5);
  assert.equal(parsers.parseNumber('$1,200.00'), 1200);
  assert.equal(parsers.parseNumber(''), null);
});

await test('OFX parsing extracts transactions', () => {
  const ofx = `
    <OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><ACCTID>12345678</ACCTID><BANKTRANLIST>
    <STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260305120000<TRNAMT>-42.19<FITID>A1<NAME>KROGER #12<MEMO>groceries</STMTTRN>
    <STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260301<TRNAMT>2500.00<FITID>A2<NAME>PAYROLL</STMTTRN>
    </BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  const rows = parsers.parseOFX(ofx);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].date, '2026-03-05');
  near(rows[0].amount, -42.19);
  assert.equal(rows[0].payee, 'KROGER #12');
  assert.equal(rows[1].amount, 2500);
  assert.equal(parsers.ofxAccountHint(ofx), '12345678');
});

await test('QIF parsing extracts transactions', () => {
  const qif = '!Type:Bank\nD03/07/2026\nT-25.00\nPCoffee Shop\nMlatte\n^\nD03/08/2026\nT1000.00\nPPaycheck\n^\n';
  const rows = parsers.parseQIF(qif);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].date, '2026-03-07');
  near(rows[0].amount, -25);
  assert.equal(rows[1].payee, 'Paycheck');
});

await test('column guessing finds the usual header names', () => {
  const m = parsers.guessMapping(['Posted Date', 'Description', 'Debit', 'Credit', 'Balance']);
  assert.equal(m.date, 0);
  assert.equal(m.payee, 1);
  assert.equal(m.debit, 2);
  assert.equal(m.credit, 3);
});

await test('CSV round-trips through the writer', () => {
  const rows = [['a', 'b,c'], ['1', 'say "hi"']];
  assert.deepEqual(parsers.parseCSV(parsers.toCSV(rows)), rows);
});

/* ----------------------------- encryption ------------------------- */

await test('encrypt → decrypt round-trips the document', async () => {
  const doc = makeDoc();
  const env = await crypto.encryptJSON(doc, 'correct horse battery staple');
  assert.ok(crypto.isEncrypted(env));
  assert.ok(!JSON.stringify(env).includes('Checking'));
  const back = await crypto.decryptJSON(env, 'correct horse battery staple');
  assert.equal(back.accounts.length, doc.accounts.length);
  assert.equal(back.accounts[0].name, 'Checking');
});

await test('a wrong password is rejected, not silently wrong', async () => {
  const env = await crypto.encryptJSON({ accounts: [], transactions: [], categories: [] }, 'right');
  await assert.rejects(() => crypto.decryptJSON(env, 'wrong'), /BAD_PASSWORD/);
});

await test('every encryption uses a fresh salt and IV', async () => {
  const a = await crypto.encryptJSON({ x: 1 }, 'pw');
  const b = await crypto.encryptJSON({ x: 1 }, 'pw');
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
});

/* -------------------------------- store --------------------------- */

await test('store saves and reloads a document atomically', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-'));
  const store = new Store(dir, '1.0.0');
  await store.init();

  const first = await store.load(null);
  assert.equal(first.ok, true);
  assert.equal(first.created, true);

  first.doc.accounts.push({ id: 'a1', name: 'Test', type: 'checking', openingBalance: 10 });
  await store.save(first.doc);

  const store2 = new Store(dir, '1.0.0');
  await store2.init();
  const reloaded = await store2.load(null);
  assert.equal(reloaded.ok, true);
  assert.equal(reloaded.doc.accounts[0].name, 'Test');
  assert.ok(!fs.existsSync(path.join(dir, 'data.tmp.json')), 'temp file should be renamed away');
  fs.rmSync(dir, { recursive: true, force: true });
});

await test('store encrypts on disk once a password is set', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-'));
  const store = new Store(dir, '1.0.0');
  await store.init();
  const loaded = await store.load(null);
  loaded.doc.accounts.push({ id: 'a1', name: 'SecretAccount', type: 'checking', openingBalance: 1 });
  await store.save(loaded.doc);
  await store.setPassword('hunter2hunter2');

  const raw = fs.readFileSync(path.join(dir, 'data.json'), 'utf8');
  assert.ok(!raw.includes('SecretAccount'));

  const fresh = new Store(dir, '1.0.0');
  await fresh.init();
  assert.equal((await fresh.load(null)).error, 'PASSWORD_REQUIRED');
  assert.equal((await fresh.load('nope')).error, 'BAD_PASSWORD');
  const ok = await fresh.load('hunter2hunter2');
  assert.equal(ok.ok, true);
  assert.equal(ok.doc.accounts[0].name, 'SecretAccount');
  fs.rmSync(dir, { recursive: true, force: true });
});

await test('backup export and restore round-trip', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-'));
  const store = new Store(dir, '1.0.0');
  await store.init();
  const loaded = await store.load(null);
  loaded.doc.accounts.push({ id: 'a1', name: 'Backed up', type: 'savings', openingBalance: 99 });
  await store.save(loaded.doc);

  const env = await store.makeBackupEnvelope({ password: 'backup-password' });
  assert.equal(env.encrypted, true);
  assert.equal(env.counts.accounts, 1);
  const file = path.join(dir, 'test.finbak');
  fs.writeFileSync(file, JSON.stringify(env));

  assert.equal((await store.readBackupFile(file, null)).error, 'PASSWORD_REQUIRED');
  const read = await store.readBackupFile(file, 'backup-password');
  assert.equal(read.ok, true);
  assert.equal(read.doc.accounts[0].name, 'Backed up');

  // A plain (unencrypted) export must also be readable.
  const plain = await store.makeBackupEnvelope({ password: null });
  const file2 = path.join(dir, 'plain.finbak');
  fs.writeFileSync(file2, JSON.stringify(plain));
  assert.equal((await store.readBackupFile(file2, null)).ok, true);

  fs.rmSync(dir, { recursive: true, force: true });
});

await test('automatic backups are pruned to the keep count', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-'));
  const store = new Store(dir, '1.0.0');
  await store.init();
  await store.load(null);
  for (let i = 0; i < 6; i += 1) {
    fs.writeFileSync(path.join(dir, 'backups', `finfolio-2026010${i}-000000.finbak`), '{}');
  }
  await store.pruneBackups(3);
  const left = (await store.listBackups()).length;
  assert.equal(left, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

await test('a corrupt data file falls back to the previous good copy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-'));
  const store = new Store(dir, '1.0.0');
  await store.init();
  const loaded = await store.load(null);
  loaded.doc.accounts.push({ id: 'a1', name: 'Survivor', type: 'checking', openingBalance: 5 });
  await store.save(loaded.doc);
  await store.save(loaded.doc); // second save creates data.prev.json
  fs.writeFileSync(path.join(dir, 'data.json'), '{ this is not json');

  const fresh = new Store(dir, '1.0.0');
  await fresh.init();
  const res = await fresh.load(null);
  assert.equal(res.ok, true);
  assert.equal(res.doc.accounts[0].name, 'Survivor');
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------ schema ---------------------------- */

await test('migration fills in missing collections and settings', () => {
  const old = { schemaVersion: 1, accounts: [], transactions: [{ id: 't', type: 'expense', amount: 1, date: '2026-01-01' }], categories: [] };
  const doc = schema.migrate(old);
  assert.equal(doc.schemaVersion, schema.SCHEMA_VERSION);
  assert.ok(Array.isArray(doc.goals));
  assert.ok(Array.isArray(doc.transactions[0].tags));
  assert.ok(doc.categories.length > 0, 'seeds categories when empty');
  assert.equal(doc.settings.currency, 'USD');
});

await test('migration keeps user settings that already exist', () => {
  const doc = schema.migrate({ settings: { currency: 'GBP', theme: 'dark' }, accounts: [], transactions: [], categories: [{ id: 'c', name: 'X', kind: 'expense', group: 'G' }] });
  assert.equal(doc.settings.currency, 'GBP');
  assert.equal(doc.settings.theme, 'dark');
  assert.equal(doc.settings.autoBackup, true); // default filled in
});

await test('looksLikeDocument rejects junk', () => {
  assert.equal(schema.looksLikeDocument(null), false);
  assert.equal(schema.looksLikeDocument({ hello: 'world' }), false);
  assert.equal(schema.looksLikeDocument(schema.emptyDocument()), true);
});

/* -------------------------- merging two copies -------------------- */

const T0 = '2026-08-01T00:00:00.000Z';
const T1 = '2026-09-01T10:00:00.000Z';
const T2 = '2026-09-02T10:00:00.000Z';
const T3 = '2026-09-03T10:00:00.000Z';

// Two computers sharing a document share its history, so both sides start from
// the same base (same account and category ids) and differ only in what was
// edited afterwards. Seeding each side independently would make every category
// look like a new record and hide the behaviour under test.
const SYNC_BASE = (() => {
  const doc = schema.emptyDocument();
  doc.accounts = [{ id: 'acc1', name: 'Checking', type: 'checking', openingBalance: 0, updatedAt: T0 }];
  for (const c of doc.categories) c.updatedAt = T0;
  doc.meta.updatedAt = T0;
  return doc;
})();

function syncDoc(stamp, records = []) {
  const doc = JSON.parse(JSON.stringify(SYNC_BASE));
  doc.meta.updatedAt = stamp;
  doc.transactions = records;
  return doc;
}

await test('merge keeps records that only one computer has', () => {
  const mine = syncDoc(T1, [{ id: 'a', type: 'expense', date: '2026-09-01', amount: 10, accountId: 'acc1', updatedAt: T1 }]);
  const theirs = syncDoc(T1, [{ id: 'b', type: 'expense', date: '2026-09-01', amount: 20, accountId: 'acc1', updatedAt: T1 }]);
  const res = mergeDocuments(mine, theirs);
  assert.equal(res.ok, true);
  const ids = res.doc.transactions.map((t) => t.id).sort();
  assert.deepEqual(ids, ['a', 'b']);
  assert.equal(res.stats.totalAdded, 1);
});

await test('merge is symmetric for records only one side has', () => {
  const mine = syncDoc(T1, [{ id: 'a', type: 'expense', date: '2026-09-01', amount: 10, accountId: 'acc1', updatedAt: T1 }]);
  const theirs = syncDoc(T1, [{ id: 'b', type: 'expense', date: '2026-09-01', amount: 20, accountId: 'acc1', updatedAt: T1 }]);
  const one = mergeDocuments(mine, theirs).doc.transactions.map((t) => t.id).sort();
  const two = mergeDocuments(theirs, mine).doc.transactions.map((t) => t.id).sort();
  assert.deepEqual(one, two);
});

await test('merge keeps the newer edit when both sides changed a record', () => {
  const mine = syncDoc(T2, [{ id: 'a', type: 'expense', date: '2026-09-01', amount: 10, payee: 'mine', accountId: 'acc1', updatedAt: T2 }]);
  const theirs = syncDoc(T3, [{ id: 'a', type: 'expense', date: '2026-09-01', amount: 99, payee: 'theirs', accountId: 'acc1', updatedAt: T3 }]);
  const res = mergeDocuments(mine, theirs);
  assert.equal(res.doc.transactions[0].payee, 'theirs');
  assert.equal(res.stats.totalUpdated, 1);

  const other = mergeDocuments(theirs, mine);
  assert.equal(other.doc.transactions[0].payee, 'theirs', 'the newer edit wins whichever side it is on');
});

await test('merge does not resurrect a record deleted on the other computer', () => {
  const mine = syncDoc(T2, []);
  mine.tombstones = [{ id: 'a', collection: 'transactions', at: T2 }];
  const theirs = syncDoc(T1, [{ id: 'a', type: 'expense', date: '2026-09-01', amount: 10, accountId: 'acc1', updatedAt: T1 }]);
  const res = mergeDocuments(mine, theirs);
  assert.equal(res.doc.transactions.length, 0, 'the deletion sticks');
});

await test('an edit made after a deletion brings the record back', () => {
  const mine = syncDoc(T2, []);
  mine.tombstones = [{ id: 'a', collection: 'transactions', at: T1 }];
  const theirs = syncDoc(T3, [{ id: 'a', type: 'expense', date: '2026-09-01', amount: 10, accountId: 'acc1', updatedAt: T3 }]);
  const res = mergeDocuments(mine, theirs);
  assert.equal(res.doc.transactions.length, 1, 'the later edit wins over the earlier deletion');
});

await test('a deletion on the other computer removes the local record', () => {
  const mine = syncDoc(T1, [{ id: 'a', type: 'expense', date: '2026-09-01', amount: 10, accountId: 'acc1', updatedAt: T1 }]);
  const theirs = syncDoc(T2, []);
  theirs.tombstones = [{ id: 'a', collection: 'transactions', at: T2 }];
  const res = mergeDocuments(mine, theirs);
  assert.equal(res.doc.transactions.length, 0);
  assert.equal(res.stats.totalRemoved, 1);
});

await test('tombstones survive the merge so a third computer honours them too', () => {
  const mine = syncDoc(T2, []);
  mine.tombstones = [{ id: 'a', collection: 'transactions', at: T2 }];
  const theirs = syncDoc(T1, [{ id: 'a', type: 'expense', date: '2026-09-01', amount: 10, accountId: 'acc1', updatedAt: T1 }]);
  const merged = mergeDocuments(mine, theirs).doc;
  assert.ok(merged.tombstones.some((t) => t.id === 'a'));
  // Feeding the merged result back in must not re-add it either.
  const again = mergeDocuments(merged, theirs).doc;
  assert.equal(again.transactions.length, 0);
});

await test('merging the same pair twice changes nothing the second time', () => {
  const mine = syncDoc(T1, [{ id: 'a', type: 'expense', date: '2026-09-01', amount: 10, accountId: 'acc1', updatedAt: T1 }]);
  const theirs = syncDoc(T1, [{ id: 'b', type: 'expense', date: '2026-09-01', amount: 20, accountId: 'acc1', updatedAt: T1 }]);
  const once = mergeDocuments(mine, theirs).doc;
  const twice = mergeDocuments(once, theirs);
  assert.equal(twice.stats.totalAdded, 0);
  assert.equal(twice.doc.transactions.length, 2);
});

await test('machine-local settings are never carried across', () => {
  const mine = syncDoc(T1);
  mine.settings.theme = 'dark';
  mine.settings.accent = 'rose';
  mine.settings.currency = 'USD';
  const theirs = syncDoc(T3);
  theirs.settings.theme = 'light';
  theirs.settings.accent = 'teal';
  theirs.settings.currency = 'GBP';
  const res = mergeDocuments(mine, theirs);
  assert.equal(res.doc.settings.theme, 'dark', 'theme stays local');
  assert.equal(res.doc.settings.accent, 'rose', 'accent stays local');
  assert.equal(res.doc.settings.currency, 'GBP', 'currency follows the newer document');
});

await test('older settings do not overwrite newer ones', () => {
  const mine = syncDoc(T3);
  mine.settings.currency = 'USD';
  const theirs = syncDoc(T1);
  theirs.settings.currency = 'EUR';
  assert.equal(mergeDocuments(mine, theirs).doc.settings.currency, 'USD');
});

await test('payees are combined and de-duplicated', () => {
  const mine = syncDoc(T1);
  mine.payees = ['Kroger', 'Shell'];
  const theirs = syncDoc(T1);
  theirs.payees = ['Shell', 'Aldi'];
  assert.deepEqual(mergeDocuments(mine, theirs).doc.payees, ['Aldi', 'Kroger', 'Shell']);
});

await test('every mergeable collection is covered, not just transactions', () => {
  const mine = syncDoc(T1);
  const theirs = syncDoc(T1);
  theirs.goals = [{ id: 'g1', name: 'Trip', targetAmount: 100, updatedAt: T1 }];
  theirs.recurring = [{ id: 'r1', name: 'Rent', amount: 10, accountId: 'acc1', frequency: 'monthly', startDate: '2026-09-01', updatedAt: T1 }];
  theirs.budgets = [{ id: 'b1', categoryId: 'c', month: '2026-09', amount: 50, updatedAt: T1 }];
  theirs.rules = [{ id: 'ru1', field: 'payee', op: 'contains', value: 'x', updatedAt: T1 }];
  const res = mergeDocuments(mine, theirs).doc;
  assert.equal(res.goals.length, 1);
  assert.equal(res.recurring.length, 1);
  assert.equal(res.budgets.length, 1);
  assert.equal(res.rules.length, 1);
});

await test('records without a timestamp fall back to the document timestamp', () => {
  const mine = syncDoc(T1, [{ id: 'a', type: 'expense', date: '2026-09-01', amount: 10, payee: 'old', accountId: 'acc1' }]);
  const theirs = syncDoc(T3, [{ id: 'a', type: 'expense', date: '2026-09-01', amount: 10, payee: 'new', accountId: 'acc1' }]);
  assert.equal(mergeDocuments(mine, theirs).doc.transactions[0].payee, 'new');
});

await test('merge refuses anything that is not a document', () => {
  assert.equal(mergeDocuments(null, syncDoc(T1)).ok, false);
  assert.equal(mergeDocuments(syncDoc(T1), { nope: true }).ok, false);
});

await test('merge does not mutate either input', () => {
  const mine = syncDoc(T1, [{ id: 'a', type: 'expense', date: '2026-09-01', amount: 10, accountId: 'acc1', updatedAt: T1 }]);
  const theirs = syncDoc(T1, [{ id: 'b', type: 'expense', date: '2026-09-01', amount: 20, accountId: 'acc1', updatedAt: T1 }]);
  mergeDocuments(mine, theirs);
  assert.equal(mine.transactions.length, 1);
  assert.equal(theirs.transactions.length, 1);
});

await test('two independently set-up computers do not end up with duplicate categories', () => {
  // Each side seeded its own categories, so "Groceries" has a different id on
  // each. They should still merge into one category, not two.
  const mine = schema.emptyDocument();
  mine.meta.updatedAt = T1;
  mine.accounts = [{ id: 'acc1', name: 'Checking', type: 'checking', openingBalance: 0, updatedAt: T1 }];
  const theirs = schema.emptyDocument();
  theirs.meta.updatedAt = T2;
  theirs.accounts = [{ id: 'acc1', name: 'Checking', type: 'checking', openingBalance: 0, updatedAt: T1 }];

  const theirGroceries = theirs.categories.find((c) => c.name === 'Groceries').id;
  const myGroceries = mine.categories.find((c) => c.name === 'Groceries').id;
  assert.notEqual(theirGroceries, myGroceries, 'the fixture really does have different ids');

  theirs.transactions = [
    { id: 'tx1', type: 'expense', date: '2026-09-01', amount: 40, accountId: 'acc1', categoryId: theirGroceries, updatedAt: T2 },
  ];

  const res = mergeDocuments(mine, theirs);
  assert.equal(res.ok, true);
  const groceries = res.doc.categories.filter((c) => c.name === 'Groceries');
  assert.equal(groceries.length, 1, 'Groceries is not duplicated');
  assert.equal(res.doc.categories.length, mine.categories.length, 'no category is duplicated');
  assert.equal(
    res.doc.transactions[0].categoryId,
    myGroceries,
    'the imported transaction points at the surviving category'
  );
});

await test('category matching also fixes splits, budgets, bills and rules', () => {
  const mine = schema.emptyDocument();
  mine.meta.updatedAt = T1;
  const theirs = schema.emptyDocument();
  theirs.meta.updatedAt = T2;
  const theirFuel = theirs.categories.find((c) => c.name === 'Fuel').id;
  const myFuel = mine.categories.find((c) => c.name === 'Fuel').id;

  theirs.transactions = [
    {
      id: 'tx1', type: 'expense', date: '2026-09-01', amount: 40, accountId: 'acc1', updatedAt: T2,
      splits: [{ categoryId: theirFuel, amount: 40 }],
    },
  ];
  theirs.budgets = [{ id: 'b1', categoryId: theirFuel, month: '2026-09', amount: 100, updatedAt: T2 }];
  theirs.recurring = [{ id: 'r1', name: 'Gas', categoryId: theirFuel, amount: 50, accountId: 'acc1', frequency: 'monthly', startDate: '2026-09-01', updatedAt: T2 }];
  theirs.rules = [{ id: 'ru1', field: 'payee', op: 'contains', value: 'shell', categoryId: theirFuel, updatedAt: T2 }];

  const res = mergeDocuments(mine, theirs).doc;
  assert.equal(res.transactions[0].splits[0].categoryId, myFuel);
  assert.equal(res.budgets[0].categoryId, myFuel);
  assert.equal(res.recurring[0].categoryId, myFuel);
  assert.equal(res.rules[0].categoryId, myFuel);
});

await test('accounts with the same name are NOT combined', () => {
  // Two separately created "Checking" accounts may hold different money;
  // merging them would corrupt the balances, so both survive.
  const mine = syncDoc(T1);
  mine.accounts = [{ id: 'mine-chk', name: 'Checking', type: 'checking', openingBalance: 100, updatedAt: T1 }];
  const theirs = syncDoc(T1);
  theirs.accounts = [{ id: 'their-chk', name: 'Checking', type: 'checking', openingBalance: 250, updatedAt: T1 }];
  const res = mergeDocuments(mine, theirs).doc;
  assert.equal(res.accounts.length, 2);
});

/* ------------------------ sync-aware persistence ------------------ */

await test('a save is refused when another computer changed the file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-sync-'));
  const store = new Store(dir, '1.0.0');
  await store.init();
  const loaded = await store.load(null);

  // Simulate the other computer writing the shared file.
  await new Promise((r) => setTimeout(r, 12));
  const other = schema.emptyDocument();
  other.accounts.push({ id: 'x', name: 'From the other PC', type: 'checking', openingBalance: 5 });
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(other));

  loaded.doc.accounts.push({ id: 'y', name: 'Mine', type: 'checking', openingBalance: 1 });
  const refused = await store.save(loaded.doc);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'CONFLICT');

  // The other computer's file is untouched.
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'));
  assert.equal(onDisk.accounts[0].name, 'From the other PC');
  fs.rmSync(dir, { recursive: true, force: true });
});

await test('a forced save wins after the user chooses', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-sync-'));
  const store = new Store(dir, '1.0.0');
  await store.init();
  const loaded = await store.load(null);
  await new Promise((r) => setTimeout(r, 12));
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(schema.emptyDocument()));

  loaded.doc.accounts.push({ id: 'y', name: 'Mine', type: 'checking', openingBalance: 1 });
  const forced = await store.save(loaded.doc, { force: true });
  assert.equal(forced.ok, true);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'));
  assert.equal(onDisk.accounts[0].name, 'Mine');
  fs.rmSync(dir, { recursive: true, force: true });
});

await test('normal saves keep working when nothing else touches the file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-sync-'));
  const store = new Store(dir, '1.0.0');
  await store.init();
  const loaded = await store.load(null);
  for (let i = 0; i < 4; i += 1) {
    loaded.doc.accounts.push({ id: `a${i}`, name: `Account ${i}`, type: 'checking', openingBalance: i });
    const res = await store.save(loaded.doc);
    assert.equal(res.ok, true, `save ${i} should not report a conflict`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

await test('peek reads the file without disturbing what is in memory', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-sync-'));
  const store = new Store(dir, '1.0.0');
  await store.init();
  const loaded = await store.load(null);
  loaded.doc.accounts.push({ id: 'mine', name: 'In memory', type: 'checking', openingBalance: 1 });

  const other = schema.emptyDocument();
  other.accounts.push({ id: 'theirs', name: 'On disk', type: 'checking', openingBalance: 2 });
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(other));

  const peeked = await store.peek();
  assert.equal(peeked.ok, true);
  assert.equal(peeked.doc.accounts[0].name, 'On disk');
  assert.equal(store.doc.accounts[0].name, 'In memory', 'memory is untouched');
  fs.rmSync(dir, { recursive: true, force: true });
});

await test('peek decrypts with the password already held in memory', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-sync-'));
  const store = new Store(dir, '1.0.0');
  await store.init();
  const loaded = await store.load(null);
  loaded.doc.accounts.push({ id: 'a', name: 'Secret', type: 'checking', openingBalance: 1 });
  await store.save(loaded.doc);
  await store.setPassword('shared-password');

  const peeked = await store.peek();
  assert.equal(peeked.ok, true);
  assert.equal(peeked.doc.accounts[0].name, 'Secret');
  fs.rmSync(dir, { recursive: true, force: true });
});

/* --------------------------- data location ------------------------ */

await test('the data folder can be moved and the pointer persists', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-home-'));
  const cloud = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-cloud-'));
  const store = new Store(home, '1.0.0');
  await store.init();
  const loaded = await store.load(null);
  loaded.doc.accounts.push({ id: 'a', name: 'Travelling', type: 'checking', openingBalance: 7 });
  await store.save(loaded.doc);

  const moved = await store.setLocation(cloud, 'move');
  assert.equal(moved.ok, true);
  assert.ok(fs.existsSync(path.join(cloud, 'data.json')), 'data file is in the new folder');
  assert.ok(!fs.existsSync(path.join(home, 'data.json')), 'the old live file is renamed away');
  assert.ok(fs.readdirSync(home).some((f) => f.startsWith('data.moved-')), 'the old copy is kept, clearly superseded');

  // A fresh session follows the pointer.
  const reopened = new Store(home, '1.0.0');
  const init = await reopened.init();
  assert.equal(path.resolve(init.dataDir), path.resolve(cloud));
  const back = await reopened.load(null);
  assert.equal(back.doc.accounts[0].name, 'Travelling');

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cloud, { recursive: true, force: true });
});

await test('a second computer can adopt the data already in the folder', async () => {
  const cloud = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-cloud-'));
  const pcOne = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-pc1-'));
  const pcTwo = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-pc2-'));

  const one = new Store(pcOne, '1.0.0');
  await one.init();
  const docOne = (await one.load(null)).doc;
  docOne.accounts.push({ id: 'shared', name: 'Household', type: 'checking', openingBalance: 100 });
  await one.save(docOne);
  await one.setLocation(cloud, 'move');

  const two = new Store(pcTwo, '1.0.0');
  await two.init();
  const docTwo = (await two.load(null)).doc;
  docTwo.accounts.push({ id: 'local', name: 'Only on PC 2', type: 'savings', openingBalance: 5 });
  await two.save(docTwo);

  const inspected = await two.inspectLocation(cloud);
  assert.equal(inspected.ok, true);
  assert.ok(inspected.existing, 'the existing file is reported so the user can be asked');
  assert.equal(inspected.existing.counts.accounts, 1);

  const adopted = await two.setLocation(cloud, 'adopt');
  assert.equal(adopted.ok, true);
  assert.equal(adopted.doc.accounts[0].name, 'Household', 'PC 2 now sees the shared data');
  assert.ok(!fs.existsSync(path.join(cloud, 'data.replaced-')), 'nothing was clobbered');

  for (const d of [cloud, pcOne, pcTwo]) fs.rmSync(d, { recursive: true, force: true });
});

await test('replacing an existing file in the target folder keeps a copy of it', async () => {
  const cloud = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-cloud-'));
  const pc = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-pc-'));
  fs.writeFileSync(path.join(cloud, 'data.json'), JSON.stringify(schema.emptyDocument()));

  const store = new Store(pc, '1.0.0');
  await store.init();
  const doc = (await store.load(null)).doc;
  doc.accounts.push({ id: 'a', name: 'Mine', type: 'checking', openingBalance: 1 });
  await store.save(doc);

  const res = await store.setLocation(cloud, 'move');
  assert.equal(res.ok, true);
  assert.ok(
    fs.readdirSync(cloud).some((f) => f.startsWith('data.replaced-')),
    'the file that was there is preserved under a new name'
  );
  assert.equal((await store.load(null)).doc.accounts[0].name, 'Mine');

  fs.rmSync(cloud, { recursive: true, force: true });
  fs.rmSync(pc, { recursive: true, force: true });
});

await test('an unwritable or missing folder is refused', async () => {
  const pc = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-pc-'));
  const store = new Store(pc, '1.0.0');
  await store.init();
  await store.load(null);
  const res = await store.inspectLocation(path.join(pc, 'nope', 'missing'));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'MISSING', 'a folder that is not there is reported as missing, not unwritable');
  assert.equal((await store.inspectLocation(store.dir)).error, 'SAME_FOLDER');
  fs.rmSync(pc, { recursive: true, force: true });
});

await test('migration adds tombstones and stamps existing records', () => {
  const old = {
    schemaVersion: 3,
    meta: { updatedAt: T1 },
    accounts: [{ id: 'a', name: 'A', type: 'checking' }],
    transactions: [{ id: 't', type: 'expense', amount: 1, date: '2026-01-01' }],
    categories: [{ id: 'c', name: 'C', kind: 'expense', group: 'G' }],
  };
  const doc = schema.migrate(old);
  assert.ok(Array.isArray(doc.tombstones));
  assert.equal(doc.transactions[0].updatedAt, T1, 'existing records get a timestamp so merges can order them');
  assert.equal(doc.accounts[0].updatedAt, T1);
});

/* ---------------- card payments as scheduled bills ---------------- */

function cardDoc({ owed = 2000, limit = 6000, minPct = 2, floor = 25, dueDay = 28 } = {}) {
  const doc = schema.emptyDocument();
  doc.accounts = [
    { id: 'chk', name: 'Checking', type: 'checking', openingBalance: 5000, openingDate: '2026-01-01' },
    {
      id: 'visa', name: 'Visa', type: 'credit', openingBalance: -owed, openingDate: '2026-01-01',
      creditLimit: limit, apr: 21, minPaymentPct: minPct, minPaymentFloor: floor, dueDay,
    },
    {
      id: 'car', name: 'Car loan', type: 'loan', openingBalance: -12000, openingDate: '2026-01-01',
      interestRate: 6, paymentAmount: 350,
    },
  ];
  return doc;
}

await test('a card payment reminder is built from the account', () => {
  const doc = cardDoc({ owed: 2000, dueDay: 28 });
  const rule = finance.buildPaymentRule(doc, doc.accounts[1]);
  assert.equal(rule.kind, 'transfer', 'paying a card moves money between accounts');
  assert.equal(rule.transferAccountId, 'visa');
  assert.equal(rule.linkedAccountId, 'visa');
  assert.equal(rule.accountId, 'chk', 'it defaults to paying from checking');
  assert.equal(rule.amountSource, finance.AMOUNT_SOURCES.CARD_MINIMUM);
  assert.equal(rule.dayOfMonth, 28);
  assert.equal(rule.frequency, 'monthly');
  assert.equal(fmt.dt(rule.startDate) >= fmt.dt(fmt.today()), true, 'it starts on the next due date, not in the past');
});

await test('a loan payment reminder uses the loan’s own payment amount', () => {
  const doc = cardDoc();
  const rule = finance.buildPaymentRule(doc, doc.accounts[2]);
  assert.equal(rule.amountSource, finance.AMOUNT_SOURCES.LOAN_PAYMENT);
  near(finance.resolveRuleAmount(doc, rule).amount, 350);
});

await test('a card bill’s amount follows the balance', () => {
  const doc = cardDoc({ owed: 2000, minPct: 2, floor: 25 });
  doc.recurring = [finance.buildPaymentRule(doc, doc.accounts[1])];
  near(finance.resolveRuleAmount(doc, doc.recurring[0]).amount, 40); // 2% of 2000

  // Spend more on the card; the bill goes up without anyone editing it.
  doc.transactions.push({
    id: 't1', type: 'expense', date: fmt.today(), amount: 1000, accountId: 'visa', updatedAt: fmt.today(),
  });
  near(finance.resolveRuleAmount(doc, doc.recurring[0]).amount, 60); // 2% of 3000
});

await test('the minimum never drops below the floor', () => {
  const doc = cardDoc({ owed: 300, minPct: 2, floor: 25 });
  doc.recurring = [finance.buildPaymentRule(doc, doc.accounts[1])];
  near(finance.resolveRuleAmount(doc, doc.recurring[0]).amount, 25); // 2% of 300 is 6
});

await test('a paid-off card asks for nothing', () => {
  const doc = cardDoc({ owed: 0 });
  doc.recurring = [finance.buildPaymentRule(doc, doc.accounts[1])];
  const resolved = finance.resolveRuleAmount(doc, doc.recurring[0]);
  assert.equal(resolved.amount, 0);
  assert.match(resolved.note, /Nothing owed/);
});

await test('a pay-in-full card bill asks for the whole balance', () => {
  const doc = cardDoc({ owed: 1234.56 });
  const rule = { ...finance.buildPaymentRule(doc, doc.accounts[1]), amountSource: finance.AMOUNT_SOURCES.CARD_FULL };
  near(finance.resolveRuleAmount(doc, rule).amount, 1234.56);
});

await test('a fixed amount is still honoured', () => {
  const doc = cardDoc({ owed: 2000 });
  const rule = { ...finance.buildPaymentRule(doc, doc.accounts[1]), amountSource: 'fixed', amount: 150 };
  const resolved = finance.resolveRuleAmount(doc, rule);
  near(resolved.amount, 150);
  assert.equal(resolved.estimated, false, 'a typed amount is not an estimate');
});

await test('card payments appear in the upcoming list with their live amount', () => {
  const doc = cardDoc({ owed: 2000, dueDay: fmt.dt(fmt.addDays(fmt.today(), 5)).getDate() });
  doc.recurring = [finance.buildPaymentRule(doc, doc.accounts[1])];
  const items = finance.upcomingItems(doc, { days: 40 });
  const card = items.find((i) => i.rule.linkedAccountId === 'visa');
  assert.ok(card, 'the card payment is listed as a bill');
  near(card.amount, 40);
  assert.equal(card.estimated, true, 'and is marked as an estimate');
  assert.match(card.note, /Minimum/);
});

await test('card payments reduce the forecast balance on their due date', () => {
  const dueDay = fmt.dt(fmt.addDays(fmt.today(), 3)).getDate();
  const doc = cardDoc({ owed: 2000, dueDay });
  doc.recurring = [finance.buildPaymentRule(doc, doc.accounts[1])];
  const fc = finance.forecast(doc, { days: 20 });
  near(fc.start, 5000);
  near(fc.series[20].balance, 4960, 0.05); // 5000 − 40 minimum
});

await test('a paid-off card does not clutter the forecast', () => {
  const doc = cardDoc({ owed: 0, dueDay: fmt.dt(fmt.addDays(fmt.today(), 3)).getDate() });
  doc.recurring = [finance.buildPaymentRule(doc, doc.accounts[1])];
  const fc = finance.forecast(doc, { days: 20 });
  near(fc.series[20].balance, 5000);
});

await test('card and loan payments count as debt, not as bills', () => {
  const doc = cardDoc({ owed: 2000 });
  doc.recurring = [
    finance.buildPaymentRule(doc, doc.accounts[1]),
    finance.buildPaymentRule(doc, doc.accounts[2]),
    { id: 'r3', name: 'Power', kind: 'bill', amount: 120, accountId: 'chk', frequency: 'monthly', startDate: fmt.today(), active: true },
  ];
  const load = finance.monthlyRecurringLoad(doc);
  near(load.bills, 120);
  near(load.debt, 390); // 40 card minimum + 350 loan payment
  near(load.net, -510);
});

await test('accounts without a reminder are reported so they can be offered', () => {
  const doc = cardDoc();
  assert.equal(finance.accountsMissingPaymentReminder(doc).length, 2, 'the card and the loan');
  doc.recurring = [finance.buildPaymentRule(doc, doc.accounts[1])];
  const still = finance.accountsMissingPaymentReminder(doc);
  assert.equal(still.length, 1);
  assert.equal(still[0].id, 'car');
  assert.equal(finance.paymentRuleFor(doc, 'visa').linkedAccountId, 'visa');
});

await test('recording a card payment stops the bill showing again that month', () => {
  const dueDay = fmt.dt(fmt.addDays(fmt.today(), 4)).getDate();
  const doc = cardDoc({ owed: 2000, dueDay });
  const rule = finance.buildPaymentRule(doc, doc.accounts[1]);
  doc.recurring = [rule];
  // A 10-day window holds exactly one occurrence of a monthly bill.
  assert.equal(finance.upcomingItems(doc, { days: 10 }).length, 1);

  doc.transactions.push({
    id: 'pay1', type: 'transfer', date: rule.startDate, amount: 40,
    accountId: 'chk', transferAccountId: 'visa', recurringId: rule.id, updatedAt: fmt.today(),
  });
  const after = finance.upcomingItems(doc, { days: 10 });
  assert.equal(after.length, 0, 'the recorded payment clears the reminder');
});

await test('a reminder with a missing account falls back to its stored amount', () => {
  const doc = cardDoc();
  const rule = { ...finance.buildPaymentRule(doc, doc.accounts[1]), linkedAccountId: 'gone', transferAccountId: 'gone', amount: 77 };
  near(finance.resolveRuleAmount(doc, rule).amount, 77);
});

/* --------------------- finding cloud folders ---------------------- */

const { detectCloudFolders } = require('../src/main/cloud-folders.js');

// Windows fixtures must be built with Windows path rules, or the module (which
// correctly uses them) and the test disagree about what the same folder is.
const w = path.win32;
function fakeFs(paths) {
  const set = new Set(paths.map((p) => w.resolve(p).toLowerCase()));
  return async (dir) => set.has(w.resolve(dir).toLowerCase());
}

await test('a work OneDrive is found through the Windows environment variable', async () => {
  const home = 'C:\\Users\\sbreland.HCSD';
  const work = 'C:\\Users\\sbreland.HCSD\\OneDrive - Hancock County Schools';
  const found = await detectCloudFolders({
    home,
    platform: 'win32',
    env: { OneDriveCommercial: work, OneDrive: work },
    exists: fakeFs([work]),
    readJsonFile: async () => null,
    driveLetters: [],
  });
  assert.equal(found.length, 1, 'the same folder is not offered twice');
  assert.equal(found[0].root, work);
  assert.ok(found[0].label.includes('Hancock'), `label should name the organisation, got "${found[0].label}"`);
});

await test('the suggested folder is a subfolder that does not have to exist yet', async () => {
  const home = '/home/spencer';
  const drive = '/home/spencer/OneDrive';
  const found = await detectCloudFolders({
    home,
    platform: 'win32',
    env: { OneDrive: drive },
    exists: fakeFs([drive]),
    readJsonFile: async () => null,
    driveLetters: [],
  });
  assert.equal(found[0].suggested, w.join(drive, 'FinFolio'));
});

await test('Google Drive for Desktop is found on its virtual drive letter', async () => {
  // This is the case the first attempt missed entirely: modern Google Drive is
  // G:\My Drive, not a folder in the user profile.
  const found = await detectCloudFolders({
    home: 'C:\\Users\\spencer',
    platform: 'win32',
    env: {},
    exists: fakeFs(['G:\\My Drive']),
    readJsonFile: async () => null,
    driveLetters: ['G', 'H'],
  });
  assert.equal(found.length, 1);
  assert.ok(found[0].label.startsWith('Google Drive'), found[0].label);
  assert.equal(found[0].root, 'G:\\My Drive');
});

await test('the older Google Drive layout in the user profile is still found', async () => {
  const home = 'C:\\Users\\spencer';
  const found = await detectCloudFolders({
    home,
    platform: 'win32',
    env: {},
    exists: fakeFs([w.join(home, 'Google Drive')]),
    readJsonFile: async () => null,
    driveLetters: [],
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].root, w.join(home, 'Google Drive'));
});

await test('Dropbox is read from its own info file, which knows about moved folders', async () => {
  const moved = 'D:\\Cloud\\Dropbox';
  const found = await detectCloudFolders({
    home: 'C:\\Users\\spencer',
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\spencer\\AppData\\Local' },
    exists: fakeFs([moved]),
    readJsonFile: async (file) =>
      file.includes('Dropbox') ? { personal: { path: moved } } : null,
    driveLetters: [],
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].root, moved);
});

await test('nothing is offered when no cloud client is installed', async () => {
  const found = await detectCloudFolders({
    home: 'C:\\Users\\spencer',
    platform: 'win32',
    env: {},
    exists: async () => false,
    readJsonFile: async () => null,
    driveLetters: ['G'],
  });
  assert.deepEqual(found, []);
});

await test('several providers are all offered, without duplicates', async () => {
  const home = 'C:\\Users\\spencer';
  const one = w.join(home, 'OneDrive');
  const drop = w.join(home, 'Dropbox');
  const found = await detectCloudFolders({
    home,
    platform: 'win32',
    env: { OneDrive: one, OneDriveConsumer: one },
    exists: fakeFs([one, drop, 'G:\\My Drive']),
    readJsonFile: async () => null,
    driveLetters: ['G'],
  });
  assert.equal(found.length, 3, found.map((f) => f.root).join(', '));
});

/* -------------------- folders and cloud backups ------------------- */

await test('a folder that does not exist yet is created on request', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-folder-'));
  const store = new Store(base, '1.0.0');
  await store.init();
  const target = path.join(base, 'cloud', 'FinFolio');

  assert.equal((await store.ensureWritableFolder(target)).error, 'MISSING', 'refused without permission to create');
  const made = await store.ensureWritableFolder(target, { create: true });
  assert.equal(made.ok, true);
  assert.ok(fs.existsSync(target), 'the folder now exists');
  assert.equal(fs.readdirSync(target).length, 0, 'the write probe cleans up after itself');
  fs.rmSync(base, { recursive: true, force: true });
});

await test('a path that is a file, not a folder, is refused', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-folder-'));
  const store = new Store(base, '1.0.0');
  await store.init();
  const file = path.join(base, 'not-a-folder.txt');
  fs.writeFileSync(file, 'hello');
  assert.equal((await store.ensureWritableFolder(file, { create: true })).error, 'NOT_A_FOLDER');
  fs.rmSync(base, { recursive: true, force: true });
});

await test('choosing a suggested cloud folder works end to end', async () => {
  // The exact flow that failed: a suggested "<OneDrive>\FinFolio" subfolder
  // that has never existed is created rather than reported as unavailable.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-folder-'));
  const oneDrive = path.join(base, 'OneDrive');
  fs.mkdirSync(oneDrive);
  const store = new Store(path.join(base, 'appdata'), '1.0.0');
  await store.init();
  const doc = (await store.load(null)).doc;
  doc.accounts.push({ id: 'a', name: 'Checking', type: 'checking', openingBalance: 12 });
  await store.save(doc);

  const suggested = path.join(oneDrive, 'FinFolio');
  const moved = await store.setLocation(suggested, 'move');
  assert.equal(moved.ok, true, `expected success, got ${moved.error}`);
  assert.ok(fs.existsSync(path.join(suggested, 'data.json')));
  assert.equal(moved.doc.accounts[0].name, 'Checking');
  fs.rmSync(base, { recursive: true, force: true });
});

await test('automatic backups are copied to the cloud folder', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-mirror-'));
  const cloud = path.join(base, 'GoogleDrive', 'FinFolio Backups');
  const store = new Store(path.join(base, 'appdata'), '1.0.0');
  await store.init();
  const doc = (await store.load(null)).doc;
  doc.settings.backupMirrorDir = cloud;
  await store.save(doc);

  const res = await store.autoBackup(5);
  assert.equal(res.ok, true);
  assert.ok(res.mirror && res.mirror.ok, 'the copy succeeded');
  assert.ok(fs.existsSync(res.mirror.file), 'the copy is on disk');
  assert.equal(
    path.basename(res.mirror.file),
    path.basename(res.file),
    'the copy keeps the same name as the local backup'
  );
  fs.rmSync(base, { recursive: true, force: true });
});

await test('an unreachable cloud folder never breaks the local backup', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-mirror-'));
  const blocker = path.join(base, 'blocker');
  fs.writeFileSync(blocker, 'a file where a folder should be');
  const store = new Store(path.join(base, 'appdata'), '1.0.0');
  await store.init();
  const doc = (await store.load(null)).doc;
  doc.settings.backupMirrorDir = path.join(blocker, 'Backups');
  await store.save(doc);

  const res = await store.autoBackup(5);
  assert.equal(res.ok, true, 'the backup itself still succeeds');
  assert.ok(fs.existsSync(res.file), 'the local backup is on disk');
  assert.equal(res.mirror.ok, false, 'and the failure is reported, not thrown');
  fs.rmSync(base, { recursive: true, force: true });
});

await test('turning cloud copies on brings the existing backups across', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-mirror-'));
  const cloud = path.join(base, 'cloud');
  const store = new Store(path.join(base, 'appdata'), '1.0.0');
  await store.init();
  const doc = (await store.load(null)).doc;
  await store.save(doc);

  for (let i = 0; i < 3; i += 1) {
    await store.autoBackup(10);
    await new Promise((r) => setTimeout(r, 1100)); // names are second-resolution
  }
  assert.equal((await store.listBackups()).length, 3);

  doc.settings.backupMirrorDir = cloud;
  await store.save(doc);
  const synced = await store.syncMirror(10);
  assert.equal(synced.ok, true);
  assert.equal(synced.copied, 3, 'all three are copied');

  const again = await store.syncMirror(10);
  assert.equal(again.copied, 0, 'copying twice does not duplicate');

  const status = await store.mirrorStatus();
  assert.equal(status.configured, true);
  assert.equal(status.reachable, true);
  assert.equal(status.count, 3);
  fs.rmSync(base, { recursive: true, force: true });
});

await test('the cloud folder is pruned to the same depth as the local one', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-mirror-'));
  const cloud = path.join(base, 'cloud');
  fs.mkdirSync(cloud, { recursive: true });
  for (let i = 0; i < 6; i += 1) {
    fs.writeFileSync(path.join(cloud, `finfolio-2026010${i}-000000.finbak`), '{}');
  }
  const store = new Store(path.join(base, 'appdata'), '1.0.0');
  await store.init();
  await store.pruneFolder(cloud, 2);
  assert.equal((await store.listFolder(cloud)).length, 2);
  fs.rmSync(base, { recursive: true, force: true });
});

await test('the cloud backup folder is not carried to other computers', () => {
  // It is a path that only means something on the machine that set it.
  const mine = syncDoc(T1);
  mine.settings.backupMirrorDir = 'C:\\Users\\spencer\\GoogleDrive';
  const theirs = syncDoc(T3);
  theirs.settings.backupMirrorDir = 'D:\\SomewhereElse';
  const merged = mergeDocuments(mine, theirs).doc;
  assert.equal(merged.settings.backupMirrorDir, 'C:\\Users\\spencer\\GoogleDrive');
});

/* ------------------- the build's own prerequisites ----------------- */

await test('check.js strips a byte-order mark from package.json', () => {
  // electron-builder parses package.json itself, and a BOM makes JSON.parse
  // throw "Unexpected token '﻿'". Node's require() hides the problem, so
  // this asserts on the bytes and on the checker actually repairing them.
  const pkgPath = path.join(here, '..', 'package.json');
  const original = fs.readFileSync(pkgPath);
  try {
    fs.writeFileSync(pkgPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original]));
    const before = fs.readFileSync(pkgPath);
    assert.equal(before[0], 0xef, 'the fixture really does have a BOM');
    assert.throws(() => JSON.parse(before.toString('utf8')), 'and a raw JSON.parse really does fail');

    execFileSync(process.execPath, [path.join(here, 'check.js')], { stdio: 'pipe' });

    const after = fs.readFileSync(pkgPath);
    assert.equal(after[0], '{'.charCodeAt(0), 'the BOM is gone');
    assert.doesNotThrow(() => JSON.parse(after.toString('utf8')));
    assert.equal(after.toString('utf8'), original.toString('utf8'), 'nothing else changed');
  } finally {
    fs.writeFileSync(pkgPath, original);
  }
});

await test('package.json and package-lock.json agree on the version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(here, '..', 'package-lock.json'), 'utf8'));
  // `npm ci`, which the release workflow uses, refuses to install when these differ.
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
});

/* ------------- skipping and adjusting single occurrences ----------- */

function skipDoc({ amount = 500, inDays = 3 } = {}) {
  const doc = schema.emptyDocument();
  const due = fmt.addDays(fmt.today(), inDays);
  doc.accounts = [
    {
      id: 'chk', name: 'Checking', type: 'checking',
      openingBalance: 2000, openingDate: fmt.addDays(fmt.today(), -400), updatedAt: T0,
    },
  ];
  doc.recurring = [
    {
      id: 'rent', name: 'Rent', kind: 'bill', amount, accountId: 'chk', categoryId: '',
      frequency: 'monthly', interval: 1, startDate: due, dayOfMonth: fmt.dt(due).getDate(),
      active: true, skips: [], overrides: [], updatedAt: T0,
    },
  ];
  return { doc, due };
}

function skip(doc, date, reason = 'Lender’s skip-a-pay', createdAt = T1) {
  doc.recurring[0].skips.push({ date, reason, createdAt });
}

await test('a skipped occurrence drops out of what is due', () => {
  const { doc, due } = skipDoc();
  assert.equal(finance.upcomingItems(doc, { days: 10 }).length, 1);
  skip(doc, due);
  assert.equal(finance.upcomingItems(doc, { days: 10 }).length, 0, 'it is no longer owed');
});

await test('a skipped occurrence is still visible when asked for', () => {
  const { doc, due } = skipDoc();
  skip(doc, due, 'Paid ahead');
  const rows = finance.upcomingItems(doc, { days: 10, includeSkipped: true });
  assert.equal(rows.length, 1, 'it can still be found and put back');
  assert.equal(rows[0].skipped, true);
  assert.equal(rows[0].skip.reason, 'Paid ahead');
});

await test('a skipped payment in the past never reads as overdue', () => {
  const { doc } = skipDoc({ inDays: -9 });
  const past = doc.recurring[0].startDate;
  assert.equal(finance.upcomingItems(doc, { days: 10 })[0].overdue, true, 'unskipped, it is late');
  skip(doc, past);
  const rows = finance.upcomingItems(doc, { days: 10, includeSkipped: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].overdue, false, 'a skip settles it — nagging about it would be wrong');
});

await test('the forecast leaves a skipped payment in the account', () => {
  const { doc, due } = skipDoc({ amount: 500 });
  near(finance.forecast(doc, { days: 20 }).end, 1500);
  skip(doc, due);
  near(finance.forecast(doc, { days: 20 }).end, 2000, 0.005);
});

await test('only the named date is skipped', () => {
  const { doc, due } = skipDoc();
  skip(doc, due);
  const rows = finance.upcomingItems(doc, { days: 75 });
  assert.equal(rows.length >= 1, true, 'next month is still due');
  assert.equal(rows.some((r) => r.date === due), false, 'but this one is not');
});

await test('withdrawing a skip makes it due again', () => {
  const { doc, due } = skipDoc();
  skip(doc, due);
  doc.recurring[0].skips[0].removedAt = T2;
  assert.equal(finance.isOccurrenceSkipped(doc.recurring[0], due), false);
  assert.equal(finance.upcomingItems(doc, { days: 10 }).length, 1);
});

await test('skip interest is one month at the account’s rate', () => {
  near(finance.skipInterest({ apr: 6 }, -12000), 60);
  assert.equal(finance.skipInterest({ apr: 0 }, -12000), 0);
  assert.equal(finance.skipInterest({ apr: 6 }, 0), 0);
});

await test('withdrawn skips are pruned once they are old, live ones never', () => {
  const live = { date: '2026-01-05', createdAt: T1 };
  const old = { date: '2026-01-05', createdAt: T1, removedAt: T2 };
  assert.equal(finance.pruneSkips([old], '2026-06-01').length, 0);
  assert.equal(finance.pruneSkips([live], '2026-06-01').length, 1, 'a live skip is not date-limited');
});

await test('an amount set for one date does not touch the others', () => {
  const { doc, due } = skipDoc({ amount: 500 });
  doc.recurring[0].overrides.push({ date: due, amount: 620, note: 'Overtime', createdAt: T1 });
  const rows = finance.upcomingItems(doc, { days: 75 });
  const first = rows.find((r) => r.date === due);
  near(first.amount, 620);
  assert.equal(first.overridden, true);
  assert.equal(first.note, 'Overtime');
  for (const other of rows.filter((r) => r.date !== due)) near(other.amount, 500);
});

await test('the forecast uses the amount set for that date', () => {
  const { doc, due } = skipDoc({ amount: 500 });
  doc.recurring[0].overrides.push({ date: due, amount: 620, createdAt: T1 });
  near(finance.forecast(doc, { days: 20 }).end, 1380);
});

await test('an occurrence set to zero costs nothing', () => {
  const { doc, due } = skipDoc({ amount: 500 });
  doc.recurring[0].overrides.push({ date: due, amount: 0, createdAt: T1 });
  near(finance.forecast(doc, { days: 20 }).end, 2000, 0.005);
});

await test('a withdrawn override falls back to the schedule’s own amount', () => {
  const { doc, due } = skipDoc({ amount: 500 });
  doc.recurring[0].overrides.push({ date: due, amount: 620, createdAt: T1, removedAt: T2 });
  near(finance.resolveOccurrenceAmount(doc, doc.recurring[0], due).amount, 500);
});

await test('a skip wins over an amount set for the same date', () => {
  const { doc, due } = skipDoc({ amount: 500 });
  doc.recurring[0].overrides.push({ date: due, amount: 620, createdAt: T1 });
  skip(doc, due);
  near(finance.forecast(doc, { days: 20 }).end, 2000, 0.005);
});

await test('migrating an older document gives every schedule its adjustment lists', () => {
  const old = schema.emptyDocument();
  old.schemaVersion = 4;
  old.recurring = [{ id: 'r1', name: 'Rent', kind: 'bill', amount: 500, frequency: 'monthly' }];
  delete old.recurring[0].skips;
  const migrated = schema.migrate(old);
  assert.deepEqual(migrated.recurring[0].skips, []);
  assert.deepEqual(migrated.recurring[0].overrides, []);
  assert.equal(migrated.schemaVersion, schema.SCHEMA_VERSION);
});

/* ---------- the payoff schedule follows the real due date ---------- */

function loanDoc({ ruleDay = 1, accountDueDay = 17 } = {}) {
  const doc = schema.emptyDocument();
  doc.accounts = [
    { id: 'chk', name: 'Checking', type: 'checking', openingBalance: 5000, openingDate: '2026-01-01' },
    {
      id: 'roof', name: 'Roof Loan', type: 'loan', openingBalance: -10474.27, openingDate: '2026-01-01',
      interestRate: 10.2, paymentAmount: 435.73, dueDay: accountDueDay,
    },
  ];
  doc.recurring = [
    {
      ...finance.buildPaymentRule(doc, doc.accounts[1], { fromAccountId: 'chk', dayOfMonth: ruleDay }),
      weekendShift: 'none',
      skips: [],
      overrides: [],
    },
  ];
  return doc;
}

await test('the next payment date comes from the schedule, not from today', () => {
  const doc = loanDoc({ ruleDay: 1 });
  const next = finance.nextPaymentDate(doc, 'roof');
  assert.equal(next.slice(-2), '01', `expected the 1st, got ${next}`);
  assert.equal(next >= fmt.today(), true, 'and it is in the future');
});

await test('the payoff schedule starts on the due date and stays on it', () => {
  // The bug this guards: `amortize` defaulted to today(), so every row landed
  // on whatever day the screen happened to be opened and a changed payment
  // date never showed up in Debt Payoff.
  const doc = loanDoc({ ruleDay: 1 });
  const debt = finance.debtsFromAccounts(doc).find((d) => d.id === 'roof');
  assert.equal(debt.nextPayment, finance.nextPaymentDate(doc, 'roof'));
  const sched = finance.amortize({
    principal: debt.balance, annualRate: debt.apr, payment: debt.minPayment,
    startDate: debt.nextPayment,
  });
  for (const row of sched.rows.slice(0, 6)) {
    assert.equal(row.date.slice(-2), '01', `row ${row.n} fell on ${row.date}`);
  }
});

await test('changing the schedule’s day moves the whole payoff schedule', () => {
  const first = finance.debtsFromAccounts(loanDoc({ ruleDay: 1 }))[0].nextPayment;
  const tenth = finance.debtsFromAccounts(loanDoc({ ruleDay: 10 }))[0].nextPayment;
  assert.equal(first.slice(-2), '01');
  assert.equal(tenth.slice(-2), '10');
});

await test('with no schedule the account’s own due day is used', () => {
  const doc = loanDoc({ ruleDay: 1, accountDueDay: 22 });
  doc.recurring = [];
  assert.equal(finance.nextPaymentDate(doc, 'roof').slice(-2), '22');
});

await test('a skipped month is reported for the payoff schedule', () => {
  const doc = loanDoc({ ruleDay: 1 });
  const due = finance.nextPaymentDate(doc, 'roof');
  doc.recurring[0].skips.push({ date: due, reason: 'Skip-a-pay', createdAt: T1 });
  assert.deepEqual(finance.skippedPaymentMonths(doc, 'roof'), [due.slice(0, 7)]);
});

await test('skipping a payment delays the payoff and costs more interest', () => {
  const base = { principal: 10000, annualRate: 12, payment: 500, startDate: '2026-10-01' };
  const plain = finance.amortize(base);
  const skipped = finance.amortize({ ...base, skipMonths: ['2026-12'] });

  assert.equal(skipped.months, plain.months + 1, 'the loan runs one month longer');
  assert.equal(skipped.payoffDate > plain.payoffDate, true);
  assert.equal(skipped.totalInterest > plain.totalInterest, true, 'and costs more');

  const nov = skipped.rows.find((r) => r.date.startsWith('2026-11'));
  const dec = skipped.rows.find((r) => r.date.startsWith('2026-12'));
  assert.equal(dec.skipped, true);
  assert.equal(dec.payment, 0, 'nothing is paid that month');
  assert.equal(dec.principal, 0);
  assert.equal(dec.interest > 0, true, 'but interest still runs — that is the catch');
  assert.equal(dec.balance > nov.balance, true, 'so the balance goes up, not down');
});

/* -------------- a payment that has already been made --------------- */

function payInto(doc, { date, amount, recurringId = null }) {
  doc.transactions.push({
    id: `t${doc.transactions.length + 1}`, type: 'transfer', date, amount,
    accountId: 'chk', transferAccountId: 'roof', recurringId, updatedAt: T1,
  });
}

await test('recording a payment moves the next payment on', () => {
  const doc = loanDoc({ ruleDay: 1 });
  const due = finance.nextPaymentDate(doc, 'roof');
  payInto(doc, { date: due, amount: 435.73, recurringId: doc.recurring[0].id });
  const after = finance.nextPaymentDate(doc, 'roof');
  assert.equal(after > due, true, `expected a later date than ${due}, got ${after}`);
  assert.equal(after.slice(-2), '01', 'and still on the payment day');
});

await test('a paid occurrence stops being listed as due', () => {
  const doc = loanDoc({ ruleDay: 1 });
  const due = finance.nextPaymentDate(doc, 'roof');
  assert.equal(finance.upcomingItems(doc, { days: 60 }).some((r) => r.date === due), true);
  payInto(doc, { date: due, amount: 435.73, recurringId: doc.recurring[0].id });
  assert.equal(finance.upcomingItems(doc, { days: 60 }).some((r) => r.date === due), false);
});

await test('a payment entered by hand counts, even with no schedule attached', () => {
  // "Record a payment" on the Debt Payoff screen, and anything imported from
  // the bank, arrives as a plain transfer into the loan.
  const doc = loanDoc({ ruleDay: 1 });
  const due = finance.nextPaymentDate(doc, 'roof');
  payInto(doc, { date: due, amount: 435.73 });
  assert.equal(finance.isOccurrencePosted(doc, doc.recurring[0], due), true);
  assert.equal(finance.nextPaymentDate(doc, 'roof') > due, true);
});

await test('a small extra payment does not make the real one disappear', () => {
  // The dangerous direction: marking a payment done when it has not been made.
  const doc = loanDoc({ ruleDay: 1 });
  const due = finance.nextPaymentDate(doc, 'roof');
  payInto(doc, { date: fmt.addDays(due, -1), amount: 100 });
  assert.equal(finance.isOccurrencePosted(doc, doc.recurring[0], due), false);
  assert.equal(finance.nextPaymentDate(doc, 'roof'), due, 'it is still owed');
});

await test('two part payments that together cover it do count', () => {
  const doc = loanDoc({ ruleDay: 1 });
  const due = finance.nextPaymentDate(doc, 'roof');
  payInto(doc, { date: due, amount: 235.73 });
  payInto(doc, { date: fmt.addDays(due, 1), amount: 200 });
  assert.equal(finance.isOccurrencePosted(doc, doc.recurring[0], due), true);
});

await test('a missed payment is named, not glossed over', () => {
  const doc = loanDoc({ ruleDay: 1 });
  doc.recurring[0].startDate = fmt.addDays(fmt.today(), -40);
  doc.recurring[0].dayOfMonth = 1;
  const next = finance.nextPaymentDate(doc, 'roof');
  assert.equal(next < fmt.today(), true, `expected the overdue payment, got ${next}`);
  assert.equal(next.slice(-2), '01');
});

await test('a skipped payment is not what you owe next', () => {
  const doc = loanDoc({ ruleDay: 1 });
  const due = finance.nextPaymentDate(doc, 'roof');
  doc.recurring[0].skips.push({ date: due, reason: 'Skip-a-pay', createdAt: T1 });
  assert.equal(finance.nextPaymentDate(doc, 'roof') > due, true);
});

await test('the payoff schedule starts after the payment already made', () => {
  const doc = loanDoc({ ruleDay: 1 });
  const due = finance.nextPaymentDate(doc, 'roof');
  payInto(doc, { date: due, amount: 435.73, recurringId: doc.recurring[0].id });
  const debt = finance.debtsFromAccounts(doc).find((d) => d.id === 'roof');
  assert.equal(debt.nextPayment > due, true, 'the schedule does not re-bill what was paid');
  const sched = finance.amortize({
    principal: debt.balance, annualRate: debt.apr, payment: debt.minPayment,
    startDate: debt.nextPayment,
  });
  assert.equal(sched.rows[0].date, debt.nextPayment);
});

await test('the last payment recorded is reported back', () => {
  const doc = loanDoc({ ruleDay: 1 });
  payInto(doc, { date: '2026-08-01', amount: 435.73 });
  payInto(doc, { date: '2026-09-01', amount: 500 });
  const last = finance.lastPaymentInto(doc, 'roof');
  assert.equal(last.date, '2026-09-01');
  near(last.amount, 500);
  assert.equal(finance.lastPaymentInto(doc, 'chk'), null, 'money leaving is not a payment into it');
});

/* ------------- what a loan payment is actually made of ------------- */

function mortgageDoc({ owed = 184500, payment = 1642, escrow = 398, rate = 5.85 } = {}) {
  const doc = schema.emptyDocument();
  doc.accounts = [
    { id: 'chk', name: 'Checking', type: 'checking', openingBalance: 9000, openingDate: '2026-01-01' },
    {
      id: 'mort', name: 'Mortgage', type: 'mortgage', openingBalance: -owed, openingDate: '2026-01-01',
      interestRate: rate, paymentAmount: payment, escrowAmount: escrow, dueDay: 1,
    },
  ];
  return doc;
}

await test('a mortgage payment is escrow, interest and a little principal', () => {
  const doc = mortgageDoc();
  const b = finance.paymentBreakdown(doc, doc.accounts[1]);
  near(b.total, 1642);
  near(b.escrow, 398);
  near(b.toLoan, 1244);
  near(b.interest, 899.44); // 184500 * 5.85% / 12
  near(b.principal, 344.56);
  near(round(b.escrow + b.interest + b.principal), 1642, 0.02);
});

await test('escrow never touches the loan', () => {
  const withEscrow = finance.paymentBreakdown(mortgageDoc({ escrow: 398 }), mortgageDoc().accounts[1]);
  const doc = mortgageDoc({ escrow: 0 });
  doc.accounts[1].escrowAmount = 0;
  const without = finance.paymentBreakdown(doc, doc.accounts[1]);
  near(without.toLoan - withEscrow.toLoan, 398, 0.02);
  near(without.interest, withEscrow.interest, 0.02, 'interest depends on the balance, not the escrow');
  assert.equal(without.principal > withEscrow.principal, true);
});

await test('a payment that does not cover the interest is flagged', () => {
  const doc = mortgageDoc({ payment: 500, escrow: 0 });
  doc.accounts[1].escrowAmount = 0;
  doc.accounts[1].paymentAmount = 500;
  const b = finance.paymentBreakdown(doc, doc.accounts[1]);
  assert.equal(b.shortfall, true, '500 does not cover 899 of interest');
  assert.equal(b.principal, 0, 'and nothing comes off the balance');
});

await test('the payoff planner ignores escrow when paying a mortgage down', () => {
  const doc = mortgageDoc();
  const debt = finance.debtsFromAccounts(doc).find((d) => d.id === 'mort');
  near(debt.minPayment, 1244, 0.02, 'the escrow is not money paying the debt');
  near(debt.escrow, 398);
});

await test('interest is never more than what is owed', () => {
  const doc = mortgageDoc({ owed: 40, payment: 1642, escrow: 0 });
  doc.accounts[1].escrowAmount = 0;
  const b = finance.paymentBreakdown(doc, doc.accounts[1]);
  assert.equal(b.interest + b.principal <= 40.01, true, `paid ${b.interest + b.principal} on 40 owed`);
});

function round(n) {
  return Math.round(n * 100) / 100;
}

/* ---------------------- loans that are forgiven -------------------- */

function pslfDoc({ made = 46, required = 120, from = '2026-01-01' } = {}) {
  const doc = schema.emptyDocument();
  doc.accounts = [
    { id: 'chk', name: 'Checking', type: 'checking', openingBalance: 5000, openingDate: '2026-01-01' },
    {
      id: 'edu', name: 'Student Loan', type: 'student-loan', openingBalance: -38000,
      openingDate: '2026-01-01', interestRate: 5.5, paymentAmount: 240, dueDay: 1,
      forgiveness: true, forgivenessRequired: required, forgivenessPaymentsMade: made,
      forgivenessCountFrom: from,
    },
  ];
  return doc;
}

await test('payments made before FinFolio still count', () => {
  const doc = pslfDoc({ made: 46 });
  const p = finance.forgivenessProgress(doc, doc.accounts[1]);
  assert.equal(p.made, 46);
  assert.equal(p.required, 120);
  assert.equal(p.remaining, 74);
});

await test('payments recorded here are added to the count', () => {
  const doc = pslfDoc({ made: 46, from: '2026-01-01' });
  for (const date of ['2026-02-01', '2026-03-01', '2026-04-01']) {
    doc.transactions.push({
      id: `p${date}`, type: 'transfer', date, amount: 240, accountId: 'chk', transferAccountId: 'edu',
    });
  }
  assert.equal(finance.forgivenessProgress(doc, doc.accounts[1]).made, 49);
});

await test('payments before the cut-off are not counted twice', () => {
  // The 46 already-made payments cover everything up to the cut-off date, so a
  // transaction older than that must not be added on top of them.
  const doc = pslfDoc({ made: 46, from: '2026-06-01' });
  doc.transactions.push({
    id: 'old', type: 'transfer', date: '2026-03-01', amount: 240, accountId: 'chk', transferAccountId: 'edu',
  });
  assert.equal(finance.forgivenessProgress(doc, doc.accounts[1]).made, 46);
});

await test('forgiveness is dated from what is left to pay, not the balance', () => {
  const doc = pslfDoc({ made: 118, required: 120 });
  const p = finance.forgivenessProgress(doc, doc.accounts[1]);
  assert.equal(p.remaining, 2);
  assert.equal(p.projectedDate !== null, true);
  // Two payments away, not the decades the balance alone would suggest.
  assert.equal(p.projectedDate < fmt.addMonths(fmt.today(), 4), true, p.projectedDate);
});

await test('a loan with every payment made is done', () => {
  const doc = pslfDoc({ made: 120, required: 120 });
  const p = finance.forgivenessProgress(doc, doc.accounts[1]);
  assert.equal(p.complete, true);
  assert.equal(p.remaining, 0);
  assert.equal(p.projectedDate, null);
});

await test('the payoff planner never sends extra money at a forgiven loan', () => {
  // Paying a PSLF loan down early buys nothing: that money was going to be
  // written off. It must go to the debts that will not be.
  const doc = pslfDoc({ made: 60 });
  doc.accounts.push({
    id: 'visa', name: 'Visa', type: 'credit', openingBalance: -4000, openingDate: '2026-01-01',
    apr: 22, minPaymentPct: 2, minPaymentFloor: 25,
  });
  const debts = finance.debtsFromAccounts(doc);
  const withExtra = finance.debtPlan(debts, 800, 'avalanche');
  const card = withExtra.debts.find((d) => d.id === 'visa');
  const edu = withExtra.debts.find((d) => d.id === 'edu');
  assert.equal(card.months <= 6, true, `the extra should clear the card fast, took ${card.months}`);
  assert.equal(edu.forgiven, true, 'and the student loan ends by being forgiven');
});

/* ------------------- charges that clear themselves ----------------- */

await test('interest charged to a card clears itself', () => {
  const doc = schema.emptyDocument();
  doc.accounts = [
    { id: 'visa', name: 'Visa', type: 'credit', openingBalance: -500 },
    { id: 'chk', name: 'Checking', type: 'checking', openingBalance: 500 },
  ];
  const interest = doc.categories.find((c) => c.name === 'Interest Charge').id;
  const groceries = doc.categories.find((c) => c.name === 'Groceries').id;

  assert.equal(finance.shouldAutoClear(doc, { accountId: 'visa', categoryId: interest }), true);
  assert.equal(
    finance.shouldAutoClear(doc, { accountId: 'visa', categoryId: groceries }),
    false,
    'a purchase on the card is still pending until it posts'
  );
  assert.equal(
    finance.shouldAutoClear(doc, { accountId: 'chk', categoryId: interest }),
    false,
    'this is about charges the lender posts, not every interest line'
  );
  doc.settings.autoClearCharges = false;
  assert.equal(finance.shouldAutoClear(doc, { accountId: 'visa', categoryId: interest }), false);
});

/* ------------------------ one month at a glance -------------------- */

await test('a month reports what is paid and what is left', () => {
  const doc = schema.emptyDocument();
  const month = fmt.monthKey(fmt.today());
  const first = `${month}-05`;
  const second = `${month}-20`;
  doc.accounts = [{ id: 'chk', name: 'Checking', type: 'checking', openingBalance: 3000, openingDate: '2026-01-01' }];
  doc.recurring = [
    { id: 'rent', name: 'Rent', kind: 'bill', amount: 1200, accountId: 'chk', frequency: 'monthly',
      startDate: first, dayOfMonth: 5, active: true, skips: [], overrides: [] },
    { id: 'power', name: 'Electric', kind: 'bill', amount: 140, accountId: 'chk', frequency: 'monthly',
      startDate: second, dayOfMonth: 20, active: true, skips: [], overrides: [] },
    { id: 'pay', name: 'Payday', kind: 'income', amount: 2600, accountId: 'chk', frequency: 'monthly',
      startDate: first, dayOfMonth: 5, active: true, skips: [], overrides: [] },
  ];

  let m = finance.monthSchedule(doc, month);
  assert.equal(m.countBills, 2);
  assert.equal(m.countLeft, 2);
  near(m.bills, 1340);
  near(m.billsLeft, 1340);
  near(m.income, 2600);

  doc.transactions.push({
    id: 'paid1', type: 'expense', date: first, amount: 1200, accountId: 'chk', recurringId: 'rent',
  });
  m = finance.monthSchedule(doc, month);
  assert.equal(m.countPaid, 1);
  assert.equal(m.countLeft, 1);
  near(m.billsPaid, 1200);
  near(m.billsLeft, 140);
  assert.equal(m.countBills, 2, 'a paid bill stays in the month rather than vanishing');
});

await test('a skipped bill is not money the month still owes', () => {
  const doc = schema.emptyDocument();
  const month = fmt.monthKey(fmt.today());
  doc.accounts = [{ id: 'chk', name: 'Checking', type: 'checking', openingBalance: 3000 }];
  doc.recurring = [
    { id: 'rent', name: 'Rent', kind: 'bill', amount: 1200, accountId: 'chk', frequency: 'monthly',
      startDate: `${month}-05`, dayOfMonth: 5, active: true,
      skips: [{ date: `${month}-05`, reason: 'Paid ahead', createdAt: T1 }], overrides: [] },
  ];
  const m = finance.monthSchedule(doc, month);
  assert.equal(m.countBills, 0);
  near(m.billsLeft, 0);
  assert.equal(m.skipped, 1, 'but it is still visible');
});

/* ----------------------- spending projections ---------------------- */

await test('a projection uses the months that have data, not the empty ones', () => {
  const series = [
    { key: '2026-01', amount: 0, count: 0 },
    { key: '2026-02', amount: 0, count: 0 },
    { key: '2026-03', amount: 300, count: 3 },
    { key: '2026-04', amount: 300, count: 3 },
    { key: '2026-05', amount: 300, count: 3 },
  ];
  const p = finance.projectFromSeries(series);
  assert.equal(p.months, 3, 'the two months before the first transaction are not zero spend');
  near(p.average, 300);
  near(p.projected, 300, 1);
});

await test('a rising trend projects higher than the plain average', () => {
  const series = [100, 150, 200, 250, 300].map((amount, i) => ({ key: `2026-0${i + 1}`, amount, count: 2 }));
  const p = finance.projectFromSeries(series);
  near(p.average, 200);
  assert.equal(p.trendPerMonth > 0, true);
  assert.equal(p.projected > p.average, true, 'a steady climb should not project the mean');
});

await test('a projection is never negative and never runs away', () => {
  const falling = [500, 400, 300, 200, 100].map((amount, i) => ({ key: `2026-0${i + 1}`, amount, count: 2 }));
  assert.equal(finance.projectFromSeries(falling).projected >= 0, true);
  const spike = [10, 10, 10, 10, 4000].map((amount, i) => ({ key: `2026-0${i + 1}`, amount, count: 2 }));
  const p = finance.projectFromSeries(spike);
  assert.equal(p.projected <= p.average * 2 + Math.abs(p.trendPerMonth) + 0.01, true);
});

await test('one month of history is honest about not knowing', () => {
  const p = finance.projectFromSeries([{ key: '2026-05', amount: 200, count: 2 }]);
  assert.equal(p.confident, false);
});

await test('a month-by-month series buckets by category', () => {
  const doc = schema.emptyDocument();
  doc.accounts = [{ id: 'chk', name: 'Checking', type: 'checking', openingBalance: 0 }];
  const food = doc.categories.find((c) => c.name === 'Groceries').id;
  const fuel = doc.categories.find((c) => c.name === 'Fuel').id;
  const m0 = fmt.monthKey(fmt.today());
  const m1 = fmt.monthKey(fmt.addMonths(fmt.today(), -1));
  doc.transactions = [
    { id: 'a', type: 'expense', date: `${m0}-05`, amount: 80, accountId: 'chk', categoryId: food },
    { id: 'b', type: 'expense', date: `${m0}-09`, amount: 20, accountId: 'chk', categoryId: food },
    { id: 'c', type: 'expense', date: `${m1}-11`, amount: 55, accountId: 'chk', categoryId: food },
    { id: 'd', type: 'expense', date: `${m0}-12`, amount: 60, accountId: 'chk', categoryId: fuel },
  ];
  const series = finance.spendingSeries(doc, { categoryId: food, months: 3 });
  assert.equal(series.length, 3);
  near(series[series.length - 1].amount, 100);
  assert.equal(series[series.length - 1].count, 2);
  near(series[series.length - 2].amount, 55);
});

/* ---------------- debts set aside from the plan --------------------- */

function mixedDebtDoc() {
  const doc = schema.emptyDocument();
  doc.accounts = [
    { id: 'chk', name: 'Checking', type: 'checking', openingBalance: 4000, openingDate: '2026-01-01' },
    {
      id: 'visa', name: 'Visa', type: 'credit', openingBalance: -4000, openingDate: '2026-01-01',
      apr: 22, minPaymentPct: 2, minPaymentFloor: 25,
    },
    {
      id: 'mort', name: 'Mortgage', type: 'mortgage', openingBalance: -184500, openingDate: '2026-01-01',
      interestRate: 5.85, paymentAmount: 1642, escrowAmount: 398, dueDay: 1,
    },
  ];
  return doc;
}

await test('a debt is in the plan unless it is set aside', () => {
  const doc = mixedDebtDoc();
  const all = finance.debtsFromAccounts(doc);
  assert.equal(all.every((d) => d.inPlan), true, 'nothing is excluded by default');
  doc.accounts[2].inPayoffPlan = false;
  const after = finance.debtsFromAccounts(doc);
  assert.equal(after.find((d) => d.id === 'mort').inPlan, false);
  assert.equal(after.find((d) => d.id === 'visa').inPlan, true);
  assert.equal(after.length, 2, 'a set-aside debt is still reported, just flagged');
});

await test('setting the mortgage aside leaves the card plan alone', () => {
  const doc = mixedDebtDoc();
  const all = finance.debtsFromAccounts(doc);
  const cardOnly = finance.debtPlan(all.filter((d) => d.id === 'visa'), 300, 'avalanche');
  doc.accounts[2].inPayoffPlan = false;
  const filtered = finance.debtsFromAccounts(doc).filter((d) => d.inPlan);
  const plan = finance.debtPlan(filtered, 300, 'avalanche');

  assert.equal(filtered.length, 1);
  assert.equal(plan.months, cardOnly.months, 'the card pays off on exactly the same timetable');
  assert.equal(plan.payoffDate, cardOnly.payoffDate);
});

await test('a set-aside mortgage does not fund the rest of the plan', () => {
  // Its minimum is real money that still leaves the account every month, so it
  // must not quietly become budget for attacking the cards.
  const doc = mixedDebtDoc();
  const withMortgage = finance.debtsFromAccounts(doc);
  const wide = finance.debtPlan(withMortgage, 0, 'avalanche');

  doc.accounts[2].inPayoffPlan = false;
  const narrow = finance.debtPlan(
    finance.debtsFromAccounts(doc).filter((d) => d.inPlan),
    0,
    'avalanche'
  );
  assert.equal(narrow.monthlyBudget < wide.monthlyBudget, true);
  near(wide.monthlyBudget - narrow.monthlyBudget, 1244, 0.02, 'the mortgage payment less escrow');
});

await test('a plan with everything set aside is empty, not broken', () => {
  const doc = mixedDebtDoc();
  doc.accounts[1].inPayoffPlan = false;
  doc.accounts[2].inPayoffPlan = false;
  const kept = finance.debtsFromAccounts(doc).filter((d) => d.inPlan);
  assert.equal(kept.length, 0);
  const plan = finance.debtPlan(kept, 200, 'avalanche');
  assert.equal(plan.months, 0);
  assert.equal(plan.payoffDate, null);
  assert.deepEqual(plan.debts, []);
});

/* ------------------ icons, grouping, subscriptions ----------------- */

function billsDoc() {
  const doc = schema.emptyDocument();
  doc.accounts = [
    { id: 'chk', name: 'Checking', type: 'checking', openingBalance: 3000, openingDate: '2026-01-01' },
    { id: 'visa', name: 'Visa', type: 'credit', openingBalance: -1000, openingDate: '2026-01-01',
      apr: 21, creditLimit: 5000, minPaymentPct: 2, minPaymentFloor: 25 },
    { id: 'car', name: 'Car Loan', type: 'loan', openingBalance: -9000, openingDate: '2026-01-01',
      interestRate: 6, paymentAmount: 300 },
  ];
  const groceries = doc.categories.find((c) => c.name === 'Groceries');
  const month = fmt.monthKey(fmt.today());
  doc.recurring = [
    { id: 'food', name: 'Grocery order', kind: 'bill', amount: 90, accountId: 'chk',
      categoryId: groceries.id, frequency: 'monthly', startDate: `${month}-04`, dayOfMonth: 4, active: true },
    { id: 'pay', name: 'Payday', kind: 'income', amount: 2600, accountId: 'chk',
      frequency: 'monthly', startDate: `${month}-01`, dayOfMonth: 1, active: true },
    { id: 'visapay', name: 'Visa payment', kind: 'transfer', amount: 25, accountId: 'chk',
      transferAccountId: 'visa', linkedAccountId: 'visa', amountSource: 'card-minimum',
      frequency: 'monthly', startDate: `${month}-08`, dayOfMonth: 8, active: true },
    { id: 'carpay', name: 'Car payment', kind: 'transfer', amount: 300, accountId: 'chk',
      transferAccountId: 'car', linkedAccountId: 'car', amountSource: 'loan-payment',
      frequency: 'monthly', startDate: `${month}-15`, dayOfMonth: 15, active: true },
    { id: 'tv', name: 'Streaming', kind: 'subscription', amount: 20, accountId: 'chk',
      frequency: 'monthly', startDate: `${month}-10`, dayOfMonth: 10, active: true },
  ];
  return doc;
}

await test('a bill shows its category’s icon, not a blank page', () => {
  const doc = billsDoc();
  const groceries = doc.categories.find((c) => c.name === 'Groceries');
  assert.equal(finance.scheduleIcon(doc, doc.recurring[0]), groceries.icon);
  assert.notEqual(finance.scheduleIcon(doc, doc.recurring[0]), '📄');
});

await test('a schedule’s own icon beats the category’s', () => {
  const doc = billsDoc();
  doc.recurring[0].icon = '🍕';
  assert.equal(finance.scheduleIcon(doc, doc.recurring[0]), '🍕');
});

await test('a card or loan payment borrows its account’s icon', () => {
  const doc = billsDoc();
  assert.equal(finance.scheduleIcon(doc, doc.recurring[2]), finance.accountType('credit').icon);
  assert.equal(finance.scheduleIcon(doc, doc.recurring[3]), finance.accountType('loan').icon);
});

await test('a bullet category icon is treated as no icon at all', () => {
  const doc = billsDoc();
  doc.categories.find((c) => c.name === 'Groceries').icon = '•';
  assert.equal(finance.scheduleIcon(doc, doc.recurring[0]), '📄', 'falls through to the default');
});

await test('schedules sort into cards, loans, subscriptions, bills and income', () => {
  const doc = billsDoc();
  const g = (id) => finance.scheduleGroup(doc, doc.recurring.find((r) => r.id === id));
  assert.equal(g('pay'), 'income');
  assert.equal(g('visapay'), 'card');
  assert.equal(g('carpay'), 'loan');
  assert.equal(g('tv'), 'subscription');
  assert.equal(g('food'), 'bill');
});

await test('grouping keeps every item and drops the empty sections', () => {
  const doc = billsDoc();
  const groups = finance.groupSchedules(doc, doc.recurring, (r) => r);
  const total = groups.reduce((s, x) => s + x.items.length, 0);
  assert.equal(total, doc.recurring.length, 'nothing is lost');
  assert.equal(groups.every((x) => x.items.length > 0), true);
  assert.deepEqual(groups.map((x) => x.id), ['income', 'card', 'loan', 'subscription', 'bill']);
});

await test('subscriptions are totalled per month and per year', () => {
  const doc = billsDoc();
  doc.recurring.push({
    id: 'yearly', name: 'Cloud storage', kind: 'subscription', amount: 120, accountId: 'chk',
    frequency: 'annual', startDate: `${fmt.monthKey(fmt.today())}-20`, active: true,
  });
  const s = finance.subscriptionSummary(doc);
  assert.equal(s.count, 2);
  near(s.monthly, 30, 0.02, '20 a month plus 120 a year');
  near(s.yearly, 360);
  assert.equal(s.items[0].rule.id, 'tv', 'dearest per month first');
});

await test('a paused subscription costs nothing but is still listed', () => {
  const doc = billsDoc();
  doc.recurring.find((r) => r.id === 'tv').active = false;
  const s = finance.subscriptionSummary(doc);
  assert.equal(s.count, 1);
  assert.equal(s.activeCount, 0);
  assert.equal(s.pausedCount, 1);
  near(s.monthly, 0);
});

await test('cancelling some shows what it saves without changing anything', () => {
  const doc = billsDoc();
  doc.recurring.push({
    id: 'gym', name: 'Gym', kind: 'subscription', amount: 40, accountId: 'chk',
    frequency: 'monthly', startDate: `${fmt.monthKey(fmt.today())}-02`, active: true,
  });
  const s = finance.subscriptionSummary(doc, { cancelling: ['gym'] });
  near(s.monthly, 60);
  near(s.saving, 40);
  near(s.savingYearly, 480);
  near(s.remaining, 20);
  assert.equal(s.cuttingCount, 1);
  assert.equal(doc.recurring.find((r) => r.id === 'gym').active, true, 'the what-if is not a change');
});

await test('subscriptions are measured against income', () => {
  const doc = billsDoc();
  const s = finance.subscriptionSummary(doc);
  // 20 a month of subscriptions against 2600 of income.
  near(s.shareOfIncome, (20 / 2600) * 100, 0.05);
});

await test('available credit is money, not a percentage', () => {
  const card = { creditLimit: 5000 };
  near(finance.availableCredit(card, -1200), 3800);
  near(finance.availableCredit(card, -5200), -200, 0.01, 'over the limit reads negative');
  assert.equal(finance.availableCredit({ creditLimit: 0 }, -100), null, 'no limit, no answer');
});

/* ------------------------ sub-categories --------------------------- */

function petDoc() {
  const doc = schema.emptyDocument();
  doc.accounts = [
    { id: 'chk', name: 'Checking', type: 'checking', openingBalance: 3000, openingDate: '2026-01-01' },
    { id: 'visa', name: 'Visa', type: 'credit', openingBalance: -200, openingDate: '2026-01-01' },
  ];
  const pets = doc.categories.find((c) => c.name === 'Pets');
  doc.categories.push(
    { id: 'food', name: 'Pet food', group: pets.group, icon: '🥫', kind: 'expense', parentId: pets.id, archived: false, sort: 900 },
    { id: 'vet', name: 'Vet bills', group: pets.group, icon: '🩺', kind: 'expense', parentId: pets.id, archived: false, sort: 901 }
  );
  const m = fmt.monthKey(fmt.today());
  doc.transactions = [
    { id: 't1', type: 'expense', date: `${m}-03`, amount: 40, accountId: 'chk', categoryId: 'food' },
    { id: 't2', type: 'expense', date: `${m}-09`, amount: 120, accountId: 'chk', categoryId: 'vet' },
    { id: 't3', type: 'expense', date: `${m}-14`, amount: 15, accountId: 'visa', categoryId: pets.id },
  ];
  doc.petsId = pets.id;
  return doc;
}

await test('a category knows its children', () => {
  const doc = petDoc();
  const kids = finance.categoryChildren(doc, doc.petsId).map((c) => c.name).sort();
  assert.deepEqual(kids, ['Pet food', 'Vet bills']);
  assert.deepEqual(finance.categoryChildren(doc, 'food'), [], 'nesting stops at one level');
});

await test('the family of a category is itself plus its children', () => {
  const doc = petDoc();
  assert.deepEqual(finance.categoryFamily(doc, doc.petsId).sort(), [doc.petsId, 'food', 'vet'].sort());
  assert.deepEqual(finance.categoryFamily(doc, 'food'), ['food']);
});

await test('a sub-category reads as part of its parent', () => {
  const doc = petDoc();
  assert.equal(finance.categoryLabel(doc, 'vet'), 'Vet bills');
  assert.equal(finance.categoryLabel(doc, 'vet', { full: true }), 'Pets › Vet bills');
  assert.equal(finance.categoryLabel(doc, doc.petsId, { full: true }), 'Pets');
});

await test('only a top-level category can take children', () => {
  const doc = petDoc();
  assert.equal(finance.canHaveChildren(doc, doc.petsId), true);
  assert.equal(finance.canHaveChildren(doc, 'vet'), false);
});

await test('the tree lists each parent followed by its children', () => {
  const doc = petDoc();
  const tree = finance.categoryTree(doc, { kind: 'expense' });
  const at = tree.findIndex((x) => x.category.id === doc.petsId);
  assert.equal(tree[at].depth, 0);
  assert.deepEqual([tree[at + 1].category.id, tree[at + 2].category.id].sort(), ['food', 'vet']);
  assert.equal(tree[at + 1].depth, 1);
});

await test('a child whose parent is archived is still reachable', () => {
  const doc = petDoc();
  doc.categories.find((c) => c.id === doc.petsId).archived = true;
  const tree = finance.categoryTree(doc, { kind: 'expense' });
  assert.equal(tree.some((x) => x.category.id === 'vet'), true, 'it must not silently vanish');
});

await test('spending on a parent includes its children', () => {
  const doc = petDoc();
  const month = fmt.monthKey(fmt.today());
  near(finance.spentInMonth(doc, doc.petsId, month), 175, 0.02, '40 + 120 + 15');
  near(finance.spentInMonth(doc, doc.petsId, month, { includeChildren: false }), 15);
  near(finance.spentInMonth(doc, 'vet', month), 120);
});

await test('a child with its own budget is not counted twice', () => {
  // A sub-budget is carved out of the parent, not stacked on top of it.
  const doc = petDoc();
  const month = fmt.monthKey(fmt.today());
  doc.budgets = [
    { id: 'b1', categoryId: doc.petsId, month, amount: 200, rollover: false },
    { id: 'b2', categoryId: 'vet', month, amount: 150, rollover: false },
  ];
  const progress = finance.budgetProgress(doc, month);
  const parent = progress.rows.find((r) => r.categoryId === doc.petsId);
  const vet = progress.rows.find((r) => r.categoryId === 'vet');
  near(vet.spent, 120);
  near(parent.spent, 55, 0.02, 'food and the direct charge, but not the vet');
  near(progress.totals.spent, 175, 0.02, 'and the total still adds up to what was spent');
});

await test('category totals can roll children into the parent', () => {
  const doc = petDoc();
  const month = fmt.monthKey(fmt.today());
  const flat = finance.categoryTotals(doc, { from: `${month}-01`, to: `${month}-28` });
  assert.equal(flat.length >= 3, true, 'flat keeps them separate');

  const rolled = finance.categoryTotals(doc, { from: `${month}-01`, to: `${month}-28`, rollUp: true });
  const pets = rolled.find((r) => r.categoryId === doc.petsId);
  near(pets.amount, 175);
  assert.equal(pets.children.length, 2);
  near(pets.children[0].amount, 120, 0.02, 'dearest child first');
  assert.equal(
    rolled.some((r) => r.categoryId === 'vet'),
    false,
    'a child does not also appear as a top-level row'
  );
});

await test('a spending series for a parent includes its children', () => {
  const doc = petDoc();
  const withKids = finance.spendingSeries(doc, { categoryId: doc.petsId, months: 2 });
  const alone = finance.spendingSeries(doc, { categoryId: doc.petsId, months: 2, includeChildren: false });
  near(withKids[withKids.length - 1].amount, 175);
  near(alone[alone.length - 1].amount, 15);
});

await test('reports can narrow to one account', () => {
  const doc = petDoc();
  const month = fmt.monthKey(fmt.today());
  const all = finance.categoryTotals(doc, { from: `${month}-01`, to: `${month}-28`, rollUp: true });
  const chk = finance.categoryTotals(doc, {
    from: `${month}-01`, to: `${month}-28`, rollUp: true, accountIds: ['chk'],
  });
  near(all.find((r) => r.categoryId === doc.petsId).amount, 175);
  near(chk.find((r) => r.categoryId === doc.petsId).amount, 160, 0.02, 'the card charge drops out');

  const series = finance.spendingSeries(doc, { categoryId: doc.petsId, months: 2, accountIds: ['visa'] });
  near(series[series.length - 1].amount, 15);
});

await test('payee totals can narrow to one account', () => {
  const doc = petDoc();
  doc.transactions[0].payee = 'PetSmart';
  doc.transactions[2].payee = 'PetSmart';
  const month = fmt.monthKey(fmt.today());
  const all = finance.payeeTotals(doc, { from: `${month}-01`, to: `${month}-28` });
  near(all.find((p) => p.payee === 'PetSmart').amount, 55);
  const chk = finance.payeeTotals(doc, { from: `${month}-01`, to: `${month}-28`, accountIds: ['chk'] });
  near(chk.find((p) => p.payee === 'PetSmart').amount, 40);
});

await test('an older document gains the parent field without changing', () => {
  const old = schema.emptyDocument();
  old.schemaVersion = 6;
  for (const c of old.categories) delete c.parentId;
  const migrated = schema.migrate(old);
  assert.equal(migrated.schemaVersion, schema.SCHEMA_VERSION);
  assert.equal(migrated.categories.every((c) => c.parentId === null), true);
});

/* --------- adjustments surviving a merge between computers --------- */

function syncRuleDoc(stamp, { skips = [], overrides = [], name = 'Rent', ruleStamp = T0 } = {}) {
  const doc = JSON.parse(JSON.stringify(SYNC_BASE));
  doc.meta.updatedAt = stamp;
  doc.recurring = [
    {
      id: 'rent', name, kind: 'bill', amount: 500, accountId: 'acc1', categoryId: '',
      frequency: 'monthly', startDate: '2026-12-05', dayOfMonth: 5,
      active: true, skips, overrides, updatedAt: ruleStamp,
    },
  ];
  return doc;
}

await test('merging keeps a skip each computer made', () => {
  const mine = syncRuleDoc(T1, { skips: [{ date: '2026-12-05', reason: 'Skip-a-pay', createdAt: T1 }] });
  const theirs = syncRuleDoc(T1, { skips: [{ date: '2027-01-05', reason: 'Paid ahead', createdAt: T1 }] });
  const res = mergeDocuments(mine, theirs);
  assert.equal(res.ok, true);
  const dates = res.doc.recurring[0].skips.map((s) => s.date);
  assert.deepEqual(dates, ['2026-12-05', '2027-01-05']);
});

await test('an unrelated edit on the other computer cannot cancel a skip', () => {
  // The desk machine renamed the bill afterwards and never saw the skip. A
  // plain "newest record wins" would take its copy whole and lose December.
  const mine = syncRuleDoc(T1, { skips: [{ date: '2026-12-05', reason: 'Skip-a-pay', createdAt: T1 }] });
  const theirs = syncRuleDoc(T3, { name: 'Rent (new landlord)', ruleStamp: T3 });
  const res = mergeDocuments(mine, theirs);
  const rule = res.doc.recurring[0];
  assert.equal(rule.name, 'Rent (new landlord)', 'the newer edit still wins for ordinary fields');
  assert.equal(finance.isOccurrenceSkipped(rule, '2026-12-05'), true, 'and the skip survives it');
});

await test('putting a skip back on one computer is not undone by the other', () => {
  const mine = syncRuleDoc(T1, { skips: [{ date: '2026-12-05', reason: 'Skip-a-pay', createdAt: T1 }] });
  const theirs = syncRuleDoc(T2, {
    skips: [{ date: '2026-12-05', reason: 'Skip-a-pay', createdAt: T1, removedAt: T2 }],
  });
  const res = mergeDocuments(mine, theirs);
  assert.equal(
    finance.isOccurrenceSkipped(res.doc.recurring[0], '2026-12-05'),
    false,
    'the later decision — putting it back — is the one that holds'
  );
});

await test('merging keeps an amount set on either computer', () => {
  const mine = syncRuleDoc(T1, { overrides: [{ date: '2026-12-05', amount: 620, createdAt: T1 }] });
  const theirs = syncRuleDoc(T1, { overrides: [{ date: '2027-01-05', amount: 410, createdAt: T1 }] });
  const res = mergeDocuments(mine, theirs);
  assert.deepEqual(res.doc.recurring[0].overrides.map((o) => o.amount), [620, 410]);
});

/* ------------------------------- report --------------------------- */

console.log('');
for (const [name, err] of failures) {
  console.error(`✗ ${name}`);
  console.error(`  ${err.message.split('\n').slice(0, 4).join('\n  ')}\n`);
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
