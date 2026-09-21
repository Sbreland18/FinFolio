import { h } from '../dom.js';
import { icon } from '../icons.js';
import {
  money, pct, fmtDate, today, addMonths, addDays, diffDays, startOfMonth, endOfMonth, startOfYear,
  monthKey, monthLabel, num, round2,
} from '../format.js';
import {
  monthlyTotals, categoryTotals, payeeTotals, filterTransactions, categoryName,
  accountName, allBalances, netWorthSeries, spendingSeries, projectFromSeries,
  categoryFamily, byId,
} from '../finance.js';
import { barChart, lineChart, rankedBars } from '../charts.js';
import { statTile, segmented, emptyState, select, badge, modal, dateInput } from '../ui.js';
import { navigate, state } from '../state.js';
import { page } from '../shell.js';
import { openTransactionEditor } from '../editors.js';

const ui = { range: '12m', kind: 'expense', from: '', to: '', accountId: '' };

export default function reports(doc, params = {}) {
  const bounds = rangeBounds(ui.range);
  const monthsBack = monthsIn(ui.range);
  // An empty filter means every account; one id narrows the whole screen.
  const accountIds = ui.accountId ? [ui.accountId] : null;
  const scope = { ...bounds, accountIds };
  const months = monthsInRange(doc, scope);

  const income = round2(months.reduce((s, m) => s + m.income, 0));
  const expense = round2(months.reduce((s, m) => s + m.expense, 0));
  const net = round2(income - expense);
  const savingsRate = income > 0 ? (net / income) * 100 : 0;
  const avgSpend = months.length ? round2(expense / months.length) : 0;

  if (!(doc.transactions || []).length) {
    return page({
      title: 'Reports',
      children: [
        emptyState({
          icon: 'trending',
          title: 'No data to report on yet',
          message: 'Record or import some transactions and the analysis appears here automatically.',
        }),
      ],
    });
  }

  /* ---------------------------- charts --------------------------- */

  const flowHost = h('div.chart-wrap');
  requestAnimationFrame(() =>
    barChart(flowHost, {
      height: 260,
      labels: months.map((m) => m.key),
      series: [
        { name: 'Income', values: months.map((m) => m.income), color: 'var(--s3)' },
        { name: 'Spending', values: months.map((m) => m.expense), color: 'var(--s2)' },
      ],
      yFormat: (v) => money(v, { cents: false, compact: true }),
      xFormat: (k, _i, full) => (full ? monthLabel(k, { long: true }) : monthLabel(k).split(' ')[0]),
      ariaLabel: 'Income and spending by month',
    })
  );

  const netHost = h('div.chart-wrap');
  requestAnimationFrame(() =>
    barChart(netHost, {
      height: 200,
      labels: months.map((m) => m.key),
      series: [{ name: 'Net', values: months.map((m) => m.net), color: 'var(--s1)' }],
      yFormat: (v) => money(v, { cents: false, compact: true }),
      xFormat: (k, _i, full) => (full ? monthLabel(k, { long: true }) : monthLabel(k).split(' ')[0]),
      ariaLabel: 'Net saved or overspent by month',
      tableView: false,
    })
  );

  const cats = categoryTotals(doc, { ...scope, kind: ui.kind, rollUp: true });
  const catTotal = round2(cats.reduce((s, c) => s + c.amount, 0));
  const catHost = h('div.chart-wrap');
  requestAnimationFrame(() =>
    rankedBars(catHost, {
      items: cats.slice(0, 14).map((c) => ({
        label: c.name,
        value: c.amount,
        id: c.categoryId,
        sub: catTotal ? `${((c.amount / catTotal) * 100).toFixed(1)}%` : null,
      })),
      valueFormat: (v) => money(v, { cents: false }),
      ariaLabel: 'Totals by category',
      onSelect: (item) =>
        openDrilldown(doc, { title: item.label, categoryId: item.id, kind: ui.kind, bounds: scope }),
    })
  );

  const payees = payeeTotals(doc, { ...scope, limit: 10 });
  const payeeHost = h('div.chart-wrap');
  requestAnimationFrame(() =>
    rankedBars(payeeHost, {
      items: payees.map((p) => ({ label: p.payee, value: p.amount })),
      valueFormat: (v) => money(v, { cents: false }),
      ariaLabel: 'Top payees',
      onSelect: (item) =>
        openDrilldown(doc, { title: item.label, payee: item.label, kind: 'expense', bounds: scope }),
    })
  );

  /* ------------------------- monthly table ----------------------- */

  const table = h(
    'div.card',
    null,
    h(
      'div.card-head',
      null,
      h('div.h2', null, 'Month by month'),
      h(
        'button.linkbtn.small',
        { onclick: () => import('../exporter.js').then((m) => m.exportSummaryCsv(months)) },
        'Export CSV'
      )
    ),
    h(
      'div.tablewrap',
      null,
      h(
        'table.table.clickable',
        null,
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', null, 'Month'),
            h('th.num', null, 'Income'),
            h('th.num', null, 'Spending'),
            h('th.num', null, 'Net'),
            h('th.num', null, 'Savings rate')
          )
        ),
        h(
          'tbody',
          null,
          ...[...months].reverse().map((m) =>
            h(
              'tr',
              {
                title: 'See this month’s transactions',
                onclick: () =>
                  openDrilldown(doc, {
                    title: monthLabel(m.key, { long: true }),
                    month: m.key,
                    kind: ui.kind,
                    bounds: scope,
                  }),
              },
              h('td', null, monthLabel(m.key, { long: true })),
              h('td.num.pos.money-mask', null, money(m.income)),
              h('td.num.money-mask', null, money(m.expense)),
              h('td.num.money-mask', { class: m.net >= 0 ? 'pos' : 'neg' }, money(m.net, { sign: true })),
              h('td.num', null, m.income > 0 ? pct((m.net / m.income) * 100, 0) : '—')
            )
          ),
          h(
            'tr',
            { style: { fontWeight: '650', background: 'var(--surface-2)' } },
            h('td', null, 'Total'),
            h('td.num.pos.money-mask', null, money(income)),
            h('td.num.money-mask', null, money(expense)),
            h('td.num.money-mask', { class: net >= 0 ? 'pos' : 'neg' }, money(net, { sign: true })),
            h('td.num', null, income > 0 ? pct(savingsRate, 0) : '—')
          )
        )
      )
    )
  );

  /* --------------------------- category table -------------------- */

  const catTable = h(
    'div.card',
    null,
    h(
      'div.card-head',
      null,
      h('div.h2', null, ui.kind === 'income' ? 'Income sources' : 'Spending by category'),
      segmented(
        [
          { value: 'expense', label: 'Spending' },
          { value: 'income', label: 'Income' },
        ],
        ui.kind,
        (v) => {
          ui.kind = v;
          navigate('reports', params);
        }
      )
    ),
    h('div.card-body', null, cats.length ? catHost : h('p.muted.small', null, 'Nothing recorded in this period.')),
    cats.length
      ? h(
          'div.card-foot',
          null,
          h(
            'div.row.wrap.gap-16.small.muted',
            null,
            h('span', null, `${cats.length} categories`),
            h('span.strong', null, `Total ${money(catTotal)}`),
            h('span', null, `Average per month ${money(catTotal / Math.max(1, monthsBack))}`)
          )
        )
      : null
  );

  return page({
    title: 'Reports',
    subtitle: ui.accountId
      ? `${accountName(doc, ui.accountId)} · ${fmtDate(bounds.from, 'medium')} – ${fmtDate(bounds.to || today(), 'medium')}`
      : `${fmtDate(bounds.from, 'medium')} – ${fmtDate(bounds.to || today(), 'medium')}`,
    actions: [
      segmented(
        [
          { value: '3m', label: '3 months' },
          { value: '6m', label: '6 months' },
          { value: '12m', label: '12 months' },
          { value: 'ytd', label: 'Year to date' },
          { value: '24m', label: '2 years' },
          { value: 'custom', label: 'Custom' },
        ],
        ui.range,
        (v) => {
          if (v === 'custom' && !ui.from) {
            ui.from = bounds.from;
            ui.to = bounds.to;
          }
          ui.range = v;
          navigate('reports', params);
        }
      ),
      ui.range === 'custom' ? customRange(params, bounds) : null,
      accountFilter(doc, params),
      h(
        'button.btn',
        { onclick: () => window.print() },
        icon('print', { size: 15 }),
        'Print'
      ),
    ],
    children: [
      h(
        'div.kpi-grid',
        null,
        statTile({ label: 'Total income', value: money(income), tone: 'pos' }),
        statTile({ label: 'Total spending', value: money(expense) }),
        statTile({ label: 'Net saved', value: money(net, { sign: true }), tone: net >= 0 ? 'pos' : 'neg' }),
        statTile({
          label: 'Savings rate',
          value: income > 0 ? pct(savingsRate, 1) : '—',
          sub: `avg spend ${money(avgSpend, { cents: false })}/mo`,
          tone: savingsRate >= 20 ? 'pos' : savingsRate < 0 ? 'neg' : '',
        })
      ),
      h(
        'div.card',
        null,
        h('div.card-head', null, h('div.h2', null, 'Income vs spending')),
        h('div.card-body', null, flowHost)
      ),
      h(
        'div.split',
        null,
        catTable,
        h(
          'div.col.gap-16',
          null,
          h(
            'div.card',
            null,
            h('div.card-head', null, h('div.h3', null, 'Net each month')),
            h('div.card-body', null, netHost)
          ),
          h(
            'div.card',
            null,
            h('div.card-head', null, h('div.h3', null, 'Top payees')),
            h('div.card-body', null, payees.length ? payeeHost : h('p.muted.small', null, 'No payees recorded.'))
          )
        )
      ),
      table,
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Drill-down                                                          */
/*                                                                     */
/* A total on its own invites the question "made of what?", and until  */
/* now the only answer was to go and filter the register by hand.      */
/* ------------------------------------------------------------------ */

/**
 * @param {{title:string, categoryId?:string, payee?:string, month?:string,
 *          kind?:string, bounds:object}} spec
 */
export function openDrilldown(doc, spec) {
  const kind = spec.kind || 'expense';
  const scoped = spec.month
    ? { from: startOfMonth(`${spec.month}-01`), to: endOfMonth(`${spec.month}-01`) }
    : spec.bounds;

  // Drilling into a parent means the family: "Pets" includes its food, toys
  // and vet bills, which is what the total on the chart already said.
  const family = spec.categoryId ? categoryFamily(doc, spec.categoryId) : null;
  const rows = filterTransactions(doc, {
    from: scoped.from,
    to: scoped.to,
    types: spec.month ? null : [kind],
    categoryIds: family,
    accountIds: spec.bounds && spec.bounds.accountIds ? spec.bounds.accountIds : null,
    search: spec.payee || '',
  }).filter((t) => (spec.payee ? String(t.payee || '').trim().toLowerCase() === spec.payee.toLowerCase() : true));

  const total = round2(rows.filter((t) => t.type === kind).reduce((s, t) => s + (Number(t.amount) || 0), 0));

  // History always looks back 12 months from the end of the window, whatever
  // the window is — a projection from three months of data is worth little.
  const series = spendingSeries(doc, {
    categoryId: spec.categoryId || null,
    payee: spec.payee || null,
    months: 12,
    to: scoped.to,
    kind,
    accountIds: spec.bounds && spec.bounds.accountIds ? spec.bounds.accountIds : null,
  });
  const outlook = projectFromSeries(series);

  // When the drill-down is a parent, show what its children contribute.
  const kids = spec.categoryId
    ? (categoryTotals(doc, { from: scoped.from, to: scoped.to, kind, accountIds: spec.bounds && spec.bounds.accountIds })
        .filter((r) => {
          const c = byId(doc.categories, r.categoryId);
          return c && c.parentId === spec.categoryId;
        }))
    : [];

  const chartHost = h('div.chart-wrap');
  requestAnimationFrame(() =>
    barChart(chartHost, {
      height: 180,
      labels: series.map((s) => s.key),
      series: [{ name: 'Spending', values: series.map((s) => s.amount), color: 'var(--s2)' }],
      yFormat: (v) => money(v, { cents: false, compact: true }),
      xFormat: (k, _i, full) => (full ? monthLabel(k, { long: true }) : monthLabel(k).split(' ')[0]),
      ariaLabel: `${spec.title} by month`,
      tableView: false,
    })
  );

  const m = modal({
    title: spec.title,
    subtitle: `${fmtDate(scoped.from, 'medium')} – ${fmtDate(scoped.to, 'medium')}`,
    size: 'lg',
    body: h(
      'div.col.gap-16',
      null,
      h(
        'div.kpi-grid',
        null,
        statTile({ label: 'In this period', value: money(total), sub: `${rows.length} transactions` }),
        statTile({
          label: 'Average a month',
          value: money(outlook.average),
          sub: `over ${outlook.months} month${outlook.months === 1 ? '' : 's'}`,
        }),
        statTile({
          label: 'Next month, projected',
          value: outlook.confident ? money(outlook.projected) : '—',
          sub: outlook.confident
            ? outlook.trendPerMonth > 0.5
              ? `rising about ${money(outlook.trendPerMonth)}/mo`
              : outlook.trendPerMonth < -0.5
                ? `falling about ${money(Math.abs(outlook.trendPerMonth))}/mo`
                : 'holding steady'
            : 'needs a few more months',
          tone: outlook.trendPerMonth > 0.5 ? 'neg' : outlook.trendPerMonth < -0.5 ? 'pos' : '',
        })
      ),
      h(
        'div.card',
        null,
        h('div.card-head', null, h('div.h3', null, 'Last 12 months')),
        h('div.card-body', null, chartHost)
      ),
      kids.length
        ? h(
            'div.card',
            null,
            h('div.card-head', null, h('div.h3', null, 'Sub-categories')),
            h(
              'div.card-body.flush',
              null,
              ...kids.map((k) =>
                h(
                  'div.list-row',
                  {
                    onclick: () => {
                      m.close();
                      openDrilldown(doc, { ...spec, title: k.name, categoryId: k.categoryId });
                    },
                  },
                  h('div.avatar', null, (byId(doc.categories, k.categoryId) || {}).icon || '•'),
                  h('div.l-main', null, h('div.l-title', null, k.name)),
                  h('div.l-amount.money-mask', null, money(k.amount))
                )
              )
            )
          )
        : null,
      rows.length
        ? h(
            'div.card',
            null,
            h(
              'div.card-head',
              null,
              h('div.h3', null, 'Transactions'),
              h('span.dim.small', null, `${rows.length}`)
            ),
            h(
              'div.scrollbox',
              null,
              h(
                'table.table.clickable',
                null,
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', null, 'Date'),
                    h('th', null, 'Payee'),
                    h('th', null, 'Category'),
                    h('th', null, 'Account'),
                    h('th.num', null, 'Amount')
                  )
                ),
                h(
                  'tbody',
                  null,
                  ...rows.slice(0, 400).map((t) =>
                    h(
                      'tr',
                      { onclick: () => { m.close(); openTransactionEditor(t); } },
                      h('td.nowrap', null, fmtDate(t.date)),
                      h('td.truncate', null, t.payee || '—'),
                      h('td.truncate', null, categoryName(doc, t.categoryId)),
                      h('td.truncate', null, accountName(doc, t.accountId)),
                      h(
                        'td.num.money-mask',
                        { class: t.type === 'income' ? 'pos' : '' },
                        money(Number(t.amount) || 0)
                      )
                    )
                  )
                )
              )
            ),
            rows.length > 400
              ? h('div.card-foot.small.muted', null, `Showing the first 400 of ${rows.length}.`)
              : null
          )
        : h('p.muted.small', null, 'Nothing recorded in this period.'),
      h(
        'p.tiny.dim',
        null,
        'The projection is the trend across the last 12 months, not a promise — one unusual ' +
          'month moves it, and it cannot know about anything that has not happened before.'
      )
    ),
    footer: [
      h('button.btn', { onclick: () => m.close() }, 'Close'),
      h(
        'button.btn.primary',
        {
          onclick: () => {
            m.close();
            navigate('transactions', {
              search: spec.payee || '',
              categoryId: spec.categoryId || '',
            });
          },
        },
        'Open in Transactions'
      ),
    ],
  });
}

function accountFilter(doc, params) {
  const live = (doc.accounts || []).filter((a) => !a.archived);
  if (live.length < 2) return null;
  const sel = select(
    [
      { value: '', label: 'All accounts' },
      ...live.map((a) => ({ value: a.id, label: a.name })),
    ],
    {
      value: ui.accountId,
      onchange: (e) => {
        ui.accountId = e.target.value;
        navigate('reports', params);
      },
    }
  );
  return sel;
}

function customRange(params, bounds) {
  const fromI = dateInput({ value: ui.from || bounds.from });
  const toI = dateInput({ value: ui.to || bounds.to });
  const apply = () => {
    ui.from = fromI.value || bounds.from;
    ui.to = toI.value || bounds.to;
    navigate('reports', params);
  };
  fromI.addEventListener('change', apply);
  toI.addEventListener('change', apply);
  return h(
    'div.row.gap-6',
    null,
    h('span.small.muted', null, 'From'),
    fromI,
    h('span.small.muted', null, 'to'),
    toI
  );
}

function monthsIn(range) {
  if (range === 'custom') {
    const b = rangeBounds('custom');
    return Math.max(1, Math.round(diffDays(b.from, b.to) / 30.44) + 1);
  }
  return { '3m': 3, '6m': 6, '12m': 12, '24m': 24, ytd: new Date().getMonth() + 1 }[range] || 12;
}

function rangeBounds(range) {
  const now = today();
  if (range === 'custom') {
    const from = ui.from || startOfMonth(addMonths(now, -11));
    const to = ui.to || now;
    return from <= to ? { from, to } : { from: to, to: from };
  }
  if (range === 'ytd') return { from: startOfYear(now), to: now };
  const m = monthsIn(range);
  return { from: startOfMonth(addMonths(now, -(m - 1))), to: now };
}

/**
 * Month buckets across an arbitrary range.
 *
 * `monthlyTotals(doc, n)` only ever counts back from today, which cannot
 * express "March to June". Everything on this screen now works from bounds so
 * a custom range is a first-class option rather than a bolted-on filter.
 */
function monthsInRange(doc, bounds) {
  const accSet = bounds.accountIds && bounds.accountIds.length ? new Set(bounds.accountIds) : null;
  const keys = [];
  let cursor = startOfMonth(bounds.from);
  const last = monthKey(bounds.to);
  let guard = 0;
  while (monthKey(cursor) <= last && guard < 400) {
    keys.push(monthKey(cursor));
    cursor = addMonths(cursor, 1);
    guard += 1;
  }
  const index = new Map(keys.map((k) => [k, { key: k, income: 0, expense: 0, net: 0 }]));
  for (const t of doc.transactions || []) {
    if (t.date < bounds.from || t.date > bounds.to) continue;
    if (t.type === 'transfer') continue;
    if (accSet && !accSet.has(t.accountId)) continue;
    const bucket = index.get(monthKey(t.date));
    if (!bucket) continue;
    const amount = Number(t.amount) || 0;
    if (t.type === 'income') bucket.income = round2(bucket.income + amount);
    else bucket.expense = round2(bucket.expense + amount);
  }
  for (const b of index.values()) b.net = round2(b.income - b.expense);
  return keys.map((k) => index.get(k));
}
