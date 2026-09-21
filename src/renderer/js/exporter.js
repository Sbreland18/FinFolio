/** CSV exports. */

import { toCSV } from './parsers.js';
import { accountName, categoryName, sortTransactions } from './finance.js';
import { today, monthLabel } from './format.js';
import { state } from './state.js';
import { toastOk, toastErr } from './ui.js';

const api = window.finfolio;

export async function exportTransactionsCsv(list = null) {
  const doc = state.doc;
  const rows = sortTransactions(list || doc.transactions || [], 'date', 'asc');
  if (!rows.length) {
    toastErr('There are no transactions to export.');
    return;
  }

  const out = [
    ['Date', 'Type', 'Payee', 'Category', 'Account', 'To account', 'Amount', 'Signed amount', 'Cleared', 'Tags', 'Notes'],
    ...rows.map((t) => {
      const signed =
        t.type === 'income' ? Number(t.amount) : t.type === 'expense' ? -Number(t.amount) : -Number(t.amount);
      return [
        t.date,
        t.type,
        t.payee || '',
        t.type === 'transfer' ? 'Transfer' : categoryName(doc, t.categoryId),
        accountName(doc, t.accountId),
        t.type === 'transfer' ? accountName(doc, t.transferAccountId) : '',
        Number(t.amount).toFixed(2),
        signed.toFixed(2),
        t.cleared ? 'yes' : 'no',
        (t.tags || []).join(' '),
        t.notes || '',
      ];
    }),
  ];

  const res = await api.files.saveText({
    title: 'Export transactions',
    defaultName: `FinFolio-Transactions-${today()}.csv`,
    content: toCSV(out),
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (res.ok) toastOk(`Exported ${rows.length} transactions`);
  else if (res.error !== 'CANCELED') toastErr(`Export failed (${res.error})`);
}

export async function exportSummaryCsv(months) {
  const out = [
    ['Month', 'Income', 'Spending', 'Net', 'Savings rate %'],
    ...months.map((m) => [
      monthLabel(m.key, { long: true }),
      m.income.toFixed(2),
      m.expense.toFixed(2),
      m.net.toFixed(2),
      m.income > 0 ? ((m.net / m.income) * 100).toFixed(1) : '',
    ]),
  ];
  const res = await api.files.saveText({
    title: 'Export monthly summary',
    defaultName: `FinFolio-Summary-${today()}.csv`,
    content: toCSV(out),
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (res.ok) toastOk('Summary exported');
  else if (res.error !== 'CANCELED') toastErr(`Export failed (${res.error})`);
}

export async function exportAccountsCsv() {
  const doc = state.doc;
  const { allBalances } = await import('./finance.js');
  const balances = allBalances(doc);
  const out = [
    ['Account', 'Type', 'Institution', 'Balance', 'Credit limit', 'APR', 'Archived'],
    ...(doc.accounts || []).map((a) => [
      a.name,
      a.type,
      a.institution || '',
      (balances.get(a.id) || 0).toFixed(2),
      a.creditLimit ? Number(a.creditLimit).toFixed(2) : '',
      a.apr || '',
      a.archived ? 'yes' : 'no',
    ]),
  ];
  const res = await api.files.saveText({
    title: 'Export accounts',
    defaultName: `FinFolio-Accounts-${today()}.csv`,
    content: toCSV(out),
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (res.ok) toastOk('Accounts exported');
}
