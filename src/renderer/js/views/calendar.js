import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import {
  money, fmtDate, today, addMonths, addDays, startOfMonth, endOfMonth, monthLabel,
  monthKey, dt, iso, weekdayNames, diffDays,
} from '../format.js';
import {
  forecast, isSpendable, accountName, categoryName, isOccurrencePosted,
  allBalances, resolveRuleAmount, isOccurrenceSkipped, skipEntry,
  resolveOccurrenceAmount, occurrenceOverrides,
} from '../finance.js';
import { occurrences } from '../recurrence.js';
import { lineChart } from '../charts.js';
import { statTile, segmented, badge, modal, emptyState, checkbox } from '../ui.js';
import { navigate, state } from '../state.js';
import { page } from '../shell.js';
import { openRecurringEditor, markOccurrencePaid, openTransactionEditor } from '../editors.js';

const ui = { month: monthKey(today()), horizon: 90, accounts: null };

export default function calendar(doc, params = {}) {
  const s = doc.settings || {};
  const spendable = (doc.accounts || []).filter((a) => !a.archived && isSpendable(a.type));

  if (!spendable.length) {
    return page({
      title: 'Calendar & Forecast',
      children: [
        emptyState({
          icon: 'calendar',
          title: 'Add a checking or savings account',
          message: 'The forecast projects your spendable balance, so it needs at least one cash account.',
        }),
      ],
    });
  }

  const balances = allBalances(doc);
  const selected = ui.accounts && ui.accounts.length ? ui.accounts : spendable.map((a) => a.id);
  const horizonDays = Math.max(ui.horizon, daysToMonthEnd(ui.month) + 1);
  const fc = forecast(doc, { days: horizonDays, accountIds: selected });
  const byDate = new Map(fc.series.map((p) => [p.date, p]));
  const threshold = Number(s.lowBalanceThreshold) || 0;

  /* ----------------------------- header -------------------------- */

  const monthNav = h(
    'div.row.gap-6',
    null,
    h(
      'button.btn.icon.sm',
      { onclick: () => { ui.month = monthKey(addMonths(`${ui.month}-01`, -1)); navigate('calendar', params); } },
      icon('chevronLeft', { size: 16 })
    ),
    h('div.h2', { style: { minWidth: '160px', textAlign: 'center' } }, monthLabel(ui.month, { long: true })),
    h(
      'button.btn.icon.sm',
      { onclick: () => { ui.month = monthKey(addMonths(`${ui.month}-01`, 1)); navigate('calendar', params); } },
      icon('chevronRight', { size: 16 })
    ),
    h(
      'button.btn.sm',
      { onclick: () => { ui.month = monthKey(today()); navigate('calendar', params); } },
      'Today'
    )
  );

  /* ---------------------------- calendar ------------------------- */

  const first = `${ui.month}-01`;
  const last = endOfMonth(first);
  const weekStart = Number(s.startOfWeek) || 0;
  const leading = (dt(first).getDay() - weekStart + 7) % 7;
  const gridStart = addDays(first, -leading);
  const totalCells = Math.ceil((leading + dt(last).getDate()) / 7) * 7;

  // The calendar shows every bill and payday — including ones charged to a
  // credit card — while the balance line below only counts the accounts in
  // the forecast. Those are different questions, so they use different data.
  const gridEnd = addDays(gridStart, totalCells - 1);
  const dayEvents = calendarEvents(doc, gridStart, gridEnd);

  const cells = [];
  for (let i = 0; i < totalCells; i += 1) {
    const date = addDays(gridStart, i);
    const inMonth = date >= first && date <= last;
    const point = byDate.get(date);
    const events = dayEvents.get(date) || [];
    const isToday = date === today();
    const low = point && date >= today() && point.balance < threshold;
    cells.push(
      h(
        `div.cal-day${inMonth ? '' : '.out'}${isToday ? '.today' : ''}${low ? '.negative' : ''}`,
        {
          onclick: () => events.length && showDay(doc, date, point, events),
          style: { cursor: events.length ? 'pointer' : 'default' },
        },
        h('div.cal-num', null, String(dt(date).getDate())),
        ...events.slice(0, 3).map((e) => eventChip(e, date)),
        events.length > 3 ? h('div.tiny.dim', null, `+${events.length - 3} more`) : null,
        point && date >= today()
          ? h(`div.cal-bal${low ? '.low' : ''}`, null, money(point.balance, { cents: false }))
          : null
      )
    );
  }

  const grid = h(
    'div.cal',
    null,
    ...weekdayNames(weekStart, 'short').map((w) => h('div.cal-head', null, w)),
    ...cells
  );

  /* ---------------------------- forecast ------------------------- */

  const chartHost = h('div.chart-wrap');
  requestAnimationFrame(() =>
    lineChart(chartHost, {
      height: 260,
      labels: fc.series.slice(0, ui.horizon + 1).map((p) => p.date),
      series: [
        {
          name: 'Projected balance',
          values: fc.series.slice(0, ui.horizon + 1).map((p) => p.balance),
          color: 'var(--s1)',
        },
      ],
      yFormat: (v) => money(v, { cents: false, compact: true }),
      xFormat: (d, _i, full) => (full ? fmtDate(d, 'weekday') : fmtDate(d, 'day')),
      tipFormat: (v) => money(v),
      threshold: threshold > 0 ? { value: threshold, label: `Low balance ${money(threshold, { cents: false })}` } : null,
      ariaLabel: 'Projected spendable balance',
    })
  );

  const lowDays = fc.series.filter((p) => p.date >= today() && p.balance < threshold);
  const firstLow = lowDays[0] || null;

  const setAccounts = (ids) => {
    ui.accounts = ids;
    navigate('calendar', params);
  };
  const checking = spendable.filter((a) => a.type === 'checking').map((a) => a.id);
  const allIds = spendable.map((a) => a.id);
  const isAll = selected.length === allIds.length;
  const isChecking = checking.length > 0
    && selected.length === checking.length
    && checking.every((id) => selected.includes(id));

  // Savings you are deliberately not spending should be excludable: a forecast
  // that quietly leans on the emergency fund says you are fine when you are
  // not. One click, because it is the question people ask most.
  const accountPicker = h(
    'div.card.pad',
    null,
    h(
      'div.row.wrap',
      null,
      h(
        'div.grow',
        null,
        h('div.h3', null, 'Accounts in this forecast'),
        h(
          'div.muted.small.mt-4',
          null,
          isAll
            ? 'Every cash account, including savings.'
            : `${selected.length} of ${spendable.length} — ${spendable
                .filter((a) => selected.includes(a.id))
                .map((a) => a.name)
                .join(', ')}`
        )
      ),
      h(
        'div.row.gap-6',
        null,
        checking.length && checking.length < spendable.length
          ? h(
              `button.btn.sm${isChecking ? '.primary' : ''}`,
              { onclick: () => setAccounts(checking) },
              'Checking only'
            )
          : null,
        h(
          `button.btn.sm${isAll ? '.primary' : ''}`,
          { onclick: () => setAccounts(null) },
          'All cash accounts'
        )
      )
    ),
    h(
      'div.row.wrap.gap-12.mt-12',
      null,
      ...spendable.map((a) =>
        checkbox(`${a.name} · ${money(balances.get(a.id) || 0, { cents: false })}`, {
          checked: selected.includes(a.id),
          onchange: (e) => {
            const set = new Set(selected);
            if (e.target.checked) set.add(a.id);
            else set.delete(a.id);
            // Never leave it with nothing selected — an empty forecast is a
            // broken screen, not a choice anyone meant to make.
            setAccounts(set.size ? [...set] : allIds);
          },
        })
      )
    )
  );

  return page({
    title: 'Calendar & Forecast',
    subtitle: 'Every payday and bill, plus where your balance is heading',
    actions: [
      monthNav,
      h('button.btn.primary', { onclick: () => openRecurringEditor() }, icon('plus', { size: 15 }), 'Schedule'),
    ],
    children: [
      accountPicker,
      h(
        'div.kpi-grid',
        null,
        statTile({ label: 'Balance today', value: money(fc.start), sub: `${selected.length} accounts` }),
        statTile({
          label: `In ${ui.horizon} days`,
          value: money(fc.series[Math.min(ui.horizon, fc.series.length - 1)].balance),
          sub: 'projected',
          tone: fc.end < 0 ? 'neg' : '',
        }),
        statTile({
          label: 'Projected low point',
          value: money(fc.min.balance),
          sub: fmtDate(fc.min.date, 'medium'),
          tone: fc.min.balance < threshold ? 'neg' : '',
        }),
        statTile({
          label: 'Low-balance days',
          value: String(lowDays.length),
          sub: firstLow ? `first on ${fmtDate(firstLow.date, 'medium')}` : 'none ahead',
          tone: lowDays.length ? 'neg' : 'pos',
        })
      ),
      firstLow
        ? h(
            'div.card.pad',
            { style: { borderLeft: '3px solid var(--st-critical)' } },
            h(
              'div.row',
              null,
              h('span', { style: { color: 'var(--st-critical)', display: 'flex' } }, icon('alert', { size: 18 })),
              h(
                'div.grow',
                null,
                h('div.strong', null, `Balance drops below ${money(threshold)} on ${fmtDate(firstLow.date, 'long')}`),
                h(
                  'div.muted.small.mt-4',
                  null,
                  `That is ${diffDays(today(), firstLow.date)} days away. Moving a bill, or transferring money in before then, keeps you clear.`
                )
              )
            )
          )
        : null,
      h('div.card', null, h('div.card-body', null, grid)),
      h(
        'div.card',
        null,
        h(
          'div.card-head',
          null,
          h('div.h2', null, 'Balance projection'),
          segmented(
            [
              { value: 30, label: '30d' },
              { value: 60, label: '60d' },
              { value: 90, label: '90d' },
              { value: 180, label: '6mo' },
              { value: 365, label: '1yr' },
            ],
            ui.horizon,
            (v) => {
              ui.horizon = Number(v);
              navigate('calendar', params);
            }
          )
        ),
        h('div.card-body', null, chartHost)
      ),
    ],
  });
}

