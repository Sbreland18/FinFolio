import { h } from '../dom.js';
import { icon } from '../icons.js';
import { money, pct, fmtDate, today, monthLabel, diffDays, num } from '../format.js';
import {
  netWorth, netWorthSeries, goalProgress, allBalances, isLiability, accountName, accountType,
} from '../finance.js';
import { lineChart, arcMeter, rankedBars } from '../charts.js';
import { statTile, emptyState, badge, contextMenu, confirm, segmented } from '../ui.js';
import { navigate, removeFrom } from '../state.js';
import { page } from '../shell.js';
import { openGoalEditor, openContributionDialog } from '../editors.js';

const ui = { months: 12 };

export default function goals(doc, params = {}) {
  const nw = netWorth(doc);
  const series = netWorthSeries(doc, ui.months);
  const first = series[0] || { net: 0 };
  const change = nw.net - first.net;
  const balances = allBalances(doc);

  const chartHost = h('div.chart-wrap');
  requestAnimationFrame(() =>
    lineChart(chartHost, {
      height: 250,
      labels: series.map((p) => p.key),
      series: [
        { name: 'Net worth', values: series.map((p) => p.net), color: 'var(--s1)' },
        { name: 'Assets', values: series.map((p) => p.assets), color: 'var(--s3)' },
        { name: 'Debt', values: series.map((p) => p.debt), color: 'var(--s2)' },
      ],
      yFormat: (v) => money(v, { cents: false, compact: true }),
      xFormat: (k, _i, full) => (full ? monthLabel(k, { long: true }) : monthLabel(k).split(' ')[0]),
      tipFormat: (v) => money(v),
      area: false,
      ariaLabel: 'Net worth over time',
    })
  );

  const assetRows = (doc.accounts || [])
    .filter((a) => !a.archived && !isLiability(a.type) && (balances.get(a.id) || 0) !== 0)
    .map((a) => ({ label: a.name, value: Math.abs(balances.get(a.id) || 0), color: a.color || 'var(--s3)' }))
    .sort((a, b) => b.value - a.value);
  const debtRows = (doc.accounts || [])
    .filter((a) => !a.archived && isLiability(a.type) && (balances.get(a.id) || 0) !== 0)
    .map((a) => ({ label: a.name, value: Math.abs(balances.get(a.id) || 0), color: a.color || 'var(--s2)' }))
    .sort((a, b) => b.value - a.value);

  const assetHost = h('div.chart-wrap');
  const debtHost = h('div.chart-wrap');
  requestAnimationFrame(() => {
    if (assetRows.length) rankedBars(assetHost, { items: assetRows, valueFormat: (v) => money(v, { cents: false }), monochrome: false, ariaLabel: 'Assets by account' });
    if (debtRows.length) rankedBars(debtHost, { items: debtRows, valueFormat: (v) => money(v, { cents: false }), monochrome: false, ariaLabel: 'Debts by account' });
  });

  const goalList = (doc.goals || []).map((g) => goalCard(doc, g));

  return page({
    title: 'Goals & Net Worth',
    subtitle: 'What you are building toward',
    actions: [
      segmented(
        [
          { value: 6, label: '6mo' },
          { value: 12, label: '1yr' },
          { value: 24, label: '2yr' },
          { value: 60, label: '5yr' },
        ],
        ui.months,
        (v) => {
          ui.months = Number(v);
          navigate('goals', params);
        }
      ),
      h('button.btn.primary', { onclick: () => openGoalEditor() }, icon('plus', { size: 15 }), 'New goal'),
    ],
    children: [
      h(
        'div.kpi-grid',
        null,
        statTile({ label: 'Net worth', value: money(nw.net), tone: nw.net < 0 ? 'neg' : '' }),
        statTile({ label: 'Assets', value: money(nw.assets), tone: 'pos' }),
        statTile({ label: 'Debt', value: money(nw.debt), tone: nw.debt > 0 ? 'neg' : '' }),
        statTile({
          label: `Change over ${ui.months} months`,
          value: money(change, { sign: true }),
          tone: change >= 0 ? 'pos' : 'neg',
          sub: first.net ? `${pct((change / Math.abs(first.net)) * 100, 1)}` : null,
        })
      ),
      h(
        'div.card',
        null,
        h('div.card-head', null, h('div.h2', null, 'Net worth trend')),
        h('div.card-body', null, chartHost)
      ),
      h(
        'div.grid.grid-2',
        null,
        h(
          'div.card',
          null,
          h('div.card-head', null, h('div.h3', null, 'Assets'), h('div.strong.money-mask', null, money(nw.assets))),
          h('div.card-body', null, assetRows.length ? assetHost : h('p.muted.small', null, 'No asset balances yet.'))
        ),
        h(
          'div.card',
          null,
          h('div.card-head', null, h('div.h3', null, 'Debts'), h('div.strong.money-mask', null, money(nw.debt))),
          h('div.card-body', null, debtRows.length ? debtHost : h('p.muted.small', null, 'Debt free.'))
        )
      ),
      h(
        'div',
        null,
        h('div.eyebrow.mb-8', null, 'Savings goals'),
        goalList.length
          ? h('div.grid.grid-auto', null, ...goalList)
          : emptyState({
              icon: 'target',
              title: 'No goals yet',
              message: 'Set a target — an emergency fund, a trip, a down payment — and track the progress here.',
              action: { label: 'Create a goal', onClick: () => openGoalEditor() },
            })
      ),
    ],
  });
}

