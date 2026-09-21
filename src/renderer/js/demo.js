/**
 * Sample data generator.
 *
 * Used by the "explore with sample data" button on an empty dashboard, and as
 * the fixture for the UI smoke test. Deterministic (seeded) so screenshots and
 * tests do not drift between runs.
 */

import { today, iso, dt, addDays, addMonths, startOfMonth, round2, monthKey } from './format.js';
import { uid } from './finance.js';

function rng(seed = 20260917) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function buildDemoDocument(base) {
  const doc = base;
  const rand = rng();
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const between = (lo, hi) => round2(lo + rand() * (hi - lo));

  const start = addMonths(startOfMonth(today()), -7);
  const cat = (name) => (doc.categories.find((c) => c.name === name) || {}).id || '';

  doc.settings.firstRunComplete = true;
  doc.settings.lowBalanceThreshold = 250;

  // A worked example of sub-categories: Pets holds the three things people
  // actually spend on, and the totals still roll up to "Pets".
  const pets = doc.categories.find((c) => c.name === 'Pets');
  if (pets) {
    ['Pet food', 'Vet bills', 'Pet toys'].forEach((name, i) => {
      doc.categories.push({
        id: `demo-cat-pet-${i}`,
        name,
        group: pets.group,
        icon: ['🥫', '🩺', '🧶'][i],
        kind: 'expense',
        parentId: pets.id,
        color: null,
        archived: false,
        sort: (doc.categories.length || 0) + i,
      });
    });
  }

  /* ----------------------------- accounts ------------------------- */

  const accounts = [
    { id: 'demo-chk', name: 'Everyday Checking', type: 'checking', institution: 'First National', last4: '4821', openingBalance: 2400, color: '#2a78d6' },
    { id: 'demo-sav', name: 'Emergency Savings', type: 'savings', institution: 'First National', last4: '9013', openingBalance: 6200, color: '#1baf7a' },
    { id: 'demo-cash', name: 'Cash Wallet', type: 'cash', openingBalance: 140, color: '#008300' },
    { id: 'demo-visa', name: 'Rewards Visa', type: 'credit', institution: 'Summit Bank', last4: '7742', openingBalance: -1850, creditLimit: 6000, apr: 21.49, statementDay: 5, dueDay: 28, minPaymentPct: 2, minPaymentFloor: 25, color: '#eb6834' },
    { id: 'demo-store', name: 'Store Card', type: 'credit', institution: 'Northgate', last4: '1180', openingBalance: -640, creditLimit: 1500, apr: 26.99, dueDay: 15, minPaymentPct: 3, minPaymentFloor: 25, color: '#e87ba4' },
    { id: 'demo-car', name: 'Car Loan', type: 'loan', institution: 'Summit Bank', openingBalance: -14200, originalPrincipal: 24000, interestRate: 6.4, termMonths: 60, paymentAmount: 468, firstPaymentDate: addMonths(start, -18), color: '#e34948' },
    { id: 'demo-student', name: 'Student Loan', type: 'student-loan', institution: 'EdServe', openingBalance: -9800, originalPrincipal: 18000, interestRate: 4.75, termMonths: 120, paymentAmount: 190, color: '#7b4fd4', forgiveness: true, forgivenessRequired: 120, forgivenessPaymentsMade: 46, forgivenessCountFrom: start },
    { id: 'demo-home', name: 'Home', type: 'other-asset', openingBalance: 268000, color: '#eda100' },
    { id: 'demo-mortgage', name: 'Mortgage', type: 'mortgage', institution: 'Keystone Home Loans', openingBalance: -184500, originalPrincipal: 215000, interestRate: 5.85, termMonths: 360, paymentAmount: 1642, escrowAmount: 398, dueDay: 1, color: '#c2622f', inPayoffPlan: false },
  ];
  doc.accounts = accounts.map((a) => ({ archived: false, notes: '', openingDate: start, ...a }));

  /* ---------------------------- recurring ------------------------- */

  const anchor = (d) => dt(d).getDate();
  doc.recurring = [
    {
      id: 'demo-pay', name: 'Paycheck', kind: 'income', amount: 2380, accountId: 'demo-chk',
      categoryId: cat('Paycheck'), payee: 'Hancock Schools', frequency: 'biweekly',
      startDate: nextWeekday(start, 5), active: true, autoPay: true, reminderDays: 0,
    },
    {
      id: 'demo-rent', name: 'Home insurance', kind: 'bill', amount: 128, accountId: 'demo-chk',
      categoryId: cat('Home Insurance'), payee: 'Grange Mutual', frequency: 'monthly',
      startDate: `${monthKey(start)}-01`, dayOfMonth: 1, active: true, autoPay: true, reminderDays: 3,
    },
    {
      id: 'demo-power', name: 'Electric', kind: 'bill', amount: 142, accountId: 'demo-chk',
      categoryId: cat('Electric'), payee: 'Valley Power', frequency: 'monthly',
      startDate: `${monthKey(start)}-12`, dayOfMonth: 12, active: true, variableAmount: true, reminderDays: 3,
    },
    {
      id: 'demo-net', name: 'Internet', kind: 'bill', amount: 79.99, accountId: 'demo-visa',
      categoryId: cat('Internet'), payee: 'Fiberlink', frequency: 'monthly',
      startDate: `${monthKey(start)}-18`, dayOfMonth: 18, active: true, autoPay: true, reminderDays: 2,
    },
    {
      id: 'demo-phone', name: 'Phone', kind: 'bill', amount: 95, accountId: 'demo-visa',
      categoryId: cat('Phone'), payee: 'Cellwave', frequency: 'monthly',
      startDate: `${monthKey(start)}-22`, dayOfMonth: 22, active: true, autoPay: true, reminderDays: 2,
    },
    {
      id: 'demo-stream', name: 'Streaming bundle', kind: 'subscription', amount: 24.99, accountId: 'demo-visa',
      categoryId: cat('Subscriptions'), payee: 'StreamCo', frequency: 'monthly',
      startDate: `${monthKey(start)}-08`, dayOfMonth: 8, active: true, autoPay: true, reminderDays: 0,
    },
    {
      id: 'demo-gym', name: 'Gym membership', kind: 'subscription', amount: 38, accountId: 'demo-visa',
      categoryId: cat('Fitness'), payee: 'Ironworks', frequency: 'monthly',
      startDate: `${monthKey(start)}-03`, dayOfMonth: 3, active: true, autoPay: true, reminderDays: 0,
    },
    {
      id: 'demo-music', name: 'Music streaming', kind: 'subscription', amount: 11.99, accountId: 'demo-visa',
      categoryId: cat('Subscriptions'), payee: 'Tunely', frequency: 'monthly',
      startDate: `${monthKey(start)}-19`, dayOfMonth: 19, active: true, autoPay: true, reminderDays: 0,
    },
    {
      id: 'demo-cloud', name: 'Cloud storage', kind: 'subscription', amount: 99.99, accountId: 'demo-visa',
      categoryId: cat('Subscriptions'), payee: 'Boxly', frequency: 'annual',
      startDate: `${monthKey(start)}-24`, dayOfMonth: 24, active: true, autoPay: true, reminderDays: 0,
    },
    {
      id: 'demo-news', name: 'News app', kind: 'subscription', amount: 6.99, accountId: 'demo-visa',
      categoryId: cat('Subscriptions'), payee: 'The Daily', frequency: 'monthly',
      startDate: `${monthKey(start)}-11`, dayOfMonth: 11, active: false, autoPay: true, reminderDays: 0,
    },
    {
      id: 'demo-carpay', name: 'Car loan payment', kind: 'transfer', amount: 468, accountId: 'demo-chk',
      transferAccountId: 'demo-car', linkedAccountId: 'demo-car', amountSource: 'loan-payment',
      frequency: 'monthly',
      startDate: `${monthKey(start)}-15`, dayOfMonth: 15, active: true, autoPay: true, reminderDays: 3,
    },
    {
      id: 'demo-studentpay', name: 'Student loan payment', kind: 'transfer', amount: 190, accountId: 'demo-chk',
      transferAccountId: 'demo-student', linkedAccountId: 'demo-student', amountSource: 'loan-payment',
      frequency: 'monthly',
      startDate: `${monthKey(start)}-20`, dayOfMonth: 20, active: true, autoPay: true, reminderDays: 3,
    },
    {
      id: 'demo-save', name: 'Savings transfer', kind: 'transfer', amount: 300, accountId: 'demo-chk',
      transferAccountId: 'demo-sav', frequency: 'monthly',
      startDate: `${monthKey(start)}-05`, dayOfMonth: 5, active: true, reminderDays: 0,
    },
    {
      id: 'demo-insure', name: 'Car insurance', kind: 'bill', amount: 612, accountId: 'demo-chk',
      categoryId: cat('Car Insurance'), payee: 'Trident Mutual', frequency: 'semiannual',
      startDate: `${monthKey(addMonths(start, 1))}-10`, dayOfMonth: 10, active: true, reminderDays: 7,
    },
  ];

  /* -------------------------- transactions ------------------------ */

  const merchants = [
    ['Kroger', 'Groceries', 40, 165],
    ['Aldi', 'Groceries', 22, 85],
    ['Shell', 'Fuel', 28, 72],
    ['Speedway', 'Fuel', 25, 65],
    ['Chipotle', 'Restaurants', 11, 32],
    ['The Local Diner', 'Restaurants', 18, 58],
    ['Starbucks', 'Coffee', 4, 12],
    ['Amazon', 'Clothing', 15, 120],
    ['Target', 'Groceries', 25, 140],
    ['Home Depot', 'Repairs & Maintenance', 18, 210],
    ['CVS Pharmacy', 'Pharmacy', 8, 64],
    ['PetSmart', 'Pet food', 22, 88],
    ['Cedar Vale Vet', 'Vet bills', 60, 240],
    ['Cinema 12', 'Hobbies', 14, 46],
    ['Barnes & Noble', 'Hobbies', 12, 54],
    ['Great Clips', 'Haircut & Grooming', 20, 35],
  ];

  const transactions = [];
  const end = today();

  // Post every recurring occurrence that has already happened.
  for (const rule of doc.recurring) {
    const dates = occurrencesFor(rule, start, end);
    for (const date of dates) {
      const jitter = rule.variableAmount ? between(0.82, 1.24) : 1;
      transactions.push({
        id: uid('tx'),
        type: rule.kind === 'income' ? 'income' : rule.kind === 'transfer' ? 'transfer' : 'expense',
        date,
        amount: round2(rule.amount * jitter),
        accountId: rule.accountId,
        transferAccountId: rule.transferAccountId || '',
        categoryId: rule.categoryId || '',
        payee: rule.payee || rule.name,
        notes: '',
        cleared: true,
        recurringId: rule.id,
        tags: [],
        splits: [],
      });
    }
  }

  // Everyday spending.
  let cursor = start;
  while (cursor < end) {
    const perDay = rand() < 0.22 ? 0 : rand() < 0.55 ? 1 : 2;
    for (let i = 0; i < perDay; i += 1) {
      const [payee, category, lo, hi] = pick(merchants);
      const onCard = rand() < 0.55;
      transactions.push({
        id: uid('tx'),
        type: 'expense',
        date: cursor,
        amount: between(lo, hi),
        accountId: onCard ? (rand() < 0.8 ? 'demo-visa' : 'demo-store') : rand() < 0.85 ? 'demo-chk' : 'demo-cash',
        transferAccountId: '',
        categoryId: cat(category),
        payee,
        notes: '',
        cleared: cursor < addDays(end, -3),
        tags: [],
        splits: [],
      });
    }
    cursor = addDays(cursor, 1);
  }

  // Card payments are scheduled items too, with the amount following the
  // balance rather than being typed in each month.
  doc.recurring.push(
    {
      id: 'demo-visapay', name: 'Rewards Visa payment', kind: 'transfer', amount: 0,
      accountId: 'demo-chk', transferAccountId: 'demo-visa', linkedAccountId: 'demo-visa',
      amountSource: 'card-minimum', frequency: 'monthly',
      startDate: `${monthKey(start)}-26`, dayOfMonth: 26, active: true, autoPay: false,
      reminderDays: 5, weekendShift: 'before', variableAmount: true,
      notes: 'Minimum payment — pay more when you can.',
    },
    {
      id: 'demo-storepay', name: 'Store Card payment', kind: 'transfer', amount: 0,
      accountId: 'demo-chk', transferAccountId: 'demo-store', linkedAccountId: 'demo-store',
      amountSource: 'card-minimum', frequency: 'monthly',
      startDate: `${monthKey(start)}-13`, dayOfMonth: 13, active: true, autoPay: false,
      reminderDays: 5, weekendShift: 'before', variableAmount: true,
    }
  );

  // Monthly card payments, sized so utilisation lands somewhere realistic.
  for (let m = 7; m >= 0; m -= 1) {
    const base = monthKey(addMonths(end, -m));
    const visaDate = `${base}-26`;
    const storeDate = `${base}-13`;
    if (visaDate <= end) {
      transactions.push({
        id: uid('tx'), type: 'transfer', date: visaDate, amount: between(700, 1000),
        accountId: 'demo-chk', transferAccountId: 'demo-visa', categoryId: '',
        payee: 'Rewards Visa payment', notes: '', cleared: true, tags: [], splits: [],
        recurringId: 'demo-visapay',
      });
    }
    if (storeDate <= end) {
      transactions.push({
        id: uid('tx'), type: 'transfer', date: storeDate, amount: between(95, 185),
        accountId: 'demo-chk', transferAccountId: 'demo-store', categoryId: '',
        payee: 'Store Card payment', notes: '', cleared: true, tags: [], splits: [],
        recurringId: 'demo-storepay',
      });
    }
  }

  // A couple of one-off events with texture.
  transactions.push(
    {
      id: uid('tx'), type: 'income', date: addDays(end, -21), amount: 640,
      accountId: 'demo-chk', categoryId: cat('Bonus'), payee: 'Summer stipend',
      notes: 'Extra session pay', cleared: true, tags: ['extra'], splits: [],
    },
    {
      id: uid('tx'), type: 'expense', date: addDays(end, -12), amount: 418.6,
      accountId: 'demo-visa', categoryId: cat('Repairs & Maintenance'), payee: 'Midtown Auto',
      notes: 'Brakes and alignment', cleared: true, tags: ['car'], splits: [],
    },
    {
      id: uid('tx'), type: 'expense', date: addDays(end, -5), amount: 212.4,
      accountId: 'demo-chk', categoryId: cat('Groceries'), payee: 'Costco',
      notes: 'Monthly stock-up', cleared: false, tags: [],
      splits: [
        { categoryId: cat('Groceries'), amount: 168.4, notes: 'Food' },
        { categoryId: cat('Pets'), amount: 44, notes: 'Dog food' },
      ],
    }
  );

  doc.transactions = transactions.sort((a, b) => (a.date < b.date ? -1 : 1));
  doc.payees = [...new Set(transactions.map((t) => t.payee).filter(Boolean))].sort();

  /* ----------------------------- budgets -------------------------- */

  const thisMonth = monthKey(end);
  const budgetPlan = [
    ['Groceries', 650, true],
    ['Restaurants', 180, false],
    ['Coffee', 45, false],
    ['Fuel', 200, false],
    ['Electric', 160, false],
    ['Subscriptions', 60, false],
    ['Clothing', 120, true],
    ['Hobbies', 100, true],
    ['Pharmacy', 60, false],
    ['Pets', 90, false],
  ];
  doc.budgets = [];
  for (const month of [monthKey(addMonths(end, -1)), thisMonth]) {
    for (const [name, amount, rollover] of budgetPlan) {
      const id = cat(name);
      if (!id) continue;
      doc.budgets.push({ id: uid('bud'), categoryId: id, month, amount, rollover });
    }
  }

  /* ------------------------------ goals --------------------------- */

  doc.goals = [
    {
      id: uid('goal'), name: 'Emergency fund', targetAmount: 12000, targetDate: addMonths(end, 14),
      accountId: 'demo-sav', baseline: 6200, monthlyContribution: 300, color: '#1baf7a',
      notes: 'Three months of expenses', contributions: [], priority: 0,
    },
    {
      id: uid('goal'), name: 'Summer trip', targetAmount: 2800, targetDate: addMonths(end, 8),
      accountId: '', baseline: 0, monthlyContribution: 200, color: '#2a78d6',
      notes: '', priority: 1,
      contributions: [
        { id: uid('con'), amount: 200, date: addMonths(end, -3) },
        { id: uid('con'), amount: 250, date: addMonths(end, -2) },
        { id: uid('con'), amount: 200, date: addMonths(end, -1) },
      ],
    },
    {
      id: uid('goal'), name: 'New laptop', targetAmount: 1600, targetDate: addMonths(end, 5),
      accountId: '', baseline: 0, monthlyContribution: 150, color: '#4a3aa7',
      notes: '', priority: 2,
      contributions: [{ id: uid('con'), amount: 400, date: addMonths(end, -2) }],
    },
  ];

  /* ------------------------------ rules --------------------------- */

  doc.rules = [
    { id: uid('rule'), field: 'payee', op: 'contains', value: 'kroger', categoryId: cat('Groceries'), renamePayee: 'Kroger', enabled: true, priority: 0 },
    { id: uid('rule'), field: 'payee', op: 'contains', value: 'shell', categoryId: cat('Fuel'), renamePayee: 'Shell', enabled: true, priority: 1 },
    { id: uid('rule'), field: 'payee', op: 'contains', value: 'starbucks', categoryId: cat('Coffee'), renamePayee: 'Starbucks', enabled: true, priority: 2 },
  ];

  return doc;
}

/* ---------------------------- helpers ----------------------------- */

function nextWeekday(from, weekday) {
  let d = from;
  for (let i = 0; i < 7; i += 1) {
    if (dt(d).getDay() === weekday) return d;
    d = addDays(d, 1);
  }
  return from;
}

/**
 * Local copy of the recurrence walk so demo.js has no import cycle with
 * recurrence.js (which imports finance helpers in turn).
 */
function occurrencesFor(rule, from, to) {
  const out = [];
  let date = rule.startDate;
  let guard = 0;
  while (date <= to && guard < 500) {
    guard += 1;
    if (date >= from) out.push(date);
    if (rule.frequency === 'biweekly') date = addDays(date, 14);
    else if (rule.frequency === 'weekly') date = addDays(date, 7);
    else if (rule.frequency === 'semiannual') date = addMonths(date, 6);
    else if (rule.frequency === 'quarterly') date = addMonths(date, 3);
    else date = addMonths(date, 1);
  }
  return out;
}
