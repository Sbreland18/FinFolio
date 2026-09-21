import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import {
  money, pct, fmtDate, today, addMonths, diffDays, parseAmount, round2, num, monthLabel, monthKey,
} from '../format.js';
import {
  debtsFromAccounts, debtPlan, amortize, utilization, allBalances, accountType,
  minimumPayment, isLiability, accountsMissingPaymentReminder, paymentRuleFor,
  skippedOccurrences, nextPaymentDate, lastPaymentInto, forgivenessProgress,
} from '../finance.js';
import { lineChart, arcMeter, seriesColor } from '../charts.js';
import {
  statTile, emptyState, segmented, badge, modal, moneyInput, readMoney, field, checkbox,
  toast, toastOk,
} from '../ui.js';
import { navigate, state, commit } from '../state.js';
import { page } from '../shell.js';
import {
  openAccountEditor, openTransactionEditor, addPaymentReminders, markOccurrencePaid,
} from '../editors.js';

const ui = { strategy: 'avalanche', extra: null };

export default function debt(doc, params = {}) {
  const everything = debtsFromAccounts(doc);
  const debts = everything.filter((d) => d.inPlan);
  const setAside = everything.filter((d) => !d.inPlan);
  const balances = allBalances(doc);

  if (!everything.length) {
    return page({
      title: 'Debt Payoff',
      children: [
        emptyState({
          icon: 'card',
          title: 'No debt to pay off',
          message:
            'Add a credit card or loan account and FinFolio will build a payoff plan, compare avalanche against snowball, and show what extra payments are worth.',
          action: { label: 'Add a credit card or loan', onClick: () => openAccountEditor() },
        }),
      ],
    });
  }

  if (!debts.length) {
    return page({
      title: 'Debt Payoff',
      children: [
        emptyState({
          icon: 'filter',
          title: 'Every debt is set aside',
          message:
            'Nothing is in the payoff plan at the moment, so there is no order to work out. ' +
            'Put at least one debt back in and the avalanche and snowball comparison returns.',
          action: { label: 'Choose debts', onClick: () => openPlanChooser(doc, everything, params) },
        }),
        setAsideCard(doc, setAside, params),
      ],
    });
  }

  if (ui.extra === null) ui.extra = 0;
  const extra = Math.max(0, Number(ui.extra) || 0);

  const minTotal = round2(debts.reduce((s, d) => s + d.minPayment, 0));
  const totalOwed = round2(debts.reduce((s, d) => s + d.balance, 0));
  const weightedApr = totalOwed
    ? round2(debts.reduce((s, d) => s + d.apr * d.balance, 0) / totalOwed)
    : 0;

  const asideOwed = round2(setAside.reduce((s, d) => s + d.balance, 0));
  const missingReminders = accountsMissingPaymentReminder(doc);
  // The plan advances a month at a time, so it should start on the first day a
  // payment is genuinely due — not on whatever day this screen was opened.
  const planStart = debts.map((d) => d.nextPayment).filter(Boolean).sort()[0] || today();
  const opts = { startDate: planStart };
  const basePlan = debtPlan(debts, 0, ui.strategy, opts);
  const plan = debtPlan(debts, extra, ui.strategy, opts);
  const avalanche = debtPlan(debts, extra, 'avalanche', opts);
  const snowball = debtPlan(debts, extra, 'snowball', opts);

  const monthsSaved = Math.max(0, basePlan.months - plan.months);
  const interestSaved = round2(Math.max(0, basePlan.totalInterest - plan.totalInterest));

  /* ------------------------- extra payment ----------------------- */

  const extraInput = h('input.input.amount', {
    type: 'text',
    inputMode: 'decimal',
    value: extra ? extra.toFixed(2) : '0.00',
    style: { width: '120px' },
    onchange: (e) => {
      ui.extra = parseAmount(e.target.value);
      navigate('debt', params);
    },
  });
  const slider = h('input.range', {
    type: 'range',
    min: 0,
    max: Math.max(500, Math.ceil((minTotal * 1.5) / 50) * 50),
    step: 25,
    value: Math.min(extra, Math.max(500, Math.ceil((minTotal * 1.5) / 50) * 50)),
    oninput: (e) => {
      extraInput.value = Number(e.target.value).toFixed(2);
    },
    onchange: (e) => {
      ui.extra = Number(e.target.value);
      navigate('debt', params);
    },
  });

  /* --------------------------- chart ----------------------------- */

  const chartHost = h('div.chart-wrap');
  const labels = plan.timeline.map((t) => t.date);
  requestAnimationFrame(() =>
    lineChart(chartHost, {
      height: 240,
      labels: labels.length ? labels : [today()],
      // The comparison line only appears once there is something to compare.
      series: [
        {
          name: extra > 0 ? 'With extra payment' : 'Remaining debt',
          values: plan.timeline.map((t) => t.remaining),
          color: 'var(--s3)',
        },
        extra > 0
          ? {
              name: 'Minimums only',
              values: labels.map((_, i) => (basePlan.timeline[i] ? basePlan.timeline[i].remaining : 0)),
              color: 'var(--s2)',
              dashed: true,
            }
          : null,
      ].filter(Boolean),
      yFormat: (v) => money(v, { cents: false, compact: true }),
      // The payoff timeline spans years, so axis ticks carry the year.
      xFormat: (d, _i, full) => (full ? fmtDate(d, 'medium') : monthLabel(monthKey(d))),
      tipFormat: (v) => money(v),
      area: false,
      ariaLabel: 'Remaining debt over time',
    })
  );

  /* -------------------------- payoff order ----------------------- */

  const order = [...debts].sort((a, b) => {
    if (ui.strategy === 'snowball') return a.balance - b.balance || b.apr - a.apr;
    if (ui.strategy === 'custom') return (a.order || 0) - (b.order || 0);
    return b.apr - a.apr || a.balance - b.balance;
  });

  const orderList = order.map((d, i) => {
    const result = plan.debts.find((x) => x.id === d.id) || {};
    const acct = doc.accounts.find((a) => a.id === d.id);
    const u = acct && acct.type === 'credit' ? utilization(acct, -d.balance) : null;
    return h(
      'div.list-row',
      null,
      h(
        'div.avatar',
        { style: { background: i === 0 ? 'var(--accent-soft)' : 'var(--surface-3)', color: i === 0 ? 'var(--accent-text)' : 'inherit', fontWeight: '700', fontSize: '13px' } },
        String(i + 1)
      ),
      h(
        'div.l-main',
        null,
        h(
          'div.row.gap-6',
          null,
          h('span.l-title', null, d.name),
          i === 0 ? badge('Focus here', 'accent') : null,
          u !== null && u >= 70 ? badge(`${pct(u, 0)} used`, 'bad') : null,
          paymentRuleFor(doc, d.id) ? badge('In bills', 'good') : badge('Not in bills', 'warn'),
          d.forgiveness
            ? badge(`${d.forgiveness.made}/${d.forgiveness.required} to forgiveness`, 'accent')
            : null,
          (() => {
            const rule = paymentRuleFor(doc, d.id);
            const n = rule ? skippedOccurrences(rule, { from: today() }).length : 0;
            return n ? badge(`${n} skipped`, 'warn') : null;
          })()
        ),
        h(
          'div.l-sub',
          null,
          `${money(d.balance)} at ${num(d.apr, 2)}% · minimum ${money(d.minPayment)}`,
          d.nextPayment
            ? h(
                'span',
                { class: d.nextPayment < today() ? 'neg' : 'dim' },
                ` · ${d.nextPayment < today() ? 'overdue since' : 'next'} ${fmtDate(d.nextPayment, 'day')}`
              )
            : null,
          (() => {
            const rule = paymentRuleFor(doc, d.id);
            const next = rule ? skippedOccurrences(rule, { from: today() })[0] : null;
            // The payoff maths below assumes every payment is made, so say
            // plainly that a skipped one pushes the date out.
            return next
              ? h('span.warnc', null, ` · skipping ${fmtDate(next.date, 'day')} pushes this out`)
              : null;
          })()
        )
      ),
      h(
        'div.col.gap-4',
        { style: { alignItems: 'flex-end' } },
        h(
          'div.l-amount',
          { class: result.forgiven ? 'pos' : '' },
          result.payoffDate ? fmtDate(result.payoffDate, 'medium') : '—'
        ),
        h(
          'div.tiny.dim',
          null,
          result.forgiven
            ? `forgiven · ${d.forgiveness.made} of ${d.forgiveness.required} payments`
            : result.months
              ? `${result.months} months · ${money(result.interest, { cents: false })} interest`
              : ''
        )
      ),
      h(
        'button.btn.ghost.icon.sm',
        { title: 'Details', onclick: () => showDebtDetail(doc, d, { plan, strategy: ui.strategy, extra }) },
        icon('chevronRight', { size: 16 })
      )
    );
  });

  /* ------------------------ strategy compare --------------------- */

  const compare = h(
    'div.card',
    null,
    h('div.card-head', null, h('div.h3', null, 'Avalanche vs snowball'), h('div.small.muted', null, `with ${money(extra)} extra`)),
    h(
      'div.card-body',
      null,
      h(
        'div.grid.grid-2',
        null,
        strategyBox('Avalanche', 'Highest interest rate first — mathematically cheapest', avalanche, ui.strategy === 'avalanche', () => {
          ui.strategy = 'avalanche';
          navigate('debt', params);
        }),
        strategyBox('Snowball', 'Smallest balance first — quickest first win', snowball, ui.strategy === 'snowball', () => {
          ui.strategy = 'snowball';
          navigate('debt', params);
        })
      ),
      avalanche.months && snowball.months
        ? h(
            'p.muted.small.mt-16',
            null,
            snowball.totalInterest > avalanche.totalInterest
              ? `Avalanche saves ${money(snowball.totalInterest - avalanche.totalInterest)} in interest and ${Math.abs(snowball.months - avalanche.months)} month${Math.abs(snowball.months - avalanche.months) === 1 ? '' : 's'} versus snowball. Snowball can still be the better choice if clearing a small balance early keeps you motivated.`
              : 'Both strategies cost about the same here — pick whichever you will stick with.'
          )
        : null
    )
  );

  /* --------------------------- cards ----------------------------- */

  const liabilityAccounts = (doc.accounts || []).filter((a) => !a.archived && isLiability(a.type));

  return page({
    title: 'Debt Payoff',
    subtitle: `${debts.length} debt${debts.length === 1 ? '' : 's'} · ${money(totalOwed)} owed`,
    actions: [
      missingReminders.length
        ? h(
            'button.btn',
            { onclick: () => addPaymentReminders(missingReminders) },
            icon('bell', { size: 15 }),
            'Add payments to bills'
          )
        : null,
      h('button.btn', { onclick: () => openAccountEditor() }, icon('plus', { size: 15 }), 'Add debt'),
    ].filter(Boolean),
    children: [
      missingReminders.length
        ? h(
            'div.card.pad',
            { style: { borderLeft: '3px solid var(--st-warning)' } },
            h(
              'div.row',
              null,
              h('span', { style: { color: 'var(--st-warning)', display: 'flex' } }, icon('bell', { size: 18 })),
              h(
                'div.grow',
                null,
                h(
                  'div.strong',
                  null,
                  `${missingReminders.length} of these is not in Bills & Income`
                ),
                h(
                  'div.muted.small.mt-4',
                  null,
                  'Adding them puts each due date on your calendar and in the forecast, with the minimum payment kept up to date as the balance changes.'
                )
              ),
              h(
                'button.btn.primary',
                { onclick: () => addPaymentReminders(missingReminders) },
                icon('plus', { size: 15 }),
                'Add them'
              )
            )
          )
        : null,
      h(
        'div.kpi-grid',
        null,
        statTile({
          label: setAside.length ? 'Owed in this plan' : 'Total owed',
          value: money(totalOwed),
          sub: setAside.length ? `${money(asideOwed, { cents: false })} set aside` : '',
          tone: 'neg',
        }),
        statTile({ label: 'Minimum payments', value: money(minTotal), sub: 'per month' }),
        statTile({ label: 'Average rate', value: `${num(weightedApr, 2)}%`, sub: 'weighted by balance' }),
        statTile({
          // Calling it "Debt-free" while a mortgage sits outside the plan would
          // be a comfortable lie.
          label: setAside.length ? 'Plan finishes' : 'Debt-free',
          value: plan.payoffDate ? fmtDate(plan.payoffDate, 'medium') : '—',
          sub: plan.months
            ? setAside.length
              ? `${plan.months} months · ${setAside.length} debt${setAside.length === 1 ? '' : 's'} not counted`
              : `${plan.months} months`
            : '',
          tone: 'pos',
        })
      ),
      h(
        'div.card.pad',
        null,
        h(
          'div.row.wrap.gap-16',
          null,
          h(
            'div',
            null,
            h('div.label', null, 'Extra payment each month'),
            h('div.row.gap-12.mt-4', null, extraInput, h('div', { style: { width: '220px' } }, slider))
          ),
          h('div.grow'),
          h(
            'div.row.gap-20',
            null,
            h(
              'div.stat',
              null,
              h('div.stat-label', null, 'Time saved'),
              h('div.stat-value', { style: { fontSize: '20px' } }, monthsSaved ? `${monthsSaved} mo` : '—')
            ),
            h(
              'div.stat',
              null,
              h('div.stat-label', null, 'Interest saved'),
              h('div.stat-value.pos', { style: { fontSize: '20px' } }, interestSaved ? money(interestSaved, { cents: false }) : '—')
            ),
            h(
              'div.stat',
              null,
              h('div.stat-label', null, 'Total budget'),
              h('div.stat-value', { style: { fontSize: '20px' } }, money(plan.monthlyBudget, { cents: false }))
            )
          )
        )
      ),
      h(
        'div.card',
        null,
        h(
          'div.card-head',
          null,
          h('div.h2', null, 'Remaining debt over time'),
          segmented(
            [
              { value: 'avalanche', label: 'Avalanche' },
              { value: 'snowball', label: 'Snowball' },
            ],
            ui.strategy,
            (v) => {
              ui.strategy = v;
              navigate('debt', params);
            }
          )
        ),
        h('div.card-body', null, chartHost)
      ),
      h(
        'div.split',
        null,
        h(
          'div.card',
          null,
          h(
            'div.card-head',
            null,
            h('div.h2', null, 'Payoff order'),
            h(
              'div.row.gap-8',
              null,
              h(
                'div.small.muted',
                null,
                ui.strategy === 'snowball' ? 'Smallest balance first' : 'Highest rate first'
              ),
              h(
                'button.btn.sm',
                { onclick: () => openPlanChooser(doc, everything, params) },
                icon('filter', { size: 14 }),
                setAside.length ? `${debts.length} of ${everything.length} debts` : 'Choose debts'
              )
            )
          ),
          // The dates in this list are plan dates, and for the focus debt they
          // are much earlier than that debt would manage on its own. Saying so
          // here is what stops the detail dialog reading as a contradiction.
          h(
            'div.card-body',
            { style: { paddingBottom: '0' } },
            h(
              'p.muted.small',
              null,
              `Dates below are from this ${ui.strategy === 'snowball' ? 'snowball' : ui.strategy === 'custom' ? 'custom-order' : 'avalanche'} plan, `,
              'where every debt that clears rolls its payment into the next one',
              extra ? `, on top of the ${money(extra)} extra each month` : '',
              '. Open any debt to see what it would do on its own.'
            )
          ),
          h('div.card-body.flush', null, ...orderList)
        ),
        h(
          'div.col.gap-16',
          null,
          ...liabilityAccounts
            .filter((a) => a.type === 'credit')
            .map((a) =>
              utilisationCard(a, balances.get(a.id) || 0, {
                // The meter is the most eye-catching thing on the screen and
                // was the one thing you could not click.
                onOpen: () => {
                  const d = everything.find((x) => x.id === a.id);
                  if (d) showDebtDetail(doc, d, { plan, strategy: ui.strategy, extra });
                  else openAccountEditor(a);
                },
              })
            )
        )
      ),
      setAside.length ? setAsideCard(doc, setAside, params) : null,
      compare,
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Choosing which debts the plan is actually about                     */
/*                                                                     */
/* A 30-year mortgage at 5% swamps an avalanche: it is the biggest     */
/* balance and nearly the lowest rate, so snowball puts it last and    */
/* avalanche buries it — either way it drags the finish line out by    */
/* decades and hides the progress being made on the debts someone is   */
/* actually attacking. Setting it aside is a real plan, not denial.    */
/* ------------------------------------------------------------------ */

function setAsideDebt(doc, id, aside) {
  const account = doc.accounts.find((a) => a.id === id);
  commit(aside ? 'Set a debt aside' : 'Add a debt to the plan', (d) => {
    const a = d.accounts.find((x) => x.id === id);
    if (a) {
      a.inPayoffPlan = !aside;
      a.updatedAt = new Date().toISOString();
    }
  });
  toast(
    aside
      ? `${account ? account.name : 'Debt'} set aside — its minimum is still being paid`
      : `${account ? account.name : 'Debt'} is back in the plan`
  );
}

function openPlanChooser(doc, everything, params) {
  const boxes = new Map();

  const rows = everything.map((d) => {
    const account = doc.accounts.find((a) => a.id === d.id);
    const type = account ? accountType(account.type) : { icon: '📄', label: '' };
    const box = checkbox('', { checked: d.inPlan });
    boxes.set(d.id, box);
    return h(
      'div.list-row',
      { onclick: (e) => { if (!e.target.closest('label')) box.querySelector('input').click(); } },
      h('div.avatar', null, type.icon),
      h(
        'div.l-main',
        null,
        h('div.l-title', null, d.name),
        h(
          'div.l-sub',
          null,
          `${type.label} · ${money(d.balance)} at ${num(d.apr, 2)}% · minimum ${money(d.minPayment)}`,
          d.forgiveness ? h('span.dim', null, ' · heading for forgiveness') : null
        )
      ),
      box
    );
  });

  const setAll = (fn) => {
    for (const d of everything) {
      boxes.get(d.id).querySelector('input').checked = fn(d, doc);
    }
  };

  const m = modal({
    title: 'Which debts is this plan about?',
    size: 'md',
    body: h(
      'div.col.gap-14',
      null,
      h(
        'p.muted.small',
        null,
        'Unticked debts drop out of the avalanche and snowball order and out of the finish ' +
          'date. Nothing else changes — they keep their place in Bills & Income, their ' +
          'minimum still leaves your account, and their balance still counts in net worth.'
      ),
      h(
        'div.row.wrap.gap-6',
        null,
        h('span.small.muted', null, 'Quick set:'),
        h('button.btn.sm', { onclick: () => setAll(() => true) }, 'Everything'),
        h(
          'button.btn.sm',
          {
            onclick: () =>
              setAll((d) => {
                const a = doc.accounts.find((x) => x.id === d.id);
                return !!a && a.type !== 'mortgage';
              }),
          },
          'All but the mortgage'
        ),
        h(
          'button.btn.sm',
          {
            onclick: () =>
              setAll((d) => {
                const a = doc.accounts.find((x) => x.id === d.id);
                return !!a && a.type !== 'mortgage' && a.type !== 'student-loan' && !d.forgiveness;
              }),
          },
          'Cards and short-term debt'
        ),
        h(
          'button.btn.sm',
          {
            onclick: () =>
              setAll((d) => {
                const a = doc.accounts.find((x) => x.id === d.id);
                return !!a && a.type === 'credit';
              }),
          },
          'Cards only'
        )
      ),
      h('div.card', null, h('div.card-body.flush', null, ...rows))
    ),
    footer: [
      h('button.btn', { onclick: () => m.close() }, 'Cancel'),
      h(
        'button.btn.primary',
        {
          onclick: () => {
            const wanted = new Map(
              everything.map((d) => [d.id, boxes.get(d.id).querySelector('input').checked])
            );
            commit('Choose payoff-plan debts', (d) => {
              for (const account of d.accounts) {
                if (!wanted.has(account.id)) continue;
                const next = wanted.get(account.id);
                if ((account.inPayoffPlan !== false) === next) continue;
                account.inPayoffPlan = next;
                account.updatedAt = new Date().toISOString();
              }
            });
            m.close();
            const kept = [...wanted.values()].filter(Boolean).length;
            toastOk(`Planning ${kept} of ${everything.length} debts`);
            navigate('debt', params);
          },
        },
        'Save',
      ),
    ],
  });
}

/** Debts deliberately left out — shown so they are set aside, not forgotten. */
function setAsideCard(doc, setAside, params) {
  return h(
    'div.card',
    null,
    h(
      'div.card-head',
      null,
      h('div.h3', null, 'Set aside from this plan'),
      h(
        'span.dim.small',
        null,
        `${money(round2(setAside.reduce((s, d) => s + d.balance, 0)))} owed · minimums still paid`
      )
    ),
    h(
      'div.card-body.flush',
      null,
      ...setAside.map((d) => {
        const account = doc.accounts.find((a) => a.id === d.id);
        const type = account ? accountType(account.type) : { icon: '📄', label: '' };
        return h(
          'div.list-row',
          { style: { opacity: '0.8' } },
          h('div.avatar', null, type.icon),
          h(
            'div.l-main',
            null,
            h('div.l-title', null, d.name),
            h(
              'div.l-sub',
              null,
              `${money(d.balance)} at ${num(d.apr, 2)}% · minimum ${money(d.minPayment)} a month`,
              d.forgiveness
                ? h('span.dim', null, ` · ${d.forgiveness.made} of ${d.forgiveness.required} toward forgiveness`)
                : null
            )
          ),
          h(
            'button.btn.sm.soft',
            { onclick: () => { setAsideDebt(doc, d.id, false); navigate('debt', params); } },
            'Add to plan'
          )
        );
      })
    ),
    h(
      'div.card-foot.small.muted',
      null,
      'These are still real debts. Their minimum payments are already out of the money ' +
        'available above, and they still count against your net worth.'
    )
  );
}

/** "14 months", "2 years" — how much earlier one date is than another. */
function monthsBetween(from, to) {
  const months = Math.max(0, Math.round(diffDays(from, to) / 30.44));
  if (months < 2) return 'a month';
  if (months < 24) return `${months} months`;
  const years = Math.round(months / 12);
  return `${years} years`;
}

function strategyBox(title, blurb, plan, active, onClick) {
  return h(
    'button.card.pad',
    {
      onclick: onClick,
      style: {
        textAlign: 'left',
        borderColor: active ? 'var(--accent)' : 'var(--border)',
        background: active ? 'var(--accent-soft)' : 'var(--surface)',
        cursor: 'pointer',
      },
    },
    h('div.row', null, h('div.h3', null, title), active ? badge('Selected', 'accent') : null),
    h('p.muted.tiny.mt-4', null, blurb),
    h(
      'dl.kv.mt-12',
      null,
      h('dt', null, 'Debt-free'),
      h('dd', null, plan.payoffDate ? fmtDate(plan.payoffDate, 'medium') : '—'),
      h('dt', null, 'Months'),
      h('dd', null, String(plan.months || '—')),
      h('dt', null, 'Total interest'),
      h('dd', null, money(plan.totalInterest, { cents: false }))
    )
  );
}

function utilisationCard(account, balance, { onOpen = null } = {}) {
  const u = utilization(account, balance);
  const owed = Math.abs(balance);
  const clickable = onOpen
    ? { onclick: onOpen, style: { cursor: 'pointer' }, role: 'button', tabindex: '0',
        title: `Open ${account.name}`,
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } } }
    : null;

  if (u === null) {
    return h(
      'div.card.pad',
      clickable,
      h('div.h3', null, account.name),
      h('p.muted.small.mt-4', null, `${money(owed)} owed. Add a credit limit to track utilisation.`)
    );
  }
  const limit = Number(account.creditLimit) || 0;
  const available = limit - owed;
  const tone = u >= 70 ? 'var(--st-critical)' : u >= 30 ? 'var(--st-warning)' : 'var(--st-good)';
  return h(
    'div.card.pad',
    clickable,
    h(
      'div.row.gap-16',
      null,
      arcMeter({ value: Math.min(u, 100), max: 100, size: 92, thickness: 9, color: tone, label: `${Math.round(u)}%` }),
      h(
        'div.grow',
        null,
        h('div.h3', null, account.name),
        h('div.muted.small.mt-4', null, `${money(owed)} of ${money(limit, { cents: false })}`),
        available >= 0
          ? h('div.muted.small', null, `${money(available, { cents: false })} available`)
          : h('div.small.neg.strong', null, `${money(-available, { cents: false })} over the limit`),
        h(
          'div.tiny.mt-8',
          { style: { color: tone, fontWeight: '600' } },
          u >= 100
            ? 'Over the limit — expect fees and a credit-score hit'
            : u >= 70
              ? 'High utilisation hurts your score'
              : u >= 30
                ? 'Aim to stay under 30%'
                : 'Healthy utilisation'
        )
      )
    )
  );
}

function showDebtDetail(doc, debt, { plan = null, strategy = 'avalanche', extra = 0 } = {}) {
  const acct = doc.accounts.find((a) => a.id === debt.id);
  const payment = debt.minPayment;
  const start = debt.nextPayment || nextPaymentDate(doc, debt.id);
  const sched = amortize({
    principal: debt.balance,
    annualRate: debt.apr,
    payment,
    startDate: start,
    skipMonths: debt.skipMonths,
  });
  const skips = (debt.skipMonths || []).length;
  const rule = paymentRuleFor(doc, debt.id);
  const last = debt.lastPayment || lastPaymentInto(doc, debt.id);
  const overdue = start < today();
  // The screen behind this dialog shows a different, earlier date for the same
  // debt, because there every other debt's payment rolls into this one once it
  // clears. Showing one number without the other reads as a contradiction.
  const inPlan = plan ? (plan.debts || []).find((x) => x.id === debt.id) : null;
  const strategyName = strategy === 'snowball' ? 'snowball' : strategy === 'custom' ? 'custom-order' : 'avalanche';
  const forgiveness = debt.forgiveness || (acct ? forgivenessProgress(doc, acct) : null);

  const body = h(
    'div.col.gap-16',
    null,
    h(
      'div.grid.grid-3',
      null,
      h('div.stat', null, h('div.stat-label', null, 'Balance'), h('div.stat-value', { style: { fontSize: '22px' } }, money(debt.balance))),
      h('div.stat', null, h('div.stat-label', null, 'Rate'), h('div.stat-value', { style: { fontSize: '22px' } }, `${num(debt.apr, 2)}%`)),
      h('div.stat', null, h('div.stat-label', null, 'Payment'), h('div.stat-value', { style: { fontSize: '22px' } }, money(payment)))
    ),
    sched.error
      ? h(
          'div.card.pad',
          { style: { borderLeft: '3px solid var(--st-critical)' } },
          h('div.strong.neg', null, 'This payment never clears the balance'),
          h('p.muted.small.mt-4', null, `Interest alone is about ${money((debt.balance * debt.apr) / 100 / 12)} a month. Pay at least ${money(sched.minimumViable)} to make progress.`)
        )
      : h(
          'dl.kv',
          null,
          h('dt', null, 'Next payment'),
          h(
            'dd',
            { class: overdue ? 'neg' : '' },
            fmtDate(start, 'long'),
            overdue ? ' · overdue' : ''
          ),
          ...(last
            ? [
                h('dt', null, 'Last payment recorded'),
                h('dd', null, `${fmtDate(last.date, 'long')} · ${money(last.amount)}`),
              ]
            : []),
          ...(forgiveness
            ? [
                h('dt', null, 'Qualifying payments'),
                h('dd', null, `${forgiveness.made} of ${forgiveness.required}`),
                h('dt', null, 'Forgiven around'),
                h(
                  'dd.pos',
                  null,
                  forgiveness.projectedDate ? fmtDate(forgiveness.projectedDate, 'long') : 'Eligible now'
                ),
              ]
            : []),
          ...(inPlan && inPlan.payoffDate && !forgiveness
            ? [
                h('dt.strong', null, `Cleared in your ${strategyName} plan`),
                h('dd.strong.pos', null, fmtDate(inPlan.payoffDate, 'long')),
              ]
            : []),
          h('dt', null, 'On its own, paid off'), h('dd', null, fmtDate(sched.payoffDate, 'long')),
          h('dt', null, 'On its own, months left'), h('dd', null, String(sched.months)),
          h('dt', null, 'On its own, interest'), h('dd', null, money(sched.totalInterest)),
          h('dt', null, 'On its own, total paid'), h('dd', null, money(sched.totalPaid))
        ),
    forgiveness
      ? h(
          'div.card.pad.small',
          { style: { background: 'var(--accent-soft)', borderColor: 'transparent' } },
          h(
            'div.strong',
            null,
            forgiveness.complete
              ? 'You have made every qualifying payment'
              : `${forgiveness.remaining} qualifying payment${forgiveness.remaining === 1 ? '' : 's'} to go`
          ),
          h(
            'div.mt-8',
            null,
            h(
              'div.bar',
              null,
              h('i.good', { style: { width: `${Math.min(100, forgiveness.percent)}%` } })
            )
          ),
          h(
            'div.muted.mt-8',
            null,
            'What matters here is the number of payments, not the balance. The payoff figures ' +
              'below assume you pay this loan off yourself, which is not the plan — and the ' +
              'payoff planner deliberately sends spare money to your other debts instead of ' +
              'this one, because a dollar paid early here is a dollar that would have been ' +
              'written off.'
          )
        )
      : inPlan && inPlan.payoffDate && !sched.error
        ? h(
            'div.card.pad.small',
            { style: { background: 'var(--accent-soft)', borderColor: 'transparent' } },
            h(
              'div.strong',
              null,
              inPlan.payoffDate < sched.payoffDate
                ? `Your plan clears this ${monthsBetween(inPlan.payoffDate, sched.payoffDate)} sooner`
                : 'Why the two dates differ'
            ),
            h(
              'div.muted.mt-4',
              null,
              inPlan.payoffDate < sched.payoffDate
                ? `On its own at ${money(payment)} a month this runs to ${fmtDate(sched.payoffDate, 'medium')}. ` +
                  `In the ${strategyName} plan it is first in line, so every debt that clears rolls its ` +
                  `payment into this one${extra ? `, on top of the ${money(extra)} extra each month` : ''} — ` +
                  `and it is gone by ${fmtDate(inPlan.payoffDate, 'medium')}.`
                : `The figures below are this debt alone at ${money(payment)} a month. The plan pays ` +
                  'the others down first, so this one waits its turn and clears later.'
            )
          )
        : null,
    acct && acct.type === 'credit' && !sched.error
      ? h(
          'p.muted.small',
          null,
          `This assumes you keep paying ${money(payment)} every month. A card's stated minimum ` +
            'falls as the balance does, so paying whatever the statement asks for each month ' +
            'takes considerably longer than the date above.'
        )
      : null,
    skips
      ? h(
          'div.card.pad.small',
          { style: { borderLeft: '3px solid var(--st-warning)' } },
          `${skips} payment${skips === 1 ? ' is' : 's are'} skipped. Interest still runs in ` +
            `${skips === 1 ? 'that month' : 'those months'}, so the payoff date below already ` +
            'includes the delay.'
        )
      : null,
    sched.rows.length
      ? h(
          'div',
          null,
          h('div.h3.mb-8', null, 'Schedule'),
          h(
            'div.scrollbox',
            null,
            h(
              'table.table',
              null,
              h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Date'), h('th.num', null, 'Payment'), h('th.num', null, 'Interest'), h('th.num', null, 'Principal'), h('th.num', null, 'Balance'))),
              h(
                'tbody',
                null,
                ...sched.rows.slice(0, 360).map((r) =>
                  h(
                    'tr',
                    r.skipped ? { style: { opacity: '0.62' } } : null,
                    h('td.dim', null, String(r.n)),
                    h('td', null, fmtDate(r.date), r.skipped ? h('span.dim', null, ' · skipped') : null),
                    h('td.num', null, r.skipped ? h('span.dim', null, '—') : money(r.payment)),
                    h('td.num.neg', null, money(r.interest)),
                    h('td.num.pos', null, r.skipped ? h('span.dim', null, '—') : money(r.principal)),
                    h('td.num', null, money(r.balance))
                  )
                )
              )
            )
          )
        )
      : null
  );

  const m = modal({
    title: debt.name,
    subtitle: acct ? accountType(acct.type).label : '',
    size: 'lg',
    body,
    footer: [
      acct ? h('button.btn.left', { onclick: () => { m.close(); openAccountEditor(acct); } }, icon('edit', { size: 15 }), 'Edit account') : null,
      acct
        ? h(
            'button.btn',
            {
              onclick: () => {
                m.close();
                setAsideDebt(doc, acct.id, acct.inPayoffPlan !== false);
                navigate('debt', {});
              },
            },
            acct.inPayoffPlan === false ? 'Add to the plan' : 'Set aside'
          )
        : null,
      acct
        ? h(
            'button.btn',
            { onclick: () => { m.close(); navigate('transactions', { accountId: acct.id }); } },
            'Transactions'
          )
        : null,
      h('button.btn', { onclick: () => m.close() }, 'Close'),
      acct
        ? h(
            'button.btn.primary',
            {
              onclick: () => {
                m.close();
                // Going through the schedule when there is one is what lets the
                // occurrence register as paid everywhere else. A plain transfer
                // recorded here used to leave the bill looking still due.
                if (rule) markOccurrencePaid(rule, start);
                else {
                  openTransactionEditor(null, {
                    type: 'transfer',
                    transferAccountId: acct.id,
                    amount: payment,
                    date: start,
                  });
                }
              },
            },
            'Record a payment'
          )
        : null,
    ].filter(Boolean),
  });
}
