import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { money, fmtDate, today, startOfMonth, addMonths, addDays, startOfYear } from '../format.js';
import {
  filterTransactions, sortTransactions, withRunningBalance, accountName, categoryName,
  allBalances, clearedBalance, byId,
} from '../finance.js';
import {
  searchBox, emptyState, badge, contextMenu, confirm, select, categorySelect,
  accountSelect, toast, modal, field, dateInput,
} from '../ui.js';
import { navigate, state, commit, deleteTransactions, updateTransaction } from '../state.js';
import { page } from '../shell.js';
import { openTransactionEditor } from '../editors.js';

const PAGE = 120;

// View-local UI state survives re-renders without polluting the document.
const ui = {
  search: '',
  accountId: '',
  categoryId: '',
  type: '',
  range: 'all',
  from: '',
  to: '',
  cleared: '',
  sortKey: 'date',
  sortDir: 'desc',
  limit: PAGE,
  selected: new Set(),
};

export default function transactions(doc, params = {}) {
  if (params.accountId !== undefined && params.accountId !== ui._lastParamAccount) {
    ui.accountId = params.accountId || '';
    ui._lastParamAccount = params.accountId;
    ui.limit = PAGE;
  }
  if (params.filter === 'uncategorized') {
    ui.categoryId = '__none__';
    ui.type = 'expense';
  }
  // Deep links from elsewhere — a paid bill, a report drill-down — land here
  // with the filter already applied rather than making people retype it.
  if (params.search !== undefined && params.search !== ui._lastParamSearch) {
    ui.search = params.search || '';
    ui._lastParamSearch = params.search;
    ui.limit = PAGE;
  }
  if (params.categoryId !== undefined && params.categoryId !== ui._lastParamCategory) {
    ui.categoryId = params.categoryId || '';
    ui._lastParamCategory = params.categoryId;
    ui.limit = PAGE;
  }

  const range = rangeBounds(ui.range);
  let rows = filterTransactions(doc, {
    search: ui.search,
    accountIds: ui.accountId ? [ui.accountId] : null,
    categoryIds: ui.categoryId && ui.categoryId !== '__none__' ? [ui.categoryId] : null,
    types: ui.type ? [ui.type] : null,
    from: range.from,
    to: range.to,
    cleared: ui.cleared === '' ? undefined : ui.cleared === 'yes',
  });
  if (ui.categoryId === '__none__') rows = rows.filter((t) => !t.categoryId && t.type !== 'transfer');

  const registerMode = !!ui.accountId && ui.sortKey === 'date';
  const ordered = registerMode
    ? withRunningBalance(doc, ui.accountId, rows)
    : sortTransactions(rows, ui.sortKey, ui.sortDir);

  const totals = rows.reduce(
    (acc, t) => {
      if (t.type === 'income') acc.income += Number(t.amount) || 0;
      else if (t.type === 'expense') acc.expense += Number(t.amount) || 0;
      return acc;
    },
    { income: 0, expense: 0 }
  );

  const visible = ordered.slice(0, ui.limit);

  /* ---------------------------- toolbar -------------------------- */

  const search = searchBox({
    placeholder: 'Search payee, note or tag…',
    value: ui.search,
    onInput: (v) => {
      ui.search = v;
      ui.limit = PAGE;
      rerender();
    },
  });
  if (params.focusSearch) setTimeout(() => search.focusInput(), 40);

  const toolbar = h(
    'div.toolbar',
    null,
    search,
    accountSelect(doc, {
      value: ui.accountId,
      allowEmpty: true,
      emptyLabel: 'All accounts',
      includeArchived: true,
      onchange: (e) => {
        ui.accountId = e.target.value;
        ui.limit = PAGE;
        rerender();
      },
      style: { width: '170px' },
    }),
    select(
      [
        { value: '', label: 'All types' },
        { value: 'expense', label: 'Expenses' },
        { value: 'income', label: 'Income' },
        { value: 'transfer', label: 'Transfers' },
      ],
      {
        value: ui.type,
        onchange: (e) => {
          ui.type = e.target.value;
          rerender();
        },
        style: { width: '130px' },
      }
    ),
    select(
      [
        { value: 'all', label: 'All dates' },
        { value: 'month', label: 'This month' },
        { value: 'last-month', label: 'Last month' },
        { value: '90', label: 'Last 90 days' },
        { value: 'ytd', label: 'Year to date' },
        { value: 'year', label: 'Last 12 months' },
        { value: 'custom', label: 'Custom range…' },
      ],
      {
        value: ui.range,
        onchange: (e) => {
          // Seed the pickers from whatever was on screen, so switching to a
          // custom range starts from what you were already looking at.
          if (e.target.value === 'custom' && !ui.from) {
            const b = rangeBounds(ui.range);
            ui.from = b.from || addMonths(today(), -1);
            ui.to = b.to || today();
          }
          ui.range = e.target.value;
          ui.limit = PAGE;
          rerender();
        },
        style: { width: '150px' },
      }
    ),
    ui.range === 'custom'
      ? h(
          'div.row.gap-6',
          null,
          dateInput({
            value: ui.from || '',
            'aria-label': 'From date',
            onchange: (e) => { ui.from = e.target.value; ui.limit = PAGE; rerender(); },
          }),
          h('span.small.muted', null, 'to'),
          dateInput({
            value: ui.to || '',
            'aria-label': 'To date',
            onchange: (e) => { ui.to = e.target.value; ui.limit = PAGE; rerender(); },
          })
        )
      : null,
    select(
      [
        { value: '', label: 'Cleared: any' },
        { value: 'yes', label: 'Cleared only' },
        { value: 'no', label: 'Uncleared only' },
      ],
      {
        value: ui.cleared,
        onchange: (e) => {
          ui.cleared = e.target.value;
          rerender();
        },
        style: { width: '150px' },
      }
    ),
    (ui.search || ui.accountId || ui.categoryId || ui.type || ui.range !== 'all' || ui.cleared)
      ? h(
          'button.btn.ghost.sm',
          {
            onclick: () => {
              Object.assign(ui, { search: '', accountId: '', categoryId: '', type: '', range: 'all', from: '', to: '', cleared: '', limit: PAGE });
              rerender();
            },
          },
          icon('x', { size: 14 }),
          'Clear'
        )
      : null
  );

  /* ------------------------- bulk action bar --------------------- */

  const bulkBar = ui.selected.size
    ? h(
        'div.toolbar',
        { style: { background: 'var(--accent-soft)', borderColor: 'transparent' } },
        h('span.strong', null, `${ui.selected.size} selected`),
        h('div.grow'),
        h('button.btn.sm', { onclick: () => bulkCategorise(doc) }, icon('tag', { size: 14 }), 'Categorise'),
        h('button.btn.sm', { onclick: () => bulkCleared(true) }, icon('check', { size: 14 }), 'Mark cleared'),
        h('button.btn.sm', { onclick: () => bulkCleared(false) }, 'Mark uncleared'),
        h(
          'button.btn.sm.danger-soft',
          {
            onclick: async () => {
              const ids = [...ui.selected];
              if (
                await confirm({
                  title: `Delete ${ids.length} transactions?`,
                  confirmLabel: 'Delete',
                  tone: 'danger',
                })
              ) {
                deleteTransactions(ids);
                ui.selected.clear();
              }
            },
          },
          icon('trash', { size: 14 }),
          'Delete'
        ),
        h('button.btn.ghost.sm', { onclick: () => { ui.selected.clear(); rerender(); } }, 'Cancel')
      )
    : null;

  /* ---------------------------- table ---------------------------- */

  const allChecked = visible.length > 0 && visible.every((t) => ui.selected.has(t.id));

  const table = h(
    'table.table.clickable',
    null,
    h(
      'thead',
      null,
      h(
        'tr',
        null,
        h(
          'th',
          { style: { width: '34px' } },
          h('input', {
            type: 'checkbox',
            checked: allChecked,
            onclick: (e) => {
              e.stopPropagation();
              if (e.target.checked) visible.forEach((t) => ui.selected.add(t.id));
              else visible.forEach((t) => ui.selected.delete(t.id));
              rerender();
            },
          })
        ),
        sortHeader('Date', 'date'),
        sortHeader('Payee', 'payee'),
        h('th', null, 'Category'),
        h('th', null, 'Account'),
        sortHeader('Amount', 'amount', 'num'),
        registerMode ? h('th.num', null, 'Balance') : null,
        h('th', { style: { width: '44px' } }, '')
      )
    ),
    h(
      'tbody',
      null,
      ...visible.map((t) => row(doc, t, registerMode))
    )
  );

  const body = ordered.length
    ? h(
        'div.card',
        null,
        h('div.tablewrap', null, table),
        ordered.length > visible.length
          ? h(
              'div.card-foot.center',
              null,
              h(
                'button.btn.sm',
                {
                  onclick: () => {
                    ui.limit += PAGE * 2;
                    rerender();
                  },
                },
                `Show more (${ordered.length - visible.length} remaining)`
              )
            )
          : null
      )
    : emptyState({
        icon: 'receipt',
        title: 'No transactions match',
        message: 'Try widening the filters, or add a transaction.',
        action: { label: 'Add transaction', onClick: () => openTransactionEditor({ accountId: ui.accountId }) },
      });

  const summaryStrip = h(
    'div.row.wrap.gap-16.small.muted',
    null,
    h('span', null, `${ordered.length} transaction${ordered.length === 1 ? '' : 's'}`),
    h('span.pos.strong', null, `+${money(totals.income)}`),
    h('span.neg.strong', null, `−${money(totals.expense)}`),
    h(
      'span.strong',
      { class: totals.income - totals.expense >= 0 ? 'pos' : 'neg' },
      `Net ${money(totals.income - totals.expense, { sign: true })}`
    ),
    ui.accountId
      ? h(
          'span',
          null,
          `· Balance ${money(allBalances(doc).get(ui.accountId) || 0)} · Cleared ${money(clearedBalance(doc, ui.accountId))}`
        )
      : null
  );

  return page({
    title: ui.accountId ? accountName(doc, ui.accountId) : 'Transactions',
    subtitle: ui.accountId ? 'Account register' : 'Everything you have recorded',
    actions: [
      h(
        'button.btn',
        { onclick: () => import('../importer.js').then((m) => m.openImporter(ui.accountId)) },
        icon('upload', { size: 15 }),
        'Import'
      ),
      h(
        'button.btn',
        { onclick: () => import('../exporter.js').then((m) => m.exportTransactionsCsv(ordered)) },
        icon('download', { size: 15 }),
        'Export'
      ),
      h(
        'button.btn.primary',
        { onclick: () => openTransactionEditor(null, ui.accountId ? { accountId: ui.accountId } : {}) },
        icon('plus', { size: 15 }),
        'Add'
      ),
    ],
    children: [toolbar, bulkBar, summaryStrip, body],
  });

  /* --------------------------- helpers --------------------------- */

  function rerender() {
    navigate('transactions', { ...params, focusSearch: null });
  }

  function sortHeader(label, key, cls = '') {
    return h(
      `th.sortable${cls ? `.${cls}` : ''}`,
      {
        onclick: () => {
          if (ui.sortKey === key) ui.sortDir = ui.sortDir === 'asc' ? 'desc' : 'asc';
          else {
            ui.sortKey = key;
            ui.sortDir = 'desc';
          }
          rerender();
        },
      },
      label,
      h('span.sort', null, ui.sortKey === key ? (ui.sortDir === 'asc' ? ' ↑' : ' ↓') : '')
    );
  }

  function row(document_, t, showBalance) {
    const isIncome = t.type === 'income';
    const isTransfer = t.type === 'transfer';
    return h(
      `tr${ui.selected.has(t.id) ? '.selected' : ''}`,
      {
        onclick: (e) => {
          if (e.target.closest('input,button')) return;
          openTransactionEditor(t);
        },
        oncontextmenu: (e) => rowMenu(e, document_, t),
      },
      h(
        'td',
        null,
        h('input', {
          type: 'checkbox',
          checked: ui.selected.has(t.id),
          onclick: (e) => {
            e.stopPropagation();
            if (e.target.checked) ui.selected.add(t.id);
            else ui.selected.delete(t.id);
            rerender();
          },
        })
      ),
      h('td.nowrap', null, fmtDate(t.date)),
      h(
        'td',
        null,
        h('div.row.gap-6', null,
          t.cleared ? h('span', { title: 'Cleared', style: { color: 'var(--st-good)', display: 'flex' } }, icon('check', { size: 13, stroke: 3 })) : null,
          h('span.truncate', null, t.payee || (isTransfer ? 'Transfer' : '—'))
        ),
        t.notes ? h('div.tiny.dim.truncate', null, t.notes) : null
      ),
      h(
        'td',
        null,
        isTransfer
          ? h('span.badge', null, '↔ Transfer')
          : (t.splits && t.splits.length)
            ? h('span.badge.accent', null, `${t.splits.length} splits`)
            : h('span.truncate', null, categoryName(document_, t.categoryId))
      ),
      h(
        'td.truncate',
        null,
        isTransfer
          ? `${accountName(document_, t.accountId)} → ${accountName(document_, t.transferAccountId)}`
          : accountName(document_, t.accountId)
      ),
      h(
        'td.num.money-mask',
        { class: isIncome ? 'pos' : isTransfer ? 'dim' : '' },
        `${isIncome ? '+' : isTransfer ? '' : '−'}${money(t.amount)}`
      ),
      showBalance
        ? h('td.num.money-mask', { class: t._balance < 0 ? 'neg' : '' }, money(t._balance))
        : null,
      h(
        'td',
        null,
        h(
          'div.rowactions',
          null,
          h(
            'button.btn.ghost.icon.sm',
            { onclick: (e) => { e.stopPropagation(); rowMenu(e, document_, t); } },
            icon('more', { size: 15 })
          )
        )
      )
    );
  }

  function rowMenu(e, document_, t) {
    contextMenu(e, [
      { label: 'Edit', icon: 'edit', onClick: () => openTransactionEditor(t) },
      {
        label: t.cleared ? 'Mark uncleared' : 'Mark cleared',
        icon: 'check',
        onClick: () => updateTransaction(t.id, { cleared: !t.cleared }),
      },
      {
        label: 'Duplicate',
        icon: 'copy',
        onClick: () => openTransactionEditor(null, { ...t, id: undefined, date: today() }),
      },
      { separator: true },
      {
        label: 'Delete',
        icon: 'trash',
        danger: true,
        onClick: async () => {
          if (await confirm({ title: 'Delete transaction?', confirmLabel: 'Delete', tone: 'danger' })) {
            deleteTransactions([t.id]);
          }
        },
      },
    ]);
  }

  function bulkCleared(value) {
    const ids = [...ui.selected];
    commit(`Mark ${ids.length} ${value ? 'cleared' : 'uncleared'}`, (d) => {
      for (const t of d.transactions) if (ui.selected.has(t.id)) t.cleared = value;
    });
    ui.selected.clear();
  }

  function bulkCategorise(document_) {
    const sel = categorySelect(document_, { kind: 'expense', allowEmpty: false });
    const m = modal({
      title: `Categorise ${ui.selected.size} transactions`,
      size: 'sm',
      body: field('Category', sel),
      footer: [
        h('button.btn', { onclick: () => m.close() }, 'Cancel'),
        h(
          'button.btn.primary',
          {
            onclick: () => {
              const categoryId = sel.value;
              commit('Bulk categorise', (d) => {
                for (const t of d.transactions) if (ui.selected.has(t.id)) t.categoryId = categoryId;
              });
              ui.selected.clear();
              m.close();
              toast('Categories updated');
            },
          },
          'Apply'
        ),
      ],
    });
  }
}

function rangeBounds(key) {
  const now = today();
  switch (key) {
    case 'custom': {
      const from = ui.from || null;
      const to = ui.to || null;
      // Tolerate the dates being the wrong way round rather than showing
      // nothing and looking broken.
      if (from && to && from > to) return { from: to, to: from };
      return { from, to };
    }
    case 'month':
      return { from: startOfMonth(now), to: null };
    case 'last-month': {
      const prev = addMonths(now, -1);
      return { from: startOfMonth(prev), to: addDays(startOfMonth(now), -1) };
    }
    case '90':
      return { from: addDays(now, -90), to: null };
    case 'ytd':
      return { from: startOfYear(now), to: null };
    case 'year':
      return { from: addMonths(now, -12), to: null };
    default:
      return { from: null, to: null };
  }
}