/**
 * Every dated thing worth seeing on a calendar: transactions already recorded,
 * plus scheduled occurrences from today onward that have not been posted yet.
 */
function calendarEvents(doc, from, to) {
  const map = new Map();
  const push = (date, item) => {
    if (!map.has(date)) map.set(date, []);
    map.get(date).push(item);
  };

  for (const t of doc.transactions || []) {
    if (t.date < from || t.date > to) continue;
    const amount = Number(t.amount) || 0;
    push(t.date, {
      label: t.payee || (t.type === 'transfer' ? 'Transfer' : categoryName(doc, t.categoryId)),
      amount: t.type === 'income' ? amount : -amount,
      kind: t.type,
      source: 'transaction',
      account: accountName(doc, t.accountId),
      transaction: t,
    });
  }

  const start = from > today() ? from : today();
  const balances = allBalances(doc);
  for (const rule of doc.recurring || []) {
    if (rule.active === false) continue;
    const base = resolveRuleAmount(doc, rule, { balances });
    if (!base.amount && !occurrenceOverrides(rule).length) continue;
    for (const date of occurrences(rule, start, to, { max: 200 })) {
      if (isOccurrencePosted(doc, rule, date)) continue;
      const amount = resolveOccurrenceAmount(doc, rule, date, { base }).amount;
      if (!amount) continue;
      const signed = rule.kind === 'income' ? amount : -amount;
      const skipped = isOccurrenceSkipped(rule, date);
      push(date, {
        label: rule.name,
        // A skipped payment contributes nothing to the day's net, but the row
        // stays visible so the gap in the month is explained rather than blank.
        amount: skipped ? 0 : signed,
        wouldHaveBeen: signed,
        kind: rule.kind,
        source: 'recurring',
        account: accountName(doc, rule.accountId),
        scheduled: true,
        skipped,
        skipReason: skipped ? (skipEntry(rule, date) || {}).reason || '' : '',
        rule,
        date,
      });
    }
  }

  for (const list of map.values()) {
    list.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  }
  return map;
}