function goalCard(doc, goal) {
  const p = goalProgress(doc, goal);
  const daysLeft = goal.targetDate ? diffDays(today(), goal.targetDate) : null;
  const onTrack =
    !goal.targetDate || p.done
      ? true
      : goal.monthlyContribution
        ? p.perMonth !== null && goal.monthlyContribution >= p.perMonth
        : null;

  return h(
    'div.card.pad.hoverable',
    { oncontextmenu: (e) => goalMenu(e, goal) },
    h(
      'div.row.gap-16',
      null,
      arcMeter({
        value: p.pct,
        max: 100,
        size: 96,
        thickness: 9,
        color: goal.color || 'var(--s3)',
        label: `${Math.round(p.pct)}%`,
      }),
      h(
        'div.grow',
        null,
        h(
          'div.row',
          null,
          h('div.h3.grow', null, goal.name),
          p.done ? badge('Reached', 'good') : onTrack === false ? badge('Behind', 'warn') : null
        ),
        h(
          'div.stat-value.money-mask.mt-4',
          { style: { fontSize: '20px' } },
          money(p.saved, { cents: false })
        ),
        h('div.small.muted', null, `of ${money(p.target, { cents: false })} · ${money(p.remaining, { cents: false })} to go`),
        goal.accountId ? h('div.tiny.dim.mt-4', null, `Tracking ${accountName(doc, goal.accountId)}`) : null
      )
    ),
    goal.targetDate
      ? h(
          'div.between.small.mt-12',
          null,
          h('span.muted', null, `Target ${fmtDate(goal.targetDate, 'medium')}`),
          h(
            'span',
            { class: daysLeft < 0 && !p.done ? 'neg strong' : 'dim' },
            p.done ? 'Complete' : daysLeft < 0 ? `${Math.abs(daysLeft)} days overdue` : `${daysLeft} days left`
          )
        )
      : null,
    p.perMonth !== null && !p.done
      ? h(
          'div.small.muted.mt-4',
          null,
          `Needs ${money(p.perMonth)} a month`,
          goal.monthlyContribution ? ` · you are putting in ${money(goal.monthlyContribution)}` : ''
        )
      : null,
    h(
      'div.row.gap-6.mt-12',
      null,
      h('button.btn.sm.soft', { onclick: () => openContributionDialog(goal) }, icon('plus', { size: 14 }), 'Add money'),
      h('button.btn.sm', { onclick: () => openGoalEditor(goal) }, 'Edit')
    )
  );
}

function goalMenu(e, goal) {
  contextMenu(e, [
    { label: 'Add contribution', icon: 'plus', onClick: () => openContributionDialog(goal) },
    { label: 'Edit goal', icon: 'edit', onClick: () => openGoalEditor(goal) },
    { separator: true },
    {
      label: 'Delete goal',
      icon: 'trash',
      danger: true,
      onClick: async () => {
        if (await confirm({ title: `Delete “${goal.name}”?`, confirmLabel: 'Delete', tone: 'danger' })) {
          removeFrom('goals', goal.id, 'Delete goal');
        }
      },
    },
  ]);
}
