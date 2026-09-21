import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { money, fmtDate, today, addMonths, monthKey, startOfMonth, endOfMonth, monthLabel, relativeDay } from '../format.js';
import {
  cashOnHand, netWorth, monthlyTotals, upcomingItems, forecast, categoryTotals,
  insights, allBalances, accountName, categoryName, sortTransactions, isLiability,
} from '../finance.js';
import { lineChart, barChart, rankedBars, sparkline, seriesColor } from '../charts.js';
import { statTile, deltaBadge, emptyState, badge } from '../ui.js';
import { navigate, state } from '../state.js';
import { page } from '../shell.js';
import { openTransactionEditor, openAccountEditor, markOccurrencePaid } from '../editors.js';

export default function dashboard(doc) {
  const s = doc.settings || {};
  const hasData = (doc.accounts || []).length > 0;

  if (!hasData) {
    return page({
      title: 'Dashboard',
      children: [
        emptyState({
          icon: 'wallet',
          title: 'Add your first account',
          message: 'Once an account exists, FinFolio starts tracking balances, bills and forecasts automatically.',
          action: { label: 'Add an account', onClick: () => openAccountEditor() },
        }),
        h(
          'div.center',
          null,
          h(
            'button.linkbtn.small',
            { onclick: loadSampleData },
            'Or explore with sample data first'
          )
        ),
      ],
    });
  }

  const cash = cashOnHand(doc);
  const nw = netWorth(doc);
  const nwLastMonth = netWorth(doc, endOfMonth(addMonths(today(), -1)));
  const months = monthlyTotals(doc, 7);
  const thisMonth = months[months.length - 1];
  const prevMonth = months[months.length - 2] || { expense: 0, income: 0 };
  const windowDays = Number(s.upcomingWindowDays) || 14;
  const upcoming = upcomingItems(doc, { days: windowDays });
  const upcomingTotal = upcoming
    .filter((u) => u.kind !== 'income')
    .reduce((sum, u) => sum + u.amount, 0);
  const fc = forecast(doc, { days: Number(s.forecastDays) || 90 });
  const notes = insights(doc);

  /* ----------------------------- KPIs ---------------------------- */

  const kpis = h(
    'div.kpi-grid',
    null,
    statTile({
      label: 'Cash on hand',
      value: money(cash),
      sub: `across ${(doc.accounts || []).filter((a) => !a.archived && !isLiability(a.type)).length} accounts`,
      tone: cash < 0 ? 'neg' : '',
    }),
    statTile({
      label: 'Net worth',
      value: money(nw.net),
      sub: `${money(nw.assets, { cents: false })} assets · ${money(nw.debt, { cents: false })} debt`,
      delta: deltaBadge(nw.net - nwLastMonth.net),
      tone: nw.net < 0 ? 'neg' : '',
    }),
    statTile({
      label: `Spent in ${monthLabel(monthKey(today()))}`,
      value: money(thisMonth.expense),
      sub: `${money(thisMonth.income)} received`,
      delta: deltaBadge(thisMonth.expense - prevMonth.expense, { invert: true }),
    }),
    statTile({
      label: `Due in ${windowDays} days`,
      value: money(upcomingTotal),
      sub: `${upcoming.length} scheduled item${upcoming.length === 1 ? '' : 's'}`,
      tone: upcoming.some((u) => u.overdue) ? 'neg' : '',
    })
  );

  /* --------------------------- insights -------------------------- */

  const insightCards = notes.length
    ? h(
        'div.grid.grid-auto',
        null,
        ...notes.slice(0, 4).map((n) =>
          h(
            'div.card.pad.hoverable',
            {
              style: { cursor: n.action ? 'pointer' : 'default' },
              onclick: () => n.action && navigate(n.action.view, n.action),
            },
            h(
              'div.row',
              null,
              h(
                'span',
                { style: { color: toneColor(n.tone), display: 'flex' } },
                icon(n.tone === 'info' ? 'info' : 'alert', { size: 17 })
              ),
              h('div.strong', null, n.title)
            ),
            h('p.muted.small.mt-4', null, n.body)
          )
        )
      )
    : null;

  /* ---------------------------- charts --------------------------- */

  const cashflowHost = h('div.chart-wrap');
  requestAnimationFrame(() =>
    barChart(cashflowHost, {
      height: 240,
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

  const forecastHost = h('div.chart-wrap');
  requestAnimationFrame(() =>
    lineChart(forecastHost, {
      height: 240,
      labels: fc.series.map((p) => p.date),
      series: [{ name: 'Projected balance', values: fc.series.map((p) => p.balance), color: 'var(--s1)' }],
      yFormat: (v) => money(v, { cents: false, compact: true }),
      xFormat: (d, _i, full) => (full ? fmtDate(d, 'weekday') : fmtDate(d, 'day')),
      tipFormat: (v) => money(v),
      threshold:
        Number(s.lowBalanceThreshold) > 0
          ? { value: Number(s.lowBalanceThreshold), label: 'Low balance' }
          : null,
      ariaLabel: 'Projected spendable balance',
    })
  );

  const spendCats = categoryTotals(doc, {
    from: startOfMonth(today()),
    to: endOfMonth(today()),
    kind: 'expense',
  }).slice(0, 7);
  const catHost = h('div.chart-wrap');
  const catTotal = spendCats.reduce((sum, c) => sum + c.amount, 0);
  requestAnimationFrame(() =>
    rankedBars(catHost, {
      items: spendCats.map((c) => ({
        label: c.name,
        value: c.amount,
        sub: catTotal ? `${((c.amount / catTotal) * 100).toFixed(0)}%` : null,
      })),
      valueFormat: (v) => money(v, { cents: false }),
      ariaLabel: 'Top spending categories this month',
    })
  );

  /* ----------------------------- lists --------------------------- */

  const upcomingCard = h(
    'div.card',
    null,
    h(
      'div.card-head',
      null,
      h('div.h2', null, 'Coming up'),
      h('button.linkbtn.small', { onclick: () => navigate('recurring') }, 'Manage')
    ),
    upcoming.length
      ? h(
          'div.card-body.flush',
          null,
          ...upcoming.slice(0, 7).map((u) =>
            h(
              'div.list-row',
              null,
              h(
                'div.avatar',
                { style: { background: u.overdue ? 'var(--neg-soft)' : 'var(--surface-3)' } },
                u.kind === 'income' ? '💰' : '📄'
              ),
              h(
                'div.l-main',
                null,
                h('div.l-title', null, u.rule.name),
                h(
                  'div.l-sub',
                  null,
                  `${relativeDay(u.date)} · ${accountName(doc, u.rule.accountId)}`
                )
              ),
              h(
                'div.col.gap-4',
                { style: { alignItems: 'flex-end' } },
                h(
                  'div.l-amount.money-mask',
                  { class: u.kind === 'income' ? 'pos' : '' },
                  money(u.amount)
                ),
                u.overdue ? badge('Overdue', 'bad') : null
              ),
              h(
                'button.btn.ghost.icon.sm',
                { title: 'Record it', onclick: () => markOccurrencePaid(u.rule, u.date) },
                icon('check', { size: 15 })
              )
            )
          )
        )
      : h('div.card-body', null, h('p.muted.small', null, 'Nothing scheduled in this window.'))
  );

  const recent = sortTransactions(doc.transactions || [], 'date', 'desc').slice(0, 8);
  const recentCard = h(
    'div.card',
    null,
    h(
      'div.card-head',
      null,
      h('div.h2', null, 'Recent activity'),
      h('button.linkbtn.small', { onclick: () => navigate('transactions') }, 'See all')
    ),
    recent.length
      ? h(
          'div.card-body.flush',
          null,
          ...recent.map((t) =>
            h(
              'div.list-row',
              { style: { cursor: 'pointer' }, onclick: () => openTransactionEditor(t) },
              h('div.avatar', null, categoryIcon(doc, t)),
              h(
                'div.l-main',
                null,
                h('div.l-title', null, t.payee || categoryName(doc, t.categoryId) || 'Transaction'),
                h('div.l-sub', null, `${fmtDate(t.date, 'day')} · ${accountName(doc, t.accountId)}`)
              ),
              h(
                'div.l-amount.money-mask',
                { class: t.type === 'income' ? 'pos' : t.type === 'transfer' ? 'dim' : '' },
                `${t.type === 'income' ? '+' : t.type === 'expense' ? '−' : ''}${money(t.amount)}`
              )
            )
          )
        )
      : h('div.card-body', null, h('p.muted.small', null, 'No transactions yet.'))
  );

  /* -------------------------- accounts strip --------------------- */

  const balances = allBalances(doc);
  const accountStrip = h(
    'div.card',
    null,
    h(
      'div.card-head',
      null,
      h('div.h2', null, 'Accounts'),
      h('button.linkbtn.small', { onclick: () => navigate('accounts') }, 'Manage')
    ),
    h(
      'div.card-body.flush',
      null,
      ...(doc.accounts || [])
        .filter((a) => !a.archived)
        .slice(0, 8)
        .map((a) => {
          const bal = balances.get(a.id) || 0;
          return h(
            'div.list-row',
            { style: { cursor: 'pointer' }, onclick: () => navigate('transactions', { accountId: a.id }) },
            h('span.acct-dot', { style: { background: a.color || 'var(--s1)' } }),
            h(
              'div.l-main',
              null,
              h('div.l-title', null, a.name),
              h('div.l-sub', null, a.institution || '')
            ),
            h('div.l-amount.money-mask', { class: bal < 0 ? 'neg' : '' }, money(bal))
          );
        })
    )
  );

  return page({
    title: greeting(),
    subtitle: new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }),
    actions: [
      h(
        'button.btn',
        { onclick: () => navigate('calendar') },
        icon('calendar', { size: 15 }),
        'Calendar'
      ),
      h(
        'button.btn.primary',
        { onclick: () => openTransactionEditor() },
        icon('plus', { size: 15 }),
        'Add transaction'
      ),
    ],
    children: [
      kpis,
      insightCards,
      h(
        'div.dash-cols',
        null,
        h(
          'div.col.gap-16',
          null,
          h(
            'div.card',
            null,
            h(
              'div.card-head',
              null,
              h('div', null, h('div.h2', null, 'Income vs spending'), h('div.small.muted', null, 'Last 7 months')),
              h('button.linkbtn.small', { onclick: () => navigate('reports') }, 'Reports')
            ),
            h('div.card-body', null, cashflowHost)
          ),
          h(
            'div.card',
            null,
            h(
              'div.card-head',
              null,
              h(
                'div',
                null,
                h('div.h2', null, 'Cash flow forecast'),
                h(
                  'div.small.muted',
                  null,
                  `Projected low: ${money(fc.min.balance)} on ${fmtDate(fc.min.date, 'medium')}`
                )
              ),
              h('button.linkbtn.small', { onclick: () => navigate('calendar') }, 'Details')
            ),
            h('div.card-body', null, forecastHost)
          ),
          recentCard
        ),
        h(
          'div.col.gap-16',
          null,
          upcomingCard,
          h(
            'div.card',
            null,
            h('div.card-head', null, h('div.h2', null, 'Where money went'), h('div.small.muted', null, 'This month')),
            h('div.card-body', null, spendCats.length ? catHost : h('p.muted.small', null, 'No spending recorded yet this month.'))
          ),
          accountStrip
        )
      ),
    ],
  });
}

async function loadSampleData() {
  const { confirm, toastOk } = await import('../ui.js');
  const ok = await confirm({
    title: 'Load sample data?',
    message:
      'This fills FinFolio with a fictional household — accounts, eight months of transactions, bills, budgets and goals — so you can see how everything works. Erase it later from Settings → Data.',
    confirmLabel: 'Load sample data',
  });
  if (!ok) return;
  const { buildDemoDocument } = await import('../demo.js');
  const { commit } = await import('../state.js');
  commit('Load sample data', (d) => {
    buildDemoDocument(d);
  });
  toastOk('Sample data loaded — explore away');
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function toneColor(tone) {
  return {
    critical: 'var(--st-critical)',
    warning: 'var(--st-warning)',
    info: 'var(--accent-text)',
  }[tone] || 'var(--text-3)';
}

function categoryIcon(doc, t) {
  if (t.type === 'transfer') return '↔';
  const c = (doc.categories || []).find((x) => x.id === t.categoryId);
  return (c && c.icon) || (t.type === 'income' ? '💰' : '💸');
}
