import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import {
  money, pct, fmtDate, today, relativeDay, addDays, addMonths, diffDays, monthLabel, monthKey,
  round2,
} from '../format.js';
import {
  upcomingItems, monthlyRecurringLoad, accountName, categoryName, isOccurrencePosted,
  allBalances, resolveRuleAmount, accountsMissingPaymentReminder, skippedOccurrences,
  monthSchedule, forecast, isSpendable, scheduleIcon, groupSchedules, subscriptionSummary,
} from '../finance.js';
import { describe, nextDue, dueStatus, frequencyLabel, monthlyEquivalent, perYear } from '../recurrence.js';
import { emptyState, badge, contextMenu, confirm, statTile, segmented, toast } from '../ui.js';
import { navigate, commit, removeFrom } from '../state.js';
import { page } from '../shell.js';
import {
  openRecurringEditor, markOccurrencePaid, addPaymentReminders, skipOccurrence, unskipOccurrence,
  adjustOccurrence,
} from '../editors.js';

// `cutting` is a what-if, not a saved decision — it resets when the app does.
const ui = { tab: 'month', horizon: 30, month: monthKey(today()), cutting: new Set() };

export default function recurring(doc, params = {}) {
  const rules = doc.recurring || [];
  const load = monthlyRecurringLoad(doc);

  if (!rules.length) {
    return page({
      title: 'Bills & Income',
      children: [
        emptyState({
          icon: 'repeat',
          title: 'Nothing scheduled yet',
          message:
            'Add your paydays, rent, utilities, subscriptions and loan payments once — FinFolio then tracks what is due, forecasts your balance and fills the calendar.',
          action: { label: 'Add a bill or payday', onClick: () => openRecurringEditor() },
        }),
      ],
    });
  }

  // Skipped occurrences stay in the list so a gap in the month is explained
  // and can be put back, but they are not counted as anything still owed.
  const upcoming = upcomingItems(doc, { days: ui.horizon, includeSkipped: true });
  const due = upcoming.filter((u) => !u.skipped);
  const overdue = due.filter((u) => u.overdue);
  const skipped = upcoming.filter((u) => u.skipped);

  const summary = h(
    'div.kpi-grid',
    null,
    statTile({ label: 'Recurring income', value: money(load.income), sub: 'per month', tone: 'pos' }),
    statTile({
      label: 'Bills & payments',
      value: money(load.bills + load.debt),
      sub: load.debt
        ? `${money(load.bills, { cents: false })} bills · ${money(load.debt, { cents: false })} card & loan payments`
        : 'per month',
    }),
    statTile({
      label: 'Left over',
      value: money(load.net),
      sub: 'income minus everything scheduled',
      tone: load.net < 0 ? 'neg' : 'pos',
    }),
    statTile({
      label: 'Due soon',
      value: String(due.length),
      sub: skipped.length
        ? `${overdue.length} overdue · ${skipped.length} skipped · next ${ui.horizon} days`
        : `${overdue.length} overdue · next ${ui.horizon} days`,
      tone: overdue.length ? 'neg' : '',
    })
  );

  const subCount = rules.filter((r) => r.kind === 'subscription').length;

  const tabs = h(
    'div.row',
    null,
    segmented(
      [
        { value: 'month', label: 'This month' },
        { value: 'upcoming', label: 'Upcoming' },
        { value: 'subs', label: `Subscriptions${subCount ? ` (${subCount})` : ''}` },
        { value: 'all', label: 'All scheduled' },
      ],
      ui.tab,
      (v) => {
        ui.tab = v;
        navigate('recurring', params);
      }
    ),
    h('div.grow'),
    ui.tab === 'month'
      ? h(
          'div.row.gap-6',
          null,
          h(
            'button.btn.ghost.icon.sm',
            { title: 'Previous month', onclick: () => { ui.month = monthKey(addMonths(`${ui.month}-01`, -1)); navigate('recurring', params); } },
            icon('chevronLeft', { size: 16 })
          ),
          h('div.strong', { style: { minWidth: '132px', textAlign: 'center' } }, monthLabel(ui.month, { long: true })),
          h(
            'button.btn.ghost.icon.sm',
            { title: 'Next month', onclick: () => { ui.month = monthKey(addMonths(`${ui.month}-01`, 1)); navigate('recurring', params); } },
            icon('chevronRight', { size: 16 })
          ),
          ui.month === monthKey(today())
            ? null
            : h('button.btn.sm', { onclick: () => { ui.month = monthKey(today()); navigate('recurring', params); } }, 'This month')
        )
      : ui.tab === 'upcoming'
      ? segmented(
          [
            { value: 14, label: '14 days' },
            { value: 30, label: '30 days' },
            { value: 60, label: '60 days' },
            { value: 90, label: '90 days' },
          ],
          ui.horizon,
          (v) => {
            ui.horizon = Number(v);
            navigate('recurring', params);
          }
        )
      : null
  );

  const missing = accountsMissingPaymentReminder(doc);

  return page({
    title: 'Bills & Income',
    subtitle: `${rules.filter((r) => r.active !== false).length} active schedules`,
    actions: [
      h('button.btn.primary', { onclick: () => openRecurringEditor() }, icon('plus', { size: 15 }), 'New schedule'),
    ],
    children: [
      summary,
      missing.length ? missingRemindersBanner(missing) : null,
      tabs,
      ui.tab === 'month'
        ? monthView(doc, params)
        : ui.tab === 'upcoming'
          ? upcomingList(doc, upcoming, due)
          : ui.tab === 'subs'
            ? subscriptionsView(doc, params)
            : allList(doc, rules),
    ],
  });
}

