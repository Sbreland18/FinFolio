import { h } from '../dom.js';
import { icon } from '../icons.js';
import { money, pct, today, addMonths, monthKey, monthLabel, startOfMonth, endOfMonth, diffDays, round2 } from '../format.js';
import { budgetProgress, categoryTotals, categoryName, monthlyTotals, uid } from '../finance.js';
import { barChart } from '../charts.js';
import { statTile, emptyState, badge, confirm, toast } from '../ui.js';
import { navigate, commit, state } from '../state.js';
import { page } from '../shell.js';
import { openBudgetEditor } from '../editors.js';

const ui = { month: monthKey(today()) };

export default function budgets(doc, params = {}) {
  const month = ui.month;
  const progress = budgetProgress(doc, month);
  const isCurrent = month === monthKey(today());
  const monthStart = `${month}-01`;
  const monthEnd = endOfMonth(monthStart);
  const daysInMonth = diffDays(monthStart, monthEnd) + 1;
  const dayOfMonth = isCurrent ? diffDays(monthStart, today()) + 1 : daysInMonth;
  const expectedPace = dayOfMonth / daysInMonth;

  const nav = h(
    'div.row.gap-6',
    null,
    h(
      'button.btn.icon.sm',
      { onclick: () => { ui.month = monthKey(addMonths(monthStart, -1)); navigate('budgets', params); } },
      icon('chevronLeft', { size: 16 })
    ),
    h('div.h2', { style: { minWidth: '150px', textAlign: 'center' } }, monthLabel(month, { long: true })),
    h(
      'button.btn.icon.sm',
      { onclick: () => { ui.month = monthKey(addMonths(monthStart, 1)); navigate('budgets', params); } },
      icon('chevronRight', { size: 16 })
    )
  );

  if (!progress.rows.length) {
    return page({
      title: 'Budgets',
      actions: [nav, h('button.btn.primary', { onclick: () => openBudgetEditor(month) }, icon('plus', { size: 15 }), 'Set budget')],
      children: [
        emptyState({
          icon: 'pie',
          title: `No budget for ${monthLabel(month, { long: true })}`,
          message: 'Set a monthly amount per category and FinFolio tracks the rest. You can start from your recent averages.',
          action: { label: 'Set a budget', onClick: () => openBudgetEditor(month) },
        }),
        suggestionCard(doc, month),
      ],
    });
  }

  const overall = progress.totals;
  const overPace = isCurrent && overall.available > 0 && overall.spent / overall.available > expectedPace * 1.05;

  /* --------------------------- category rows --------------------- */

  const rows = progress.rows.map((r) => {
    const over = r.remaining < 0;
    const tone = over ? 'bad' : r.pct > 85 ? 'warn' : 'good';
    return h(
      'div.list-row',
      null,
      h(
        'div.l-main',
        null,
        h(
          'div.between',
          null,
          h(
            'div.row.gap-6',
            null,
            h('span.l-title', null, r.name),
            r.rollover && r.carry > 0 ? badge(`+${money(r.carry, { cents: false })} carried`, 'info') : null
          ),
          h(
            'div.small.money-mask',
            null,
            h('span.strong', { class: over ? 'neg' : '' }, money(r.spent)),
            h('span.dim', null, ` of ${money(r.available)}`)
          )
        ),
        h('div.bar.tall.mt-8', null, h(`i.${tone}`, { style: { width: `${Math.min(100, r.pct)}%` } })),
        h(
          'div.between.tiny.mt-4',
          null,
          h('span.dim', null, `${pct(r.pct, 0)} used`),
          h(
            'span',
            { class: over ? 'neg strong' : 'dim' },
            over ? `${money(-r.remaining)} over` : `${money(r.remaining)} left`
          )
        )
      )
    );
  });

  /* ------------------------ unbudgeted spend --------------------- */

  const budgetedIds = new Set(progress.rows.map((r) => r.categoryId));
  const unbudgeted = categoryTotals(doc, { from: monthStart, to: monthEnd, kind: 'expense' })
    .filter((c) => !budgetedIds.has(c.categoryId))
    .slice(0, 8);
  const unbudgetedTotal = round2(unbudgeted.reduce((s, c) => s + c.amount, 0));

  /* --------------------------- trend chart ----------------------- */

  const history = monthlyTotals(doc, 6, monthStart);
  const trendHost = h('div.chart-wrap');
  requestAnimationFrame(() =>
    barChart(trendHost, {
      height: 190,
      labels: history.map((m) => m.key),
      series: [{ name: 'Spending', values: history.map((m) => m.expense), color: 'var(--s2)' }],
      yFormat: (v) => money(v, { cents: false, compact: true }),
      xFormat: (k, _i, full) => (full ? monthLabel(k, { long: true }) : monthLabel(k).split(' ')[0]),
      ariaLabel: 'Spending by month',
      tableView: false,
    })
  );

  return page({
    title: 'Budgets',
    subtitle: isCurrent ? `Day ${dayOfMonth} of ${daysInMonth}` : monthLabel(month, { long: true }),
    actions: [
      nav,
      h('button.btn', { onclick: () => copyPrevious(doc, month) }, icon('copy', { size: 15 }), 'Copy last month'),
      h('button.btn.primary', { onclick: () => openBudgetEditor(month) }, icon('edit', { size: 15 }), 'Edit budget'),
    ],
    children: [
      h(
        'div.kpi-grid',
        null,
        statTile({ label: 'Budgeted', value: money(overall.available), sub: `${progress.rows.length} categories` }),
        statTile({ label: 'Spent', value: money(overall.spent), tone: overall.spent > overall.available ? 'neg' : '' }),
        statTile({
          label: 'Remaining',
          value: money(overall.remaining),
          tone: overall.remaining < 0 ? 'neg' : 'pos',
          sub: isCurrent ? `${daysInMonth - dayOfMonth} days left` : null,
        }),
        statTile({
          label: 'Unbudgeted spend',
          value: money(unbudgetedTotal),
          sub: `${unbudgeted.length} categories`,
        })
      ),
      overPace
        ? h(
            'div.card.pad',
            { style: { borderLeft: '3px solid var(--st-warning)' } },
            h(
              'div.row',
              null,
              h('span', { style: { color: 'var(--st-warning)', display: 'flex' } }, icon('alert', { size: 18 })),
              h(
                'div',
                null,
                h('div.strong', null, 'Spending faster than planned'),
                h(
                  'div.muted.small.mt-4',
                  null,
                  `You are ${pct((overall.spent / overall.available) * 100, 0)} through the budget on day ${dayOfMonth} of ${daysInMonth}.`
                )
              )
            )
          )
        : null,
      h(
        'div.split',
        null,
        h(
          'div.card',
          null,
          h(
            'div.card-head',
            null,
            h('div.h2', null, 'By category'),
            h(
              'div.small.muted',
              null,
              `Overall ${pct(overall.available ? (overall.spent / overall.available) * 100 : 0, 0)} used`
            )
          ),
          h('div.card-body.flush', null, ...rows)
        ),
        h(
          'div.col.gap-16',
          null,
          h(
            'div.card',
            null,
            h('div.card-head', null, h('div.h3', null, 'Spending trend')),
            h('div.card-body', null, trendHost)
          ),
          unbudgeted.length
            ? h(
                'div.card',
                null,
                h('div.card-head', null, h('div.h3', null, 'Not budgeted')),
                h(
                  'div.card-body.flush',
                  null,
                  ...unbudgeted.map((c) =>
                    h(
                      'div.list-row',
                      null,
                      h('div.l-main', null, h('div.l-title', null, c.name)),
                      h('div.l-amount.money-mask', null, money(c.amount))
                    )
                  )
                ),
                h(
                  'div.card-foot',
                  null,
                  h('button.linkbtn.small', { onclick: () => openBudgetEditor(month) }, 'Add these to the budget')
                )
              )
            : null
        )
      ),
    ],
  });
}