function eventChip(e, date) {
  // Amber marks money still to go out; anything already recorded stays neutral.
  const cls = e.skipped
    ? 'skipped'
    : e.amount >= 0
      ? 'income'
      : !e.scheduled
        ? ''
        : date < today()
          ? 'overdue'
          : 'bill';
  const shown = e.skipped ? e.wouldHaveBeen : e.amount;
  const title = e.skipped
    ? `${e.label} · skipped${e.skipReason ? ` — ${e.skipReason}` : ''}`
    : `${e.label} · ${money(e.amount, { sign: true })}${e.scheduled ? ' (scheduled)' : ''}`;
  return h(
    `div.cal-ev${cls ? `.${cls}` : ''}`,
    { title },
    h('span.truncate', null, e.label),
    h('span.ev-amt', null, money(Math.abs(shown || 0), { cents: false }))
  );
}

function showDay(doc, date, point, events) {
  const total = events.reduce((s, e) => s + e.amount, 0);
  const m = modal({
    title: fmtDate(date, 'long'),
    size: 'sm',
    body: h(
      'div.col.gap-12',
      null,
      point && date >= today()
        ? h(
            'div.between',
            null,
            h('span.muted', null, 'Projected spendable balance'),
            h('span.strong', { class: point.balance < 0 ? 'neg' : '' }, money(point.balance))
          )
        : null,
      h(
        'div.between',
        null,
        h('span.muted', null, 'Net for the day'),
        h('span.strong', { class: total >= 0 ? 'pos' : 'neg' }, money(total, { sign: true }))
      ),
      h(
        'div.card',
        null,
        h(
          'div.card-body.flush',
          null,
          ...events.map((e) =>
            h(
              'div.list-row',
              {
                style: {
                  ...(e.skipped ? { opacity: '0.62' } : {}),
                  cursor: e.transaction || e.rule ? 'pointer' : 'default',
                },
                title: e.transaction
                  ? 'Open this transaction'
                  : e.rule
                    ? 'Open this schedule'
                    : null,
                onclick: () => {
                  if (e.transaction) {
                    m.close();
                    openTransactionEditor(e.transaction);
                  } else if (e.rule) {
                    m.close();
                    openRecurringEditor(e.rule);
                  }
                },
              },
              h('div.avatar', null, e.skipped ? '⏭' : e.amount >= 0 ? '💰' : e.kind === 'transfer' ? '↔' : '📄'),
              h(
                'div.l-main',
                null,
                h('div.l-title', null, e.label),
                h(
                  'div.l-sub',
                  null,
                  `${e.skipped ? 'Skipped' : e.scheduled ? 'Scheduled' : 'Recorded'} · ${e.account}`,
                  e.skipReason ? h('span.dim', null, ` · ${e.skipReason}`) : null
                )
              ),
              e.skipped
                ? h(
                    'div.l-amount.dim',
                    { style: { textDecoration: 'line-through' } },
                    money(Math.abs(e.wouldHaveBeen || 0))
                  )
                : h('div.l-amount', { class: e.amount >= 0 ? 'pos' : '' }, money(e.amount, { sign: true }))
            )
          )
        )
      )
    ),
  });
}

function daysToMonthEnd(month) {
  const end = endOfMonth(`${month}-01`);
  return Math.max(0, diffDays(today(), end));
}