/** Cards and loans whose payments are not being tracked as bills yet. */
function missingRemindersBanner(missing) {
  const names = missing.slice(0, 3).map((a) => a.name).join(', ');
  return h(
    'div.card.pad',
    { style: { borderLeft: '3px solid var(--st-warning)' } },
    h(
      'div.row',
      null,
      h('span', { style: { color: 'var(--st-warning)', display: 'flex' } }, icon('alert', { size: 18 })),
      h(
        'div.grow',
        null,
        h(
          'div.strong',
          null,
          `${missing.length} card${missing.length === 1 ? '' : 's'} or loan${missing.length === 1 ? '' : 's'} not in your bills`
        ),
        h(
          'div.muted.small.mt-4',
          null,
          `${names}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''} — add them so a minimum payment is never missed.`
        )
      ),
      h(
        'button.btn.primary',
        { onclick: () => addPaymentReminders(missing) },
        icon('plus', { size: 15 }),
        'Add them'
      )
    )
  );
}

/* --------------------------- this month --------------------------- */

/**
 * One month at a glance: what is left to pay, what has been, and where the
 * month ends up. Calendar & Forecast answers this too, but by day and across
 * a horizon — the question here is narrower and gets asked more often.
 */
function monthView(doc, params) {
  const m = monthSchedule(doc, ui.month);
  const isThisMonth = ui.month === monthKey(today());

  if (!m.items.length) {
    return h(
      'div.card.pad',
      null,
      h(
        'div.center.col.gap-8',
        { style: { padding: '30px' } },
        h('div.strong', null, `Nothing scheduled in ${monthLabel(ui.month, { long: true })}`),
        h('div.muted.small', null, 'Schedules that start later will appear here when they do.')
      )
    );
  }

  // Only the current month can be projected forward — for any other the
  // forecast would be answering a question nobody asked.
  const spendable = (doc.accounts || [])
    .filter((a) => !a.archived && isSpendable(a.type))
    .map((a) => a.id);
  const balances = allBalances(doc);
  const onHand = round2(spendable.reduce((s, id) => s + (balances.get(id) || 0), 0));
  const projected = isThisMonth
    ? forecast(doc, { days: Math.max(0, diffDays(today(), m.to)) }).end
    : null;

  const progress = m.countBills ? (m.countPaid / m.countBills) * 100 : 100;

  const tiles = h(
    'div.kpi-grid',
    null,
    statTile({
      label: 'Left to pay',
      value: money(m.billsLeft),
      sub: `${m.countLeft} of ${m.countBills} bill${m.countBills === 1 ? '' : 's'}${
        m.countOverdue ? ` · ${m.countOverdue} overdue` : ''
      }`,
      tone: m.countOverdue ? 'neg' : '',
    }),
    statTile({
      label: 'Income still to come',
      value: money(m.incomeToCome),
      sub: `${money(m.incomeReceived)} of ${money(m.income)} received`,
      tone: 'pos',
    }),
    statTile({
      label: 'Already paid',
      value: money(m.billsPaid),
      sub: `of ${money(m.bills)} scheduled`,
    }),
    isThisMonth
      ? statTile({
          label: 'Projected month end',
          value: money(projected),
          sub: `${money(onHand)} on hand now`,
          tone: projected < 0 ? 'neg' : 'pos',
        })
      : statTile({
          label: 'Month net',
          value: money(round2(m.income - m.bills), { sign: true }),
          sub: 'income minus bills',
          tone: m.income - m.bills >= 0 ? 'pos' : 'neg',
        })
  );

  const bar = h(
    'div.meter',
    null,
    h(
      'div.meter-top',
      null,
      h('span.muted', null, `${m.countPaid} of ${m.countBills} paid`),
      h('span.strong', null, m.countLeft ? `${money(m.billsLeft)} to go` : 'All paid')
    ),
    h('div.bar', null, h(`i.${m.countOverdue ? 'warn' : 'good'}`, { style: { width: `${Math.min(100, progress)}%` } }))
  );

  const toPay = m.items.filter((i) => !i.posted && !i.skipped && i.kind !== 'income');
  const incoming = m.items.filter((i) => !i.posted && !i.skipped && i.kind === 'income');
  const done = m.items.filter((i) => i.posted);
  const skippedRows = m.items.filter((i) => i.skipped);

  // Cards, loans and everyday bills are different kinds of obligation and get
  // dealt with differently, so a flat list by date buries that distinction.
  const section = (title, rows, { tone = '', empty = null, grouped = false } = {}) => {
    if (!rows.length) return empty;
    // Subheadings only when they actually separate something — one group is
    // just a label nobody needed.
    const groups = grouped ? groupSchedules(doc, rows) : [];
    const body = groups.length > 1
      ? groups.flatMap((g) => [
          h(
            'div.list-subhead',
            null,
            h('span', null, g.label),
            h(
              'span.money-mask',
              null,
              money(g.items.reduce((s, r) => s + (r.kind === 'income' ? r.amount : -r.amount), 0), {
                sign: true,
                cents: false,
              })
            )
          ),
          ...g.items.map((item) => upcomingRow(doc, item)),
        ])
      : rows.map((item) => upcomingRow(doc, item));
    return h(
      'div.card',
      null,
      h(
        'div.card-head',
        null,
        h('div.row', null, h('div.h3', null, title), h('span.dim.small', null, `${rows.length}`)),
        h(
          'div.strong.money-mask',
          { class: tone },
          money(rows.reduce((s, r) => s + r.amount, 0))
        )
      ),
      h('div.card-body.flush', null, ...body)
    );
  };

  return h(
    'div.col.gap-16',
    null,
    tiles,
    h('div.card.pad', null, bar),
    section('Still to pay', toPay, {
      grouped: true,
      empty: h(
        'div.card.pad',
        null,
        h(
          'div.center.col.gap-8',
          { style: { padding: '24px' } },
          h('span', { style: { color: 'var(--st-good)' } }, icon('check', { size: 26 })),
          h('div.strong', null, 'Every bill this month is paid'),
          h('div.muted.small', null, 'Nothing else is scheduled to leave your accounts.')
        )
      ),
    }),
    section('Income still to come', incoming, { tone: 'pos' }),
    section('Recorded', done, { grouped: true }),
    section('Skipped', skippedRows)
  );
}