function suggestionCard(doc, month) {
  const avg = averageSpend(doc, 3, month);
  if (!avg.length) return null;
  return h(
    'div.card',
    null,
    h(
      'div.card-head',
      null,
      h('div.h3', null, 'Start from your averages'),
      h(
        'button.btn.sm.soft',
        {
          onclick: () => {
            commit('Create budget from averages', (d) => {
              d.budgets = (d.budgets || []).filter((b) => b.month !== month);
              for (const row of avg) {
                d.budgets.push({ id: uid('bud'), categoryId: row.categoryId, month, amount: row.amount, rollover: false });
              }
            });
            toast('Budget created from your 3-month averages');
          },
        },
        'Use these amounts'
      )
    ),
    h(
      'div.card-body.flush',
      null,
      ...avg.slice(0, 12).map((row) =>
        h(
          'div.list-row',
          null,
          h('div.l-main', null, h('div.l-title', null, row.name)),
          h('div.l-amount.money-mask', null, money(row.amount))
        )
      )
    )
  );
}

function averageSpend(doc, months, refMonth) {
  const totals = new Map();
  for (let i = 1; i <= months; i += 1) {
    const ref = addMonths(`${refMonth}-01`, -i);
    const list = categoryTotals(doc, { from: startOfMonth(ref), to: endOfMonth(ref), kind: 'expense' });
    for (const c of list) totals.set(c.categoryId, (totals.get(c.categoryId) || 0) + c.amount);
  }
  return [...totals.entries()]
    .map(([categoryId, sum]) => ({
      categoryId,
      name: categoryName(doc, categoryId),
      amount: Math.ceil(sum / months / 5) * 5,
    }))
    .filter((r) => r.amount > 0)
    .sort((a, b) => b.amount - a.amount);
}

async function copyPrevious(doc, month) {
  const prev = monthKey(addMonths(`${month}-01`, -1));
  const source = (doc.budgets || []).filter((b) => b.month === prev);
  if (!source.length) {
    toast(`No budget found for ${monthLabel(prev, { long: true })}`, { tone: 'warn' });
    return;
  }
  const existing = (doc.budgets || []).filter((b) => b.month === month);
  if (existing.length) {
    const ok = await confirm({
      title: 'Replace this month’s budget?',
      message: `${existing.length} categories are already budgeted for ${monthLabel(month, { long: true })}.`,
      confirmLabel: 'Replace',
    });
    if (!ok) return;
  }
  commit('Copy budget', (d) => {
    d.budgets = (d.budgets || []).filter((b) => b.month !== month);
    for (const b of source) {
      d.budgets.push({ id: uid('bud'), categoryId: b.categoryId, month, amount: b.amount, rollover: b.rollover });
    }
  });
  toast(`Copied ${source.length} categories from ${monthLabel(prev)}`);
}
