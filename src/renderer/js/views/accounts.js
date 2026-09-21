import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { money, pct, fmtDate, today, addMonths, endOfMonth, round2 } from '../format.js';
import {
  ACCOUNT_TYPES, accountType, isLiability, allBalances, clearedBalance, netWorth,
  utilization, minimumPayment, amortize, balanceOf, nextPaymentDate, skippedPaymentMonths,
  isAmortising, forgivenessProgress, availableCredit,
} from '../finance.js';
import { sparkline, arcMeter } from '../charts.js';
import { emptyState, badge, contextMenu, confirm, statTile, select, modal, toast } from '../ui.js';
import { navigate, state, commit, setSetting } from '../state.js';
import { page } from '../shell.js';
import { openAccountEditor, openTransactionEditor } from '../editors.js';

export default function accounts(doc, params = {}) {
  const showArchived = !!params.showArchived;
  const balances = allBalances(doc);
  const nw = netWorth(doc);

  const list = (doc.accounts || []).filter((a) => showArchived || !a.archived);
  const sortMode = (doc.settings || {}).accountSort || 'type';
  const order = sortAccounts(doc, list, sortMode, balances);
  const assets = order.filter((a) => !isLiability(a.type));
  const debts = order.filter((a) => isLiability(a.type));

  if (!list.length) {
    return page({
      title: 'Accounts',
      children: [
        emptyState({
          icon: 'wallet',
          title: 'No accounts yet',
          message: 'Add checking, savings, credit cards and loans to see your full picture.',
          action: { label: 'Add an account', onClick: () => openAccountEditor() },
        }),
      ],
    });
  }

  const cards = list.filter((a) => a.type === 'credit' && Number(a.creditLimit) > 0);
  const cardLimit = round2(cards.reduce((s, a) => s + (Number(a.creditLimit) || 0), 0));
  const cardAvailable = round2(
    cards.reduce((s, a) => s + (availableCredit(a, balances.get(a.id) || 0) || 0), 0)
  );

  const summary = h(
    'div.kpi-grid',
    null,
    statTile({ label: 'Assets', value: money(nw.assets), sub: `${assets.length} accounts` }),
    statTile({ label: 'Debt', value: money(nw.debt), sub: `${debts.length} accounts`, tone: nw.debt > 0 ? 'neg' : '' }),
    statTile({ label: 'Net worth', value: money(nw.net), tone: nw.net < 0 ? 'neg' : '' }),
    // Headroom across every card is worth its own tile: it is the number
    // people reach for before a big purchase.
    cards.length
      ? statTile({
          label: 'Credit available',
          value: money(cardAvailable, { cents: false }),
          sub: `of ${money(cardLimit, { cents: false })} across ${cards.length} card${cards.length === 1 ? '' : 's'}`,
          tone: cardAvailable < 0 ? 'neg' : 'pos',
        })
      : statTile({
          label: 'Uncleared',
          value: money(
            list.reduce((sum, a) => sum + ((balances.get(a.id) || 0) - clearedBalance(doc, a.id)), 0)
          ),
          sub: 'Difference from bank-cleared',
        })
  );

  return page({
    title: 'Accounts',
    subtitle: `${list.length} account${list.length === 1 ? '' : 's'}`,
    actions: [
      select(
        [
          { value: 'type', label: 'By type' },
          { value: 'name', label: 'By name' },
          { value: 'balance', label: 'By balance' },
          { value: 'custom', label: 'My own order' },
        ],
        {
          value: sortMode,
          'aria-label': 'Sort accounts',
          onchange: (e) => {
            setSetting('accountSort', e.target.value);
            if (e.target.value === 'custom') seedCustomOrder(doc, order);
            navigate('accounts', params);
          },
          style: { width: '150px' },
        }
      ),
      sortMode === 'custom'
        ? h(
            'button.btn',
            { onclick: () => openReorder(doc, params) },
            icon('more', { size: 15 }),
            'Reorder'
          )
        : null,
      h(
        'button.btn',
        { onclick: () => navigate('accounts', { showArchived: !showArchived }) },
        icon('archive', { size: 15 }),
        showArchived ? 'Hide archived' : 'Show archived'
      ),
      h('button.btn.primary', { onclick: () => openAccountEditor() }, icon('plus', { size: 15 }), 'New account'),
    ],
    children: [
      summary,
      assets.length
        ? h(
            'div',
            null,
            h('div.eyebrow.mb-8', null, 'Assets'),
            h('div.grid.grid-auto', null, ...assets.map((a) => accountCard(doc, a, balances)))
          )
        : null,
      debts.length
        ? h(
            'div',
            null,
            h('div.eyebrow.mb-8', null, 'Debts'),
            h('div.grid.grid-auto', null, ...debts.map((a) => accountCard(doc, a, balances)))
          )
        : null,
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Ordering                                                            */
/* ------------------------------------------------------------------ */

/**
 * Assets and debts are always shown apart — that split is what makes the page
 * readable. Sorting decides the order inside each of those.
 */
function sortAccounts(doc, list, mode, balances) {
  const rows = [...list];
  const byName = (a, b) => String(a.name).localeCompare(String(b.name));
  switch (mode) {
    case 'name':
      return rows.sort(byName);
    case 'balance':
      // Largest first in absolute terms, so the biggest debt leads the debts
      // just as the biggest asset leads the assets.
      return rows.sort(
        (a, b) => Math.abs(balances.get(b.id) || 0) - Math.abs(balances.get(a.id) || 0) || byName(a, b)
      );
    case 'custom':
      return rows.sort(
        (a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0) || byName(a, b)
      );
    default: {
      const rank = new Map(ACCOUNT_TYPES.map((t, i) => [t.id, i]));
      return rows.sort(
        (a, b) => (rank.get(a.type) ?? 99) - (rank.get(b.type) ?? 99) || byName(a, b)
      );
    }
  }
}

/** First switch to a custom order: start from what is already on screen. */
function seedCustomOrder(doc, ordered) {
  if ((doc.accounts || []).some((a) => Number.isFinite(a.sortOrder))) return;
  commit('Set account order', (d) => {
    ordered.forEach((a, i) => {
      const acct = d.accounts.find((x) => x.id === a.id);
      if (acct) acct.sortOrder = i * 10;
    });
  });
}

/**
 * Up/down rather than drag-and-drop: it works with a keyboard, it works on a
 * touchpad, and it is testable.
 */
function openReorder(doc, params) {
  const list = h('div.card-body.flush');

  const render = () => {
    const rows = sortAccounts(
      doc,
      (doc.accounts || []).filter((a) => !a.archived),
      'custom',
      allBalances(doc)
    );
    const move = (index, delta) => {
      const target = index + delta;
      if (target < 0 || target >= rows.length) return;
      const ids = rows.map((a) => a.id);
      const [pulled] = ids.splice(index, 1);
      ids.splice(target, 0, pulled);
      commit('Reorder accounts', (d) => {
        ids.forEach((id, i) => {
          const acct = d.accounts.find((x) => x.id === id);
          if (acct) {
            acct.sortOrder = i * 10;
            acct.updatedAt = new Date().toISOString();
          }
        });
      });
      render();
    };

    mount(
      list,
      ...rows.map((a, i) => {
        const type = accountType(a.type);
        return h(
          'div.list-row',
          null,
          h('div.avatar', null, type.icon),
          h(
            'div.l-main',
            null,
            h('div.l-title', null, a.name),
            h('div.l-sub', null, `${type.label}${isLiability(a.type) ? ' · debt' : ''}`)
          ),
          h(
            'div.row.gap-4',
            null,
            h(
              'button.btn.ghost.icon.sm',
              { title: 'Move up', disabled: i === 0, onclick: () => move(i, -1) },
              icon('chevronUp', { size: 15 })
            ),
            h(
              'button.btn.ghost.icon.sm',
              { title: 'Move down', disabled: i === rows.length - 1, onclick: () => move(i, 1) },
              icon('chevronDown', { size: 15 })
            )
          )
        );
      })
    );
  };
  render();

  const m = modal({
    title: 'Your account order',
    size: 'md',
    body: h(
      'div.col.gap-12',
      null,
      h(
        'p.muted.small',
        null,
        'Assets and debts stay in their own sections on the Accounts screen; this sets the ' +
          'order within each. Archived accounts are left out.'
      ),
      h('div.card', null, list)
    ),
    footer: [
      h(
        'button.btn.left',
        {
          onclick: () => {
            commit('Reset account order', (d) => {
              for (const a of d.accounts) delete a.sortOrder;
            });
            m.close();
            setSetting('accountSort', 'type');
            toast('Back to sorting by type');
            navigate('accounts', params);
          },
        },
        'Reset'
      ),
      h('button.btn.primary', { onclick: () => { m.close(); navigate('accounts', params); } }, 'Done'),
    ],
  });
}

function accountCard(doc, a, balances) {
  const type = accountType(a.type);
  const bal = balances.get(a.id) || 0;
  const cleared = clearedBalance(doc, a.id);
  const liability = isLiability(a.type);
  const owed = Math.abs(bal);

  const spark = h('div', null, sparkline(balanceHistory(doc, a.id, 6), {
    width: 120,
    height: 28,
    color: a.color || type.color,
  }));

  let extra = null;
  if (a.type === 'credit') {
    const u = utilization(a, bal);
    const available = availableCredit(a, bal);
    const min = minimumPayment(a, bal);
    extra = h(
      'div.col.gap-8',
      null,
      u !== null
        ? h(
            'div.meter',
            null,
            h(
              'div.meter-top',
              null,
              // The percentage is what lenders look at; the dollars are what
              // you need at the till. Both, rather than making people work it
              // out from a limit and a percentage.
              h(
                'span.strong',
                { class: available < 0 ? 'neg' : 'pos' },
                available < 0
                  ? `${money(-available)} over the limit`
                  : `${money(available)} available`
              ),
              h('span.muted', null, `${pct(u, 0)} of ${money(Number(a.creditLimit) || 0, { cents: false })}`)
            ),
            h(
              'div.bar',
              null,
              h(`i.${u >= 70 ? 'bad' : u >= 30 ? 'warn' : 'good'}`, { style: { width: `${Math.min(100, u)}%` } })
            )
          )
        : null,
      h(
        'div.row.small.muted',
        null,
        h('span', null, `Min payment ${money(min)}`),
        a.dueDay ? h('span', null, `· due day ${a.dueDay}`) : null,
        a.apr ? h('span', null, `· ${a.apr}% APR`) : null
      )
    );
  } else if (isAmortising(a.type) && (a.originalPrincipal || a.forgiveness)) {
    const principal = Number(a.originalPrincipal) || 0;
    const paidOff = Math.max(0, principal - owed);
    const progress = principal > 0 ? (paidOff / principal) * 100 : 0;
    const forgiveness = forgivenessProgress(doc, a);
    // Escrow is not money paid to the lender, so it must not be amortised.
    const toLoan = round2(Math.max(0, (Number(a.paymentAmount) || 0) - (Number(a.escrowAmount) || 0)));
    const sched =
      toLoan && owed > 0
        ? amortize({
            principal: owed,
            annualRate: Number(a.interestRate) || Number(a.apr) || 0,
            payment: toLoan,
            startDate: nextPaymentDate(doc, a.id),
            skipMonths: skippedPaymentMonths(doc, a.id),
          })
        : null;
    extra = h(
      'div.col.gap-8',
      null,
      h(
        'div.meter',
        null,
        h(
          'div.meter-top',
          null,
          h('span.muted', null, 'Paid off'),
          h('span.strong', null, `${pct(progress, 0)} · ${money(paidOff, { cents: false })}`)
        ),
        h('div.bar', null, h('i.good', { style: { width: `${Math.min(100, progress)}%` } }))
      ),
      // A loan heading for forgiveness is counted in payments, not dollars, so
      // a payoff date would be answering the wrong question entirely.
      forgiveness
        ? h(
            'div.col.gap-4',
            null,
            h(
              'div.meter-top',
              null,
              h('span.muted', null, 'Toward forgiveness'),
              h('span.strong', null, `${forgiveness.made} of ${forgiveness.required}`)
            ),
            h('div.bar', null, h('i.good', { style: { width: `${Math.min(100, forgiveness.percent)}%` } })),
            h(
              'div.small.muted',
              null,
              forgiveness.complete
                ? 'Every qualifying payment is made.'
                : `${forgiveness.remaining} to go · around ${fmtDate(forgiveness.projectedDate, 'medium')}`
            )
          )
        : sched && sched.payoffDate
          ? h(
              'div.small.muted',
              null,
              `Payoff ${fmtDate(sched.payoffDate, 'medium')} · ${money(sched.totalInterest, { cents: false })} interest left`
            )
          : sched && sched.error
            ? h('div.small.neg', null, 'Payment does not cover the interest')
            : null,
      a.type === 'mortgage' && Number(a.escrowAmount) > 0
        ? h(
            'div.tiny.dim',
            null,
            `Payment ${money(Number(a.paymentAmount) || 0)} includes ${money(Number(a.escrowAmount))} escrow`
          )
        : null
    );
  }

  return h(
    'div.card.hoverable.acct-card',
    {
      oncontextmenu: (e) => menu(e, doc, a),
    },
    h(
      'div.acct-top',
      null,
      h('div.acct-icon', { style: { background: a.color || type.color } }, type.icon),
      h(
        'div.grow',
        null,
        h('div.acct-name', null, a.name),
        h(
          'div.acct-meta',
          null,
          [type.label, a.institution, a.last4 ? `••${a.last4}` : null].filter(Boolean).join(' · ')
        )
      ),
      a.archived ? badge('Archived') : null,
      h('button.btn.ghost.icon.sm', { onclick: (e) => menu(e, doc, a) }, icon('more', { size: 16 }))
    ),
    h(
      'div.row',
      { style: { alignItems: 'flex-end', justifyContent: 'space-between' } },
      h(
        'div',
        null,
        h('div.acct-balance.money-mask', { class: bal < 0 ? 'neg' : '' }, money(liability ? owed : bal)),
        h(
          'div.tiny.dim',
          null,
          liability ? 'owed' : Math.abs(cleared - bal) > 0.005 ? `${money(cleared)} cleared` : 'cleared'
        )
      ),
      spark
    ),
    extra,
    h(
      'div.row.gap-6',
      null,
      h(
        'button.btn.sm.soft',
        { onclick: () => navigate('transactions', { accountId: a.id }) },
        icon('list', { size: 14 }),
        'Register'
      ),
      h(
        'button.btn.sm',
        { onclick: () => openTransactionEditor(null, { accountId: a.id }) },
        icon('plus', { size: 14 }),
        'Add'
      )
    )
  );
}

function menu(e, doc, a) {
  contextMenu(e, [
    { label: 'Open register', icon: 'list', onClick: () => navigate('transactions', { accountId: a.id }) },
    { label: 'Add transaction', icon: 'plus', onClick: () => openTransactionEditor(null, { accountId: a.id }) },
    { separator: true },
    { label: 'Edit account', icon: 'edit', onClick: () => openAccountEditor(a) },
    {
      label: a.archived ? 'Restore account' : 'Archive account',
      icon: 'archive',
      onClick: () =>
        commit(a.archived ? 'Restore account' : 'Archive account', (d) => {
          const acc = d.accounts.find((x) => x.id === a.id);
          if (acc) acc.archived = !acc.archived;
        }),
    },
    { separator: true },
    {
      label: 'Delete account',
      icon: 'trash',
      danger: true,
      onClick: async () => {
        const count = doc.transactions.filter(
          (t) => t.accountId === a.id || t.transferAccountId === a.id
        ).length;
        const ok = await confirm({
          title: `Delete ${a.name}?`,
          message: count ? `${count} transactions will be deleted too.` : 'This cannot be undone.',
          confirmLabel: 'Delete',
          tone: 'danger',
        });
        if (!ok) return;
        commit('Delete account', (d) => {
          d.accounts = d.accounts.filter((x) => x.id !== a.id);
          d.transactions = d.transactions.filter(
            (t) => t.accountId !== a.id && t.transferAccountId !== a.id
          );
        });
      },
    },
  ]);
}

/** Month-end balances for the last N months — feeds the card sparkline. */
function balanceHistory(doc, accountId, months) {
  const out = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const ref = addMonths(today(), -i);
    out.push(balanceOf(doc, accountId, i === 0 ? today() : endOfMonth(ref)));
  }
  return out;
}