/* ------------------------- subscriptions -------------------------- */

/**
 * Small amounts on a monthly repeat: individually forgettable, collectively
 * not. Ticking one shows what dropping it is worth over a year, which is the
 * figure that actually changes minds — and the "Pause" button turns the
 * what-if into a decision rather than leaving it as a nice thought.
 */
function subscriptionsView(doc, params) {
  const s = subscriptionSummary(doc, { cancelling: [...ui.cutting] });

  if (!s.count) {
    return emptyState({
      icon: 'repeat',
      title: 'No subscriptions tracked yet',
      message:
        'Add a schedule and set its type to Subscription — streaming, music, software, the ' +
        'gym. FinFolio then totals what they cost a year and shows what dropping any of ' +
        'them would give back.',
      action: {
        label: 'Add a subscription',
        onClick: () => openRecurringEditor(null, { kind: 'subscription' }),
      },
    });
  }

  const redraw = () => navigate('recurring', params);
  const toggle = (id) => {
    if (ui.cutting.has(id)) ui.cutting.delete(id);
    else ui.cutting.add(id);
    redraw();
  };

  const tiles = h(
    'div.kpi-grid',
    null,
    statTile({
      label: 'Subscriptions',
      value: money(s.monthly),
      sub: `per month · ${s.activeCount} active${s.pausedCount ? ` · ${s.pausedCount} paused` : ''}`,
    }),
    statTile({ label: 'A year', value: money(s.yearly, { cents: false }), tone: 'neg' }),
    statTile({
      label: 'Share of income',
      value: s.shareOfIncome === null ? '—' : pct(s.shareOfIncome, 1),
      sub: 'of your recurring income',
      tone: s.shareOfIncome !== null && s.shareOfIncome >= 10 ? 'neg' : '',
    }),
    statTile({
      label: s.cuttingCount ? 'You would save' : 'Tick some to compare',
      value: s.cuttingCount ? money(s.savingYearly, { cents: false }) : '—',
      sub: s.cuttingCount ? `a year · ${money(s.saving)}/mo` : 'pick the ones you could drop',
      tone: s.cuttingCount ? 'pos' : '',
    })
  );

  const whatIf = s.cuttingCount
    ? h(
        'div.card.pad',
        { style: { background: 'var(--accent-soft)', borderColor: 'transparent' } },
        h(
          'div.row.wrap',
          null,
          h(
            'div.grow',
            null,
            h(
              'div.strong',
              null,
              `Dropping ${s.cuttingCount} subscription${s.cuttingCount === 1 ? '' : 's'} frees ` +
                `${money(s.saving)} a month — ${money(s.savingYearly, { cents: false })} a year`
            ),
            h(
              'div.muted.small.mt-4',
              null,
              `The rest would still cost ${money(s.remaining)} a month. Pausing stops them ` +
                'showing as due and takes them out of the forecast; nothing is deleted and ' +
                'you can resume any of them later.'
            )
          ),
          h(
            'div.row.gap-6',
            null,
            h('button.btn', { onclick: () => { ui.cutting.clear(); redraw(); } }, 'Clear'),
            h(
              'button.btn.primary',
              {
                onclick: async () => {
                  const ids = [...ui.cutting];
                  const ok = await confirm({
                    title: `Pause ${ids.length} subscription${ids.length === 1 ? '' : 's'}?`,
                    message:
                      'They stop appearing as due and drop out of the forecast. Nothing is ' +
                      'deleted — resume any of them from All scheduled.',
                    confirmLabel: 'Pause them',
                  });
                  if (!ok) return;
                  commit('Pause subscriptions', (d) => {
                    for (const r of d.recurring) if (ids.includes(r.id)) r.active = false;
                  });
                  ui.cutting.clear();
                  toast(`${ids.length} paused — ${money(s.savingYearly, { cents: false })} a year back`);
                  redraw();
                },
              },
              'Pause them'
            )
          )
        )
      )
    : null;

  const row = (item) => {
    const r = item.rule;
    const box = h('input', {
      type: 'checkbox',
      checked: item.cutting,
      disabled: !item.active,
      'aria-label': `Consider dropping ${r.name}`,
      onchange: () => toggle(r.id),
    });
    return h(
      'div.list-row',
      {
        style: item.active ? (item.cutting ? { background: 'var(--accent-soft)' } : null) : { opacity: '0.55' },
        oncontextmenu: (e) => ruleMenu(e, doc, r),
      },
      h('label.check', { style: { marginRight: '2px' } }, box, h('span.box', null, icon('check', { size: 12, stroke: 3 }))),
      h('div.avatar', null, scheduleIcon(doc, r)),
      h(
        'div.l-main',
        null,
        h('div.l-title', null, r.name, item.active ? null : h('span.dim', null, ' · paused')),
        h(
          'div.l-sub',
          null,
          `${describe(r)} · ${accountName(doc, r.accountId)}`,
          item.nextDue ? h('span.dim', null, ` · next ${fmtDate(item.nextDue, 'day')}`) : null
        )
      ),
      h(
        'div.col.gap-4',
        { style: { alignItems: 'flex-end' } },
        h('div.l-amount.money-mask', null, `${money(item.perYear, { cents: false })}/yr`),
        h('div.tiny.dim.money-mask', null, `${money(item.perMonth)} a month`)
      ),
      item.active
        ? h(
            'button.btn.ghost.icon.sm',
            { title: 'Edit', onclick: () => openRecurringEditor(r) },
            icon('edit', { size: 15 })
          )
        : h(
            'button.btn.sm.soft',
            {
              onclick: () => {
                commit('Resume subscription', (d) => {
                  const x = d.recurring.find((y) => y.id === r.id);
                  if (x) x.active = true;
                });
                redraw();
              },
            },
            'Resume'
          )
    );
  };

  return h(
    'div.col.gap-16',
    null,
    tiles,
    whatIf,
    h(
      'div.card',
      null,
      h(
        'div.card-head',
        null,
        h('div.h3', null, 'Every subscription, dearest first'),
        h('span.dim.small', null, 'Tick what you could live without')
      ),
      h('div.card-body.flush', null, ...s.items.map(row)),
      h(
        'div.card-foot.small.muted',
        null,
        'Anything can be a subscription — set a schedule’s type to Subscription in its editor ' +
          'and it appears here.'
      )
    )
  );
}

/* --------------------------- upcoming ----------------------------- */

function upcomingList(doc, items, due = items) {
  if (!items.length) {
    return h(
      'div.card.pad',
      null,
      h('div.center.col.gap-8', { style: { padding: '30px' } },
        h('span', { style: { color: 'var(--st-good)' } }, icon('check', { size: 28 })),
        h('div.strong', null, 'Nothing due in this window'),
        h('div.muted.small', null, 'You are all caught up.'))
    );
  }
  const allSkipped = due.length === 0;

  // Group by calendar week so the list reads like a plan, not a wall of rows.
  const groups = new Map();
  for (const item of items) {
    const key = item.overdue ? 'overdue' : weekKey(item.date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  return h(
    'div.col.gap-16',
    null,
    allSkipped
      ? h(
          'div.card.pad.small.muted',
          null,
          'Nothing is actually due in this window — everything in it has been skipped.'
        )
      : null,
    ...[...groups.entries()].map(([key, list]) =>
      h(
        'div.card',
        null,
        h(
          'div.card-head',
          null,
          h(
            'div.row',
            null,
            key === 'overdue'
              ? h('span.badge.bad', null, 'Overdue')
              : h('div.h3', null, weekLabel(key)),
            h('span.dim.small', null, `${list.length} item${list.length === 1 ? '' : 's'}`)
          ),
          h(
            'div.strong.money-mask',
            null,
            // Skipped rows are shown but never counted — the week's total is
            // what is really leaving the account.
            money(
              list.reduce((s, i) => (i.skipped ? s : s + (i.kind === 'income' ? i.amount : -i.amount)), 0),
              { sign: true }
            )
          )
        ),
        h(
          'div.card-body.flush',
          null,
          ...list.map((item) => upcomingRow(doc, item))
        )
      )
    )
  );
}

function upcomingRow(doc, item) {
  const st = dueStatus(item.date);
  const income = item.kind === 'income';
  const nothingDue = item.estimated && item.amount <= 0;
  const skipped = !!item.skipped;
  const posted = !!item.posted;
  return h(
    'div.list-row',
    {
      oncontextmenu: (e) => occurrenceMenu(e, doc, item),
      style: skipped || posted ? { opacity: posted ? '0.75' : '0.6' } : null,
    },
    h(
      'div.avatar',
      {
        style: {
          background: skipped
            ? 'var(--surface-3)'
            : item.overdue
              ? 'var(--neg-soft)'
              : income
                ? 'var(--pos-soft)'
                : 'var(--surface-3)',
        },
      },
      skipped ? '⏭' : posted ? '✅' : scheduleIcon(doc, item.rule)
    ),
    h(
      'div.l-main',
      null,
      h('div.l-title', null, item.rule.name),
      h(
        'div.l-sub',
        null,
        `${fmtDate(item.date, 'weekday')} · ${accountName(doc, item.rule.accountId)}${
          item.rule.categoryId ? ` · ${categoryName(doc, item.rule.categoryId)}` : ''
        }`,
        skipped && item.skip && item.skip.reason
          ? h('span.dim', null, ` · ${item.skip.reason}`)
          : item.note
            ? h('span.dim', null, ` · ${item.note}`)
            : null
      )
    ),
    item.rule.autoPay && !skipped && !posted ? badge('Autopay', 'info') : null,
    posted
      ? badge(income ? 'Received' : 'Paid', 'good')
      : skipped
        ? badge('Skipped')
        : h(`span.badge${st.tone ? `.${st.tone}` : ''}`, null, item.overdue ? st.label : relativeDay(item.date)),
    h(
      'div.col.gap-4',
      { style: { alignItems: 'flex-end' } },
      nothingDue
        ? h('div.l-amount.dim', null, '—')
        : h(
            'div.l-amount.money-mask',
            {
              class: income && !skipped ? 'pos' : '',
              style: skipped ? { textDecoration: 'line-through', color: 'var(--text-3)' } : null,
            },
            // A tilde is the honest signal that this tracks a balance.
            `${item.estimated ? '~' : ''}${money(item.amount)}`
          ),
      item.overridden && !skipped
        ? h('span.tiny.dim', null, 'set for this date')
        : item.estimated && !nothingDue && !skipped
          ? h('span.tiny.dim', null, 'estimated')
          : null
    ),
    posted
      ? null
      : skipped
        ? h(
            'button.btn.sm.soft',
            { onclick: () => unskipOccurrence(item.rule, item.date) },
            icon('refresh', { size: 14 }),
            'Put it back'
          )
        : nothingDue
          ? null
          : h(
              'button.btn.sm.soft',
              { onclick: () => markOccurrencePaid(item.rule, item.date) },
              icon('check', { size: 14 }),
              income ? 'Received' : 'Paid'
            ),
    h('button.btn.ghost.icon.sm', { onclick: (e) => occurrenceMenu(e, doc, item) }, icon('more', { size: 15 }))
  );
}

/** Menu for one dated occurrence, as opposed to the whole schedule. */
function occurrenceMenu(e, doc, item) {
  const { rule, date } = item;
  if (item.posted) {
    contextMenu(e, [
      { label: 'Edit the schedule', icon: 'edit', onClick: () => openRecurringEditor(rule) },
      {
        label: 'Find the transaction',
        icon: 'search',
        onClick: () => navigate('transactions', { search: rule.payee || rule.name }),
      },
    ]);
    return;
  }
  contextMenu(e, [
    item.skipped
      ? {
          label: 'Put this one back',
          icon: 'refresh',
          onClick: () => unskipOccurrence(rule, date),
        }
      : {
          label: rule.kind === 'income' ? 'Record as received' : 'Record as paid',
          icon: 'check',
          onClick: () => markOccurrencePaid(rule, date),
        },
    item.skipped
      ? null
      : {
          label: item.overridden ? 'Change the amount for this date' : `Set the amount for just ${fmtDate(date, 'day')}`,
          icon: 'edit',
          onClick: () => adjustOccurrence(rule, date),
        },
    item.skipped
      ? null
      : {
          label: `Skip just ${fmtDate(date, 'day')}`,
          icon: 'clock',
          onClick: () => skipOccurrence(rule, date),
        },
    { separator: true },
    { label: 'Edit the schedule', icon: 'edit', onClick: () => openRecurringEditor(rule) },
    {
      label: rule.active === false ? 'Resume the schedule' : 'Pause the whole schedule',
      icon: rule.active === false ? 'refresh' : 'clock',
      onClick: () =>
        commit(rule.active === false ? 'Resume schedule' : 'Pause schedule', (d) => {
          const r = d.recurring.find((x) => x.id === rule.id);
          if (r) r.active = r.active === false;
        }),
    },
  ].filter(Boolean));
}

/* ----------------------------- all -------------------------------- */

function allList(doc, rules) {
  const balances = allBalances(doc);
  const byDate = (a, b) => {
    const an = nextDue(a) || '9999';
    const bn = nextDue(b) || '9999';
    return an < bn ? -1 : an > bn ? 1 : 0;
  };
  // Grouped by what kind of obligation it is, then by date inside each group.
  const groups = groupSchedules(doc, [...rules].sort(byDate), (r) => r);
  const sorted = groups.flatMap((g) => g.items);
  const headAt = new Map();
  let seen = 0;
  for (const g of groups) {
    headAt.set(seen, g);
    seen += g.items.length;
  }

  return h(
    'div.card',
    null,
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
            h('th', null, 'Name'),
            h('th', null, 'Schedule'),
            h('th', null, 'Next due'),
            h('th', null, 'Account'),
            h('th.num', null, 'Amount'),
            h('th.num', null, 'Per month'),
            h('th', { style: { width: '54px' } }, '')
          )
        ),
        h(
          'tbody',
          null,
          ...sorted.flatMap((r, index) => {
            const next = nextDue(r);
            const st = dueStatus(next);
            const inactive = r.active === false;
            const group = headAt.get(index);
            const header = group
              ? h(
                  'tr.group-row',
                  null,
                  h('td', { colspan: '7' }, `${group.label} · ${group.items.length}`)
                )
              : null;
            const row = h(
              'tr',
              {
                style: inactive ? { opacity: '0.55' } : null,
                onclick: (e) => {
                  if (e.target.closest('button')) return;
                  openRecurringEditor(r);
                },
                oncontextmenu: (e) => ruleMenu(e, doc, r),
              },
              h(
                'td',
                null,
                h(
                  'div.row.gap-6',
                  null,
                  h('span', null, scheduleIcon(doc, r)),
                  h('span.strong', null, r.name),
                  r.autoPay ? badge('Auto', 'info') : null,
                  inactive ? badge('Paused') : null,
                  (() => {
                    const n = skippedOccurrences(r, { from: today() }).length;
                    return n ? badge(`${n} skipped`) : null;
                  })()
                ),
                r.notes ? h('div.tiny.dim.truncate', null, r.notes) : null
              ),
              h('td.small.muted', null, describe(r)),
              h(
                'td.nowrap',
                null,
                next
                  ? h(
                      'div.col.gap-4',
                      null,
                      h('span', null, fmtDate(next)),
                      h(`span.tiny.${st.tone === 'bad' ? 'neg' : st.tone === 'warn' ? 'warnc' : 'dim'}`, null, st.label)
                    )
                  : h('span.dim', null, '—')
              ),
              h('td.truncate', null, accountName(doc, r.accountId)),
              h(
                'td.num.money-mask',
                { class: r.kind === 'income' ? 'pos' : '' },
                (() => {
                  const resolved = resolveRuleAmount(doc, r, { balances });
                  const prefix = resolved.estimated || r.variableAmount ? '~' : '';
                  return `${prefix}${money(resolved.amount)}`;
                })()
              ),
              h(
                'td.num.dim.money-mask',
                null,
                money((resolveRuleAmount(doc, r, { balances }).amount * perYear(r.frequency)) / 12, { cents: false })
              ),
              h(
                'td',
                null,
                h(
                  'div.rowactions',
                  null,
                  h(
                    'button.btn.ghost.icon.sm',
                    { onclick: (e) => { e.stopPropagation(); ruleMenu(e, doc, r); } },
                    icon('more', { size: 15 })
                  )
                )
              )
            );
            return header ? [header, row] : [row];
          })
        )
      )
    )
  );
}

function ruleMenu(e, doc, rule) {
  const next = nextDue(rule);
  contextMenu(e, [
    next
      ? {
          label: rule.kind === 'income' ? 'Record as received' : 'Record as paid',
          icon: 'check',
          onClick: () => markOccurrencePaid(rule, next),
        }
      : null,
    next
      ? {
          label: `Set the amount for just ${fmtDate(next, 'day')}`,
          icon: 'edit',
          onClick: () => adjustOccurrence(rule, next),
        }
      : null,
    next
      ? {
          label: `Skip just ${fmtDate(next, 'day')}`,
          icon: 'clock',
          onClick: () => skipOccurrence(rule, next),
        }
      : null,
    { label: 'Edit the schedule', icon: 'edit', onClick: () => openRecurringEditor(rule) },
    {
      label: 'Duplicate',
      icon: 'copy',
      onClick: () =>
        openRecurringEditor(null, { ...rule, id: undefined, name: `${rule.name} (copy)` }),
    },
    { separator: true },
    {
      label: rule.active === false ? 'Resume' : 'Pause',
      icon: rule.active === false ? 'refresh' : 'clock',
      onClick: () =>
        commit(rule.active === false ? 'Resume schedule' : 'Pause schedule', (d) => {
          const r = d.recurring.find((x) => x.id === rule.id);
          if (r) r.active = r.active === false;
        }),
    },
    {
      label: 'Delete',
      icon: 'trash',
      danger: true,
      onClick: async () => {
        if (await confirm({ title: `Delete “${rule.name}”?`, confirmLabel: 'Delete', tone: 'danger' })) {
          removeFrom('recurring', rule.id, 'Delete schedule');
        }
      },
    },
  ].filter(Boolean));
}

/* ---------------------------- helpers ----------------------------- */

function weekKey(date) {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);
}

function weekLabel(key) {
  const start = key;
  const end = addDays(key, 6);
  const t = today();
  if (t >= start && t <= end) return 'This week';
  if (addDays(t, 7) >= start && addDays(t, 7) <= end) return 'Next week';
  return `${fmtDate(start, 'day')} – ${fmtDate(end, 'day')}`;
}
