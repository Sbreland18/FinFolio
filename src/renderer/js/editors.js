/**
 * Modal editors for transactions, accounts, recurring items, goals and budgets.
 */

import { h, mount } from './dom.js';
import { icon } from './icons.js';
import {
  money, today, parseAmount, round2, fmtDate, addDays, dt,
} from './format.js';
import {
  ACCOUNT_TYPES, accountType, isLiability, isAmortising, byId, balanceOf, uid,
  suggestCategory, applyRules, minimumPayment, levelPayment,
  paymentBreakdown, forgivenessProgress, DEFAULT_FORGIVENESS_PAYMENTS, shouldAutoClear,
  AMOUNT_SOURCES, resolveRuleAmount, paymentRuleFor, buildPaymentRule, hasDynamicAmount,
  skipInterest, pruneSkips, skippedOccurrences, isOccurrenceSkipped,
  resolveOccurrenceAmount, occurrenceOverride, occurrenceOverrides, pruneOverrides,
  categoryChildren,
} from './finance.js';
import { FREQUENCIES, describe, nextDue } from './recurrence.js';
import {
  modal, confirm, field, textInput, textArea, select, moneyInput, readMoney,
  dateInput, checkbox, segmented, accountSelect, categorySelect, emojiPicker, toast, toastOk,
} from './ui.js';
import {
  state, commit, addTransaction, updateTransaction, deleteTransaction, upsert, removeFrom, touch,
} from './state.js';

/* ================================================================== */
/* Transaction                                                        */
/* ================================================================== */

export function openTransactionEditor(existing = null, defaults = {}) {
  const doc = state.doc;
  if (!doc.accounts.length) {
    toast('Add an account first.', { tone: 'warn' });
    openAccountEditor();
    return;
  }

  const tx = existing
    ? { ...existing }
    : {
        type: 'expense',
        date: today(),
        amount: 0,
        accountId: defaults.accountId || doc.accounts[0].id,
        transferAccountId: '',
        categoryId: '',
        payee: '',
        notes: '',
        cleared: false,
        tags: [],
        splits: [],
        ...defaults,
      };

  let type = tx.type;
  let splits = (tx.splits || []).map((s) => ({ ...s }));

  const dateI = dateInput({ value: tx.date });
  const amountI = moneyInput({ value: tx.amount ? Math.abs(tx.amount).toFixed(2) : '' });
  const payeeI = textInput({ value: tx.payee || '', placeholder: 'Who was paid / who paid you', list: 'payee-list' });
  const payeeList = h(
    'datalist',
    { id: 'payee-list' },
    ...(doc.payees || []).slice(0, 400).map((p) => h('option', { value: p }))
  );
  const notesI = textArea({ value: tx.notes || '', placeholder: 'Optional note', rows: 2 });
  const tagsI = textInput({ value: (tx.tags || []).join(', '), placeholder: 'tags, comma separated' });
  const clearedI = checkbox('Cleared the bank', { checked: !!tx.cleared });

  /**
   * Interest and fees posted to a card or loan are not pending — the lender
   * has already applied them — so tick the box rather than making someone go
   * back and confirm every statement's interest by hand.
   */
  function syncAutoClear() {
    if (existing) return; // never re-tick something already recorded
    const box = clearedI.querySelector('input');
    const auto = shouldAutoClear(doc, {
      accountId: accountI.value,
      categoryId: categoryRefs.el.value,
      type,
    });
    if (auto && !box.checked) {
      box.checked = true;
      clearedI.classList.add('auto-cleared');
    } else if (!auto && clearedI.classList.contains('auto-cleared')) {
      box.checked = false;
      clearedI.classList.remove('auto-cleared');
    }
  }

  const accountI = accountSelect(doc, { value: tx.accountId });
  const toAccountI = accountSelect(doc, { value: tx.transferAccountId, allowEmpty: true });
  const categoryI = categorySelect(doc, {
    value: tx.categoryId,
    kind: type === 'income' ? 'income' : 'expense',
  });

  const fromLabel = h('div.label', null, 'Account');
  const toRow = h('div.field.hidden', null, h('label.label', null, 'To account'), toAccountI);
  const categoryRow = field('Category', categoryI);
  const splitBox = h('div.col.mt-12');
  const splitToggle = h(
    'button.linkbtn.tiny',
    { onclick: () => { splits.length ? clearSplits() : addSplit(); } },
    'Split across categories'
  );

  // Learn the category from history when the payee is typed.
  payeeI.addEventListener('change', () => {
    if (categoryI.value) return;
    const suggestion = suggestCategory(doc, payeeI.value);
    if (suggestion) categoryI.value = suggestion;
  });

  const categoryRefs = { el: categoryI };

  function syncType(next) {
    type = next;
    tx.type = next;
    const transfer = next === 'transfer';
    toRow.classList.toggle('hidden', !transfer);
    categoryRow.classList.toggle('hidden', transfer);
    splitToggle.classList.toggle('hidden', transfer);
    splitBox.classList.toggle('hidden', transfer);
    fromLabel.textContent = transfer ? 'From account' : 'Account';
    if (!transfer) {
      // The category list differs for income vs expense, so swap the control.
      const replacement = categorySelect(doc, {
        value: categoryRefs.el.value,
        kind: next === 'income' ? 'income' : 'expense',
      });
      categoryRow.replaceChildren(h('label.label', null, 'Category'), replacement);
      categoryRefs.el = replacement;
      replacement.addEventListener('change', syncAutoClear);
    }
    syncAutoClear();
  }

  function addSplit() {
    splits.push({ categoryId: '', amount: 0, notes: '' });
    renderSplits();
  }
  function clearSplits() {
    splits = [];
    renderSplits();
  }
  function renderSplits() {
    if (!splits.length) {
      mount(splitBox);
      splitToggle.textContent = 'Split across categories';
      return;
    }
    splitToggle.textContent = 'Remove splits';
    const rows = splits.map((s, i) => {
      const cat = categorySelect(doc, { value: s.categoryId, kind: 'expense' });
      cat.addEventListener('change', () => { s.categoryId = cat.value; });
      const amt = moneyInput({ value: s.amount ? Number(s.amount).toFixed(2) : '' });
      amt.querySelector('input').addEventListener('blur', () => {
        s.amount = readMoney(amt);
        renderSplits();
      });
      return h(
        'div.row',
        null,
        h('div.grow', null, cat),
        h('div', { style: { width: '140px' } }, amt),
        h('button.btn.ghost.icon.sm', { onclick: () => { splits.splice(i, 1); renderSplits(); } }, icon('x', { size: 14 }))
      );
    });
    const total = round2(splits.reduce((s, x) => s + (Number(x.amount) || 0), 0));
    const target = readMoney(amountI);
    const diff = round2(target - total);
    mount(
      splitBox,
      ...rows,
      h(
        'div.row.small',
        null,
        h('button.linkbtn.tiny', { onclick: addSplit }, '+ Add split'),
        h('div.grow'),
        h('span.muted', null, `Allocated ${money(total)}`),
        Math.abs(diff) > 0.004
          ? h('span.neg.strong', null, `${diff > 0 ? 'Unallocated' : 'Over'} ${money(Math.abs(diff))}`)
          : h('span.pos.strong', null, 'Balanced')
      )
    );
  }

  const body = h(
    'div.col.gap-16',
    null,
    payeeList,
    segmented(
      [
        { value: 'expense', label: 'Expense' },
        { value: 'income', label: 'Income' },
        { value: 'transfer', label: 'Transfer' },
      ],
      type,
      syncType
    ),
    h(
      'div.grid.grid-2',
      null,
      field('Date', dateI),
      field('Amount', amountI)
    ),
    h('div.field', null, fromLabel, accountI),
    toRow,
    field('Payee', payeeI),
    categoryRow,
    h('div', null, splitToggle, splitBox),
    h('div.grid.grid-2', null, field('Tags', tagsI), h('div.field', null, h('label.label', null, ' '), h('div', null, clearedI))),
    field('Notes', notesI)
  );

  syncType(type);
  renderSplits();
  categoryI.addEventListener('change', syncAutoClear);
  accountI.addEventListener('change', syncAutoClear);
  syncAutoClear();

  const save = (addAnother) => {
    const amount = readMoney(amountI);
    if (!amount) {
      toast('Enter an amount.', { tone: 'warn' });
      return;
    }
    if (type === 'transfer' && !toAccountI.value) {
      toast('Choose the account you are transferring to.', { tone: 'warn' });
      return;
    }
    if (type === 'transfer' && toAccountI.value === accountI.value) {
      toast('Pick two different accounts for a transfer.', { tone: 'warn' });
      return;
    }
    const payload = {
      type,
      date: dateI.value || today(),
      amount: Math.abs(amount),
      accountId: accountI.value,
      transferAccountId: type === 'transfer' ? toAccountI.value : '',
      categoryId: type === 'transfer' ? '' : categoryRefs.el.value,
      payee: payeeI.value.trim(),
      notes: notesI.value.trim(),
      cleared: clearedI.querySelector('input').checked,
      tags: tagsI.value.split(',').map((t) => t.trim()).filter(Boolean),
      splits: type === 'transfer' ? [] : splits.filter((s) => s.categoryId && s.amount),
    };
    // Carried through so a transaction opened here keeps its link to the
    // schedule that created it — losing it makes a paid bill look unpaid.
    if (tx.recurringId) payload.recurringId = tx.recurringId;
    if (existing) updateTransaction(existing.id, payload);
    else addTransaction(payload);

    if (addAnother) {
      amountI.querySelector('input').value = '';
      payeeI.value = '';
      notesI.value = '';
      splits = [];
      renderSplits();
      payeeI.focus();
      toastOk('Saved — add another');
    } else {
      m.close();
      toastOk(existing ? 'Transaction updated' : 'Transaction added');
    }
  };

  const m = modal({
    title: existing ? 'Edit transaction' : 'New transaction',
    body,
    footer: [
      existing
        ? h(
            'button.btn.danger-soft.left',
            {
              onclick: async () => {
                if (await confirm({ title: 'Delete this transaction?', confirmLabel: 'Delete', tone: 'danger' })) {
                  deleteTransaction(existing.id);
                  m.close();
                  toast('Transaction deleted');
                }
              },
            },
            icon('trash', { size: 15 }),
            'Delete'
          )
        : null,
      h('button.btn', { onclick: () => m.close() }, 'Cancel'),
      !existing ? h('button.btn.soft', { onclick: () => save(true) }, 'Save & add another') : null,
      h('button.btn.primary', { onclick: () => save(false) }, 'Save'),
    ].filter(Boolean),
  });

  setTimeout(() => amountI.querySelector('input').focus(), 60);
}

/* ================================================================== */
/* Account                                                            */
/* ================================================================== */

export function openAccountEditor(existing = null) {
  const doc = state.doc;
  const acct = existing
    ? { ...existing }
    : {
        name: '',
        type: 'checking',
        institution: '',
        last4: '',
        openingBalance: 0,
        openingDate: today(),
        color: '#2a78d6',
        notes: '',
        archived: false,
      };

  const liabilityNow = isLiability(acct.type);
  const nameI = textInput({ value: acct.name, placeholder: 'Main Checking' });
  const typeI = select(
    ACCOUNT_TYPES.map((t) => ({ value: t.id, label: `${t.icon}  ${t.label}` })),
    { value: acct.type }
  );
  const instI = textInput({ value: acct.institution || '', placeholder: 'Bank or lender' });
  const last4I = textInput({ value: acct.last4 || '', placeholder: '1234', maxLength: 4 });
  const openI = moneyInput({
    value: acct.openingBalance ? Math.abs(acct.openingBalance).toFixed(2) : '',
  });
  const openDateI = dateInput({ value: acct.openingDate || today() });
  const colorI = h('input', {
    type: 'color',
    value: acct.color || '#2a78d6',
    style: { width: '44px', height: '36px', border: '1px solid var(--border-2)', borderRadius: '9px', background: 'var(--surface)' },
  });
  const notesI = textArea({ value: acct.notes || '', rows: 2 });
  const archivedI = checkbox('Archived (hide from lists, keep history)', { checked: !!acct.archived });

  const balanceHint = h('div.hint');
  const creditBox = h('div.col.gap-12');
  const loanBox = h('div.col.gap-12');

  // credit fields
  const limitI = moneyInput({ value: acct.creditLimit ? Number(acct.creditLimit).toFixed(2) : '' });
  const aprI = textInput({ type: 'number', step: '0.01', value: acct.apr ?? '', placeholder: '19.99' });
  const stmtI = textInput({ type: 'number', min: 1, max: 31, value: acct.statementDay ?? '', placeholder: '5' });
  const dueI = textInput({ type: 'number', min: 1, max: 31, value: acct.dueDay ?? '', placeholder: '28' });
  const minPctI = textInput({ type: 'number', step: '0.1', value: acct.minPaymentPct ?? 2, placeholder: '2' });
  const minFloorI = moneyInput({ value: acct.minPaymentFloor ? Number(acct.minPaymentFloor).toFixed(2) : '25.00' });

  // loan fields
  const principalI = moneyInput({ value: acct.originalPrincipal ? Number(acct.originalPrincipal).toFixed(2) : '' });
  const rateI = textInput({ type: 'number', step: '0.001', value: acct.interestRate ?? '', placeholder: '6.5' });
  const termI = textInput({ type: 'number', value: acct.termMonths ?? '', placeholder: '360' });
  const paymentI = moneyInput({ value: acct.paymentAmount ? Number(acct.paymentAmount).toFixed(2) : '' });
  const firstPayI = dateInput({ value: acct.firstPaymentDate || today() });
  const escrowI = moneyInput({ value: acct.escrowAmount ? Number(acct.escrowAmount).toFixed(2) : '' });

  /* ---- forgiveness (PSLF and similar) ---- */

  const forgiveI = checkbox('This loan will be forgiven after a number of payments', {
    checked: !!acct.forgiveness,
  });
  const forgiveRequiredI = textInput({
    type: 'number',
    min: 1,
    max: 600,
    value: acct.forgivenessRequired || DEFAULT_FORGIVENESS_PAYMENTS,
  });
  const forgiveMadeI = textInput({
    type: 'number',
    min: 0,
    max: 600,
    value: acct.forgivenessPaymentsMade ?? 0,
  });
  const forgiveFromI = dateInput({ value: acct.forgivenessCountFrom || today() });
  const forgiveDetails = h(
    'div.col.gap-12.mt-12',
    null,
    h(
      'div.grid.grid-2',
      null,
      field('Payments required', forgiveRequiredI, { hint: '120 for Public Service Loan Forgiveness' }),
      field('Qualifying payments already made', forgiveMadeI, { hint: 'Before you started using FinFolio' })
    ),
    field('Count payments recorded here from', forgiveFromI, {
      hint: 'Usually today. Payments in FinFolio dated on or after this are added to the count above.',
    }),
    h(
      'p.tiny.dim',
      null,
      'Paying extra buys you nothing on a loan heading for forgiveness, so the payoff planner ' +
        'keeps paying its minimum and sends spare money to your other debts instead.'
    )
  );
  const forgiveBox = h(
    'div.card.pad.hidden',
    { style: { background: 'var(--surface-2)' } },
    h('div.h3', null, 'Loan forgiveness'),
    h('div.mt-8', null, forgiveI),
    forgiveDetails
  );

  /* ---- whether the payoff planner works on this debt ---- */

  const inPlanI = checkbox('Include in the Debt Payoff plan', {
    checked: acct.inPayoffPlan !== false,
  });
  const inPlanBox = h(
    'div.field.hidden',
    null,
    inPlanI,
    h(
      'div.hint',
      null,
      'Untick to keep a mortgage or a forgiven loan out of the avalanche and snowball order. ' +
        'The payment still appears in Bills & Income and the balance still counts in net worth.'
    )
  );
  const syncForgive = () => {
    forgiveDetails.classList.toggle('hidden', !forgiveI.querySelector('input').checked);
  };
  forgiveI.querySelector('input').addEventListener('change', syncForgive);
  syncForgive();
  const suggestPay = h('button.linkbtn.tiny', {
    onclick: () => {
      const p = readMoney(principalI);
      const r = Number(rateI.value) || 0;
      const n = Number(termI.value) || 0;
      if (p && n) {
        paymentI.querySelector('input').value = levelPayment(p, r, n).toFixed(2);
        toast(`Calculated payment: ${money(levelPayment(p, r, n))}`);
      }
    },
  }, 'Calculate payment from term');

  mount(
    creditBox,
    h('div.h3', null, 'Credit card details'),
    h(
      'div.grid.grid-2',
      null,
      field('Credit limit', limitI),
      field('APR %', aprI),
      field('Statement day', stmtI, { hint: 'Day of month' }),
      field('Payment due day', dueI, { hint: 'Day of month' }),
      field('Minimum payment %', minPctI),
      field('Minimum payment floor', minFloorI)
    )
  );
  /* ---- payment reminder (credit cards and loans) ---- */

  const existingRule = existing ? paymentRuleFor(doc, existing.id) : null;
  const remindI = checkbox('Add this payment to Bills & Income', { checked: !!existingRule });
  const remindFromI = accountSelect(doc, {
    value: existingRule ? existingRule.accountId : '',
    filter: (a) => !isLiability(a.type),
  });
  const remindDayI = textInput({
    type: 'number',
    min: 1,
    max: 31,
    value: (existingRule && existingRule.dayOfMonth) || acct.dueDay || '',
    placeholder: '28',
  });
  const remindSourceI = select(
    [
      { value: AMOUNT_SOURCES.CARD_MINIMUM, label: 'The minimum payment (follows the balance)' },
      { value: AMOUNT_SOURCES.CARD_FULL, label: 'The full balance' },
      { value: AMOUNT_SOURCES.FIXED, label: 'A fixed amount I set' },
    ],
    { value: (existingRule && existingRule.amountSource) || AMOUNT_SOURCES.CARD_MINIMUM }
  );
  const remindFixedI = moneyInput({
    value: existingRule && existingRule.amountSource === AMOUNT_SOURCES.FIXED
      ? Number(existingRule.amount).toFixed(2)
      : '',
  });
  const remindDetails = h('div.col.gap-12.mt-12');
  const remindSourceRow = h('div.field', null, h('label.label', null, 'Remind me to pay'), remindSourceI);
  const remindFixedRow = h('div.field.hidden', null, h('label.label', null, 'Amount'), remindFixedI);

  const syncRemind = () => {
    const on = remindI.querySelector('input').checked;
    remindDetails.classList.toggle('hidden', !on);
    const isCard = typeI.value === 'credit';
    remindSourceRow.classList.toggle('hidden', !isCard);
    remindFixedRow.classList.toggle('hidden', !(isCard && remindSourceI.value === AMOUNT_SOURCES.FIXED));
  };
  remindI.querySelector('input').addEventListener('change', syncRemind);
  remindSourceI.addEventListener('change', syncRemind);

  mount(
    remindDetails,
    h('div.grid.grid-2', null, field('Pay from', remindFromI), field('Due day of the month', remindDayI)),
    remindSourceRow,
    remindFixedRow,
    h(
      'p.tiny.dim',
      null,
      'It appears in Bills & Income, on the calendar and in the forecast, and you can still change the amount when you record the payment.'
    )
  );

  const reminderBox = h(
    'div.card.pad.hidden',
    null,
    h('div.h3', null, 'Payment reminder'),
    h(
      'p.muted.small.mt-4',
      null,
      'Track this payment alongside your other bills so a due date is never missed.'
    ),
    h('div.mt-12', null, remindI),
    remindDetails,
    h('div.mt-12', null, inPlanBox)
  );

  const escrowRow = h(
    'div.field.hidden',
    null,
    h('label.label', null, 'Of that, escrow'),
    escrowI,
    h('div.hint', null, 'Taxes and insurance inside the payment. This part never reduces the loan.')
  );

  mount(
    loanBox,
    h('div.h3', null, 'Loan details'),
    h(
      'div.grid.grid-2',
      null,
      field('Original principal', principalI),
      field('Interest rate %', rateI),
      field('Term (months)', termI),
      field('Monthly payment', paymentI),
      field('First payment date', firstPayI),
      escrowRow
    ),
    suggestPay,
    forgiveBox
  );

  function syncType() {
    const t = typeI.value;
    creditBox.classList.toggle('hidden', t !== 'credit');
    loanBox.classList.toggle('hidden', !isAmortising(t));
    escrowRow.classList.toggle('hidden', t !== 'mortgage');
    forgiveBox.classList.toggle('hidden', !isAmortising(t));
    const liab = isLiability(t);
    reminderBox.classList.toggle('hidden', !liab);
    inPlanBox.classList.toggle('hidden', !liab);
    balanceHint.textContent = liab
      ? 'Enter the amount you currently owe as a positive number.'
      : 'Enter the balance your bank shows today.';
    if (!existing) {
      colorI.value = accountType(t).color;
      // A 30-year mortgage in an avalanche is the biggest balance at nearly the
      // lowest rate: it goes last and drags the finish line out by decades.
      // Defaulted off for new mortgages, visibly, so it can be turned back on.
      inPlanI.querySelector('input').checked = t !== 'mortgage';
    }
    syncRemind();
  }
  typeI.addEventListener('change', syncType);
  // A card or loan added from scratch gets the reminder switched on by default;
  // missing a due date is the expensive mistake.
  if (!existing) remindI.querySelector('input').checked = true;
  syncType();
  // Keep the due day in step with the card's own setting until it is overridden.
  dueI.addEventListener('change', () => {
    if (!remindDayI.value) remindDayI.value = dueI.value;
  });

  const body = h(
    'div.col.gap-16',
    null,
    h('div.grid.grid-2', null, field('Account name', nameI), field('Type', typeI)),
    h('div.grid.grid-2', null, field('Institution', instI), field('Last 4 digits', last4I)),
    h(
      'div.grid.grid-2',
      null,
      h('div.field', null, h('label.label', null, existing ? 'Starting balance' : 'Balance today'), openI, balanceHint),
      field('As of date', openDateI)
    ),
    existing
      ? h(
          'div.card.pad.small.muted',
          null,
          `Current calculated balance: `,
          h('span.strong', null, money(balanceOf(doc, existing.id)))
        )
      : null,
    creditBox,
    loanBox,
    reminderBox,
    h('div.row', null, h('div.grow', null, field('Notes', notesI)), h('div.field', null, h('label.label', null, 'Colour'), colorI)),
    existing ? archivedI : null
  );

  const m = modal({
    title: existing ? 'Edit account' : 'New account',
    size: 'lg',
    body,
    footer: [
      existing
        ? h(
            'button.btn.danger-soft.left',
            {
              onclick: async () => {
                const count = doc.transactions.filter(
                  (t) => t.accountId === existing.id || t.transferAccountId === existing.id
                ).length;
                const ok = await confirm({
                  title: `Delete ${existing.name}?`,
                  message: count
                    ? `This will also delete ${count} transaction${count > 1 ? 's' : ''} linked to this account. Consider archiving instead.`
                    : 'This cannot be undone (though you can use Undo right after).',
                  confirmLabel: 'Delete account',
                  tone: 'danger',
                });
                if (!ok) return;
                commit('Delete account', (d) => {
                  d.accounts = d.accounts.filter((a) => a.id !== existing.id);
                  d.transactions = d.transactions.filter(
                    (t) => t.accountId !== existing.id && t.transferAccountId !== existing.id
                  );
                  d.recurring = d.recurring.filter((r) => r.accountId !== existing.id);
                });
                m.close();
                toast('Account deleted');
              },
            },
            icon('trash', { size: 15 }),
            'Delete'
          )
        : null,
      h('button.btn', { onclick: () => m.close() }, 'Cancel'),
      h(
        'button.btn.primary',
        {
          onclick: () => {
            const name = nameI.value.trim();
            if (!name) {
              toast('Give the account a name.', { tone: 'warn' });
              nameI.focus();
              return;
            }
            const t = typeI.value;
            const rawBalance = readMoney(openI);
            const payload = {
              id: existing ? existing.id : uid('acc'),
              name,
              type: t,
              institution: instI.value.trim(),
              last4: last4I.value.trim(),
              openingBalance: isLiability(t) ? -Math.abs(rawBalance) : rawBalance,
              openingDate: openDateI.value || today(),
              color: colorI.value,
              notes: notesI.value.trim(),
              archived: existing ? archivedI.querySelector('input').checked : false,
              creditLimit: readMoney(limitI) || 0,
              apr: Number(aprI.value) || 0,
              statementDay: Number(stmtI.value) || null,
              dueDay: Number(dueI.value) || null,
              minPaymentPct: Number(minPctI.value) || 2,
              minPaymentFloor: readMoney(minFloorI) || 25,
              originalPrincipal: readMoney(principalI) || 0,
              interestRate: Number(rateI.value) || 0,
              termMonths: Number(termI.value) || 0,
              paymentAmount: readMoney(paymentI) || 0,
              firstPaymentDate: firstPayI.value || today(),
              escrowAmount: t === 'mortgage' ? readMoney(escrowI) || 0 : 0,
              forgiveness: isAmortising(t) && forgiveI.querySelector('input').checked,
              forgivenessRequired: Number(forgiveRequiredI.value) || DEFAULT_FORGIVENESS_PAYMENTS,
              forgivenessPaymentsMade: Math.max(0, Number(forgiveMadeI.value) || 0),
              forgivenessCountFrom: forgiveFromI.value || today(),
              inPayoffPlan: !isLiability(t) || inPlanI.querySelector('input').checked,
            };
            const wantsReminder = isLiability(t) && remindI.querySelector('input').checked;
            const reminderDay = Number(remindDayI.value) || Number(dueI.value) || 1;
            const reminderSource =
              t === 'credit' ? remindSourceI.value : AMOUNT_SOURCES.LOAN_PAYMENT;
            const reminderFixed = readMoney(remindFixedI);

            commit(existing ? 'Edit account' : 'Add account', (d) => {
              const idx = d.accounts.findIndex((a) => a.id === payload.id);
              if (idx >= 0) d.accounts[idx] = { ...d.accounts[idx], ...payload, updatedAt: new Date().toISOString() };
              else d.accounts.push({ ...payload, updatedAt: new Date().toISOString() });

              const current = (d.recurring || []).find((r) => r.linkedAccountId === payload.id) || null;

              if (!wantsReminder) {
                if (current) {
                  d.recurring = d.recurring.filter((r) => r.id !== current.id);
                  if (!Array.isArray(d.tombstones)) d.tombstones = [];
                  d.tombstones.push({ id: current.id, collection: 'recurring', at: new Date().toISOString() });
                }
                return;
              }

              const base = current || buildPaymentRule(d, { ...payload }, {
                fromAccountId: remindFromI.value,
                dayOfMonth: reminderDay,
              });
              const updated = {
                ...base,
                name: current ? base.name : `${name} payment`,
                kind: 'transfer',
                accountId: remindFromI.value || base.accountId,
                transferAccountId: payload.id,
                linkedAccountId: payload.id,
                amountSource: reminderSource,
                amount:
                  reminderSource === AMOUNT_SOURCES.FIXED
                    ? reminderFixed
                    : reminderSource === AMOUNT_SOURCES.LOAN_PAYMENT
                      ? payload.paymentAmount || base.amount
                      : base.amount,
                dayOfMonth: reminderDay,
                frequency: 'monthly',
                active: true,
                variableAmount: reminderSource !== AMOUNT_SOURCES.FIXED,
                updatedAt: new Date().toISOString(),
              };
              if (current) {
                d.recurring = d.recurring.map((r) => (r.id === current.id ? updated : r));
              } else {
                d.recurring.push(updated);
              }
            });

            m.close();
            toastOk(
              existing
                ? 'Account updated'
                : wantsReminder
                  ? `${name} added, and its payment is now in Bills & Income`
                  : `${name} added`
            );
          },
        },
        'Save'
      ),
    ].filter(Boolean),
  });
}

/* ================================================================== */
/* Recurring (bills, paydays, subscriptions, transfers)               */
/* ================================================================== */

export function openRecurringEditor(existing = null, defaults = {}) {
  const doc = state.doc;
  if (!doc.accounts.length) {
    toast('Add an account first.', { tone: 'warn' });
    openAccountEditor();
    return;
  }
  const rule = existing
    ? { ...existing }
    : {
        name: '',
        kind: 'bill',
        amount: 0,
        accountId: doc.accounts[0].id,
        transferAccountId: '',
        categoryId: '',
        payee: '',
        frequency: 'monthly',
        interval: 1,
        startDate: today(),
        dayOfMonth: dt(today()).getDate(),
        dayOfMonth2: null,
        endDate: '',
        autoPay: false,
        reminderDays: 3,
        weekendShift: 'none',
        variableAmount: false,
        active: true,
        notes: '',
        ...defaults,
      };

  let kind = rule.kind;

  const nameI = textInput({ value: rule.name, placeholder: 'Electric bill' });
  const amountI = moneyInput({ value: rule.amount ? Number(rule.amount).toFixed(2) : '' });
  const accountI = accountSelect(doc, { value: rule.accountId });
  const toAccountI = accountSelect(doc, { value: rule.transferAccountId, allowEmpty: true });
  const categoryI = categorySelect(doc, { value: rule.categoryId, kind: kind === 'income' ? 'income' : 'expense' });
  const payeeI = textInput({ value: rule.payee || '', placeholder: 'Optional' });
  const freqI = select(FREQUENCIES.map((f) => ({ value: f.id, label: f.label })), { value: rule.frequency });
  const startI = dateInput({ value: rule.startDate });
  const endI = dateInput({ value: rule.endDate || '', required: false });
  const dayI = textInput({ type: 'number', min: 1, max: 31, value: rule.dayOfMonth || '' });
  const day2I = textInput({ type: 'number', min: 1, max: 31, value: rule.dayOfMonth2 || '' });
  const intervalI = textInput({ type: 'number', min: 1, max: 24, value: rule.interval || 1 });
  const weekendI = select(
    [
      { value: 'none', label: 'Keep the exact date' },
      { value: 'before', label: 'Move to the Friday before' },
      { value: 'after', label: 'Move to the Monday after' },
    ],
    { value: rule.weekendShift || 'none' }
  );
  const autoPayI = checkbox('Paid automatically (autopay)', { checked: !!rule.autoPay });
  const variableI = checkbox('Amount varies each time', { checked: !!rule.variableAmount });
  const activeI = checkbox('Active', { checked: rule.active !== false });
  const reminderI = textInput({ type: 'number', min: 0, max: 30, value: rule.reminderDays ?? 3 });
  const notesI = textArea({ value: rule.notes || '', rows: 2 });
  // Optional: without one, the row falls back to the category's icon, which is
  // right most of the time.
  const iconI = emojiPicker({ value: rule.icon || '' });
  const iconRow = h(
    'details.field',
    rule.icon ? { open: true } : null,
    h('summary.label', { style: { cursor: 'pointer' } }, 'Icon (optional)'),
    h(
      'div.mt-8',
      null,
      h(
        'p.tiny.dim.mb-8',
        null,
        'Leave this blank to use the category’s icon.'
      ),
      iconI
    )
  );

  const toRow = h('div.field.hidden', null, h('label.label', null, 'To account'), toAccountI);
  const catRow = field('Category', categoryI);
  const dayRow = h('div.grid.grid-2', null, field('Day of month', dayI), field('Second day', day2I));
  const intervalRow = field('Repeat every N periods', intervalI);
  const preview = h('div.card.pad.small.muted');

  function collect() {
    // Per-date adjustments deliberately do not travel with the draft. They
    // belong to the live document, and restoring one while this dialog is open
    // must not be undone by saving an unrelated field from a stale copy.
    const { skips, overrides, ...base } = rule;
    return {
      ...base,
      kind,
      amount: readMoney(amountI),
      frequency: freqI.value,
      interval: Number(intervalI.value) || 1,
      startDate: startI.value || today(),
      endDate: endI.value || '',
      dayOfMonth: Number(dayI.value) || null,
      dayOfMonth2: Number(day2I.value) || null,
      weekendShift: weekendI.value,
      active: activeI.querySelector('input').checked,
    };
  }

  function refresh() {
    const f = freqI.value;
    const monthly = ['monthly', 'bimonthly', 'quarterly', 'semiannual', 'annual', 'semimonthly'].includes(f);
    dayRow.classList.toggle('hidden', !monthly);
    day2I.parentElement.classList.toggle('hidden', f !== 'semimonthly');
    intervalRow.classList.toggle('hidden', !['daily', 'weekly', 'monthly'].includes(f));
    const draft = collect();
    const next = nextDue(draft, today());
    const following = next ? nextDue({ ...draft, startDate: addDays(next, 1) }, addDays(next, 1)) : null;
    mount(
      preview,
      h('div.strong', null, describe(draft)),
      h(
        'div.mt-4',
        null,
        next ? `Next: ${fmtDate(next, 'weekday')}` : 'No upcoming occurrence',
        following ? `  ·  then ${fmtDate(following, 'day')}` : ''
      )
    );
  }

  for (const el of [freqI, startI, dayI, day2I, intervalI, weekendI, endI]) {
    el.addEventListener('change', refresh);
    el.addEventListener('input', refresh);
  }

  function syncKind(next) {
    kind = next;
    const transfer = next === 'transfer';
    toRow.classList.toggle('hidden', !transfer);
    catRow.classList.toggle('hidden', transfer);
    const replacement = categorySelect(doc, {
      value: categoryRefs.el.value,
      kind: next === 'income' ? 'income' : 'expense',
    });
    catRow.replaceChildren(h('label.label', null, 'Category'), replacement);
    categoryRefs.el = replacement;
    accountLabel.textContent = next === 'income' ? 'Deposit into' : transfer ? 'From account' : 'Pay from';
  }
  const categoryRefs = { el: categoryI };
  const accountLabel = h('div.label', null, 'Pay from');

  const body = h(
    'div.col.gap-16',
    null,
    segmented(
      [
        { value: 'bill', label: 'Bill' },
        { value: 'income', label: 'Income / payday' },
        { value: 'subscription', label: 'Subscription' },
        { value: 'transfer', label: 'Transfer' },
      ],
      kind,
      syncKind
    ),
    dynamicNotice(doc, rule),
    h('div.grid.grid-2', null, field('Name', nameI), field('Amount', amountI)),
    h('div.field', null, accountLabel, accountI),
    toRow,
    catRow,
    field('Payee', payeeI),
    h('div.grid.grid-2', null, field('Repeats', freqI), field('Starting', startI)),
    dayRow,
    intervalRow,
    h('div.grid.grid-2', null, field('If it lands on a weekend', weekendI), field('Ends on (optional)', endI)),
    preview,
    skipsSection(rule),
    h(
      'div.grid.grid-2',
      null,
      field('Remind me days before', reminderI),
      h('div.field', null, h('label.label', null, 'Options'), h('div.col.gap-8', null, autoPayI, variableI, activeI))
    ),
    iconRow,
    field('Notes', notesI)
  );

  syncKind(kind);
  refresh();

  const m = modal({
    title: existing ? 'Edit scheduled item' : 'New bill, payday or subscription',
    size: 'lg',
    body,
    footer: [
      existing
        ? h(
            'button.btn.danger-soft.left',
            {
              onclick: async () => {
                if (
                  await confirm({
                    title: `Delete “${existing.name}”?`,
                    message: 'Transactions already recorded from it are kept.',
                    confirmLabel: 'Delete',
                    tone: 'danger',
                  })
                ) {
                  removeFrom('recurring', existing.id, 'Delete scheduled item');
                  m.close();
                  toast('Scheduled item deleted');
                }
              },
            },
            icon('trash', { size: 15 }),
            'Delete'
          )
        : null,
      h('button.btn', { onclick: () => m.close() }, 'Cancel'),
      h(
        'button.btn.primary',
        {
          onclick: () => {
            const name = nameI.value.trim();
            if (!name) {
              toast('Give it a name.', { tone: 'warn' });
              nameI.focus();
              return;
            }
            const amount = readMoney(amountI);
            if (!amount && !variableI.querySelector('input').checked) {
              toast('Enter an amount (or tick “amount varies”).', { tone: 'warn' });
              return;
            }
            const payload = {
              ...collect(),
              id: existing ? existing.id : uid('rec'),
              name,
              kind,
              accountId: accountI.value,
              transferAccountId: kind === 'transfer' ? toAccountI.value : '',
              categoryId: kind === 'transfer' ? '' : categoryRefs.el.value,
              payee: payeeI.value.trim(),
              autoPay: autoPayI.querySelector('input').checked,
              variableAmount: variableI.querySelector('input').checked,
              reminderDays: Number(reminderI.value) || 0,
              icon: iconI.value.trim(),
              notes: notesI.value.trim(),
            };
            upsert('recurring', payload, existing ? 'Edit scheduled item' : 'Add scheduled item');
            m.close();
            toastOk(existing ? 'Updated' : `${name} scheduled`);
          },
        },
        'Save'
      ),
    ].filter(Boolean),
  });
}

/**
 * The dates where this schedule departs from its own rule — months it is
 * sitting out, and amounts set for a single date. Without this, an adjustment
 * made in October would be invisible from the schedule itself and could only
 * be found by scrolling the calendar back to the right month.
 */
function skipsSection(rule) {
  const from = addDays(today(), -62);
  const entries = [
    ...skippedOccurrences(rule, { from }).map((s) => ({ ...s, type: 'skip' })),
    ...occurrenceOverrides(rule, { from }).map((o) => ({ ...o, type: 'amount' })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (!entries.length) return null;

  const list = h('div.card-body.flush');
  const wrap = h(
    'div.field',
    null,
    h('label.label', null, `Adjusted dates — ${entries.length}`),
    h('div.card', null, list)
  );

  const row = (entry) =>
    h(
      'div.list-row',
      null,
      h('div.avatar', null, entry.type === 'skip' ? '⏭' : '✎'),
      h(
        'div.l-main',
        null,
        h('div.l-title', null, fmtDate(entry.date, 'long')),
        h(
          'div.l-sub',
          null,
          entry.type === 'skip'
            ? entry.reason || 'Skipped'
            : `${money(Number(entry.amount) || 0)}${entry.note ? ` · ${entry.note}` : ''}`
        )
      ),
      h(
        'button.btn.sm.soft',
        {
          onclick: (e) => {
            if (entry.type === 'skip') unskipOccurrence(rule, entry.date);
            else clearOverride(rule, entry.date);
            e.target.closest('.list-row').remove();
            if (!list.children.length) wrap.classList.add('hidden');
          },
        },
        entry.type === 'skip' ? 'Put it back' : 'Use the usual'
      )
    );

  for (const entry of entries) list.appendChild(row(entry));
  return wrap;
}

/**
 * Explain an amount that is worked out rather than typed, so editing the
 * amount box does not look broken.
 */
function dynamicNotice(doc, rule) {
  if (!hasDynamicAmount(rule)) return null;
  const linked = byId(doc.accounts, rule.linkedAccountId);
  const resolved = resolveRuleAmount(doc, rule);
  return h(
    'div.card.pad',
    { style: { background: 'var(--accent-soft)', borderColor: 'transparent' } },
    h(
      'div.row',
      null,
      h('span', { style: { color: 'var(--accent-text)', display: 'flex' } }, icon('wand', { size: 18 })),
      h(
        'div.grow',
        null,
        h(
          'div.strong',
          null,
          rule.amountSource === AMOUNT_SOURCES.CARD_FULL
            ? 'Amount follows the full card balance'
            : rule.amountSource === AMOUNT_SOURCES.LOAN_PAYMENT
              ? 'Amount comes from the loan’s monthly payment'
              : 'Amount follows the card’s minimum payment'
        ),
        h(
          'div.small.muted.mt-4',
          null,
          `Currently ${money(resolved.amount)}${linked ? ` · ${linked.name}` : ''}. Change how it is worked out in the account’s settings.`
        )
      ),
      linked
        ? h(
            'button.btn.sm',
            {
              onclick: () => {
                openAccountEditor(linked);
              },
            },
            'Open account'
          )
        : null
    )
  );
}

/**
 * Add payment reminders for cards and loans that do not have one yet — the
 * bulk version of the checkbox in the account editor.
 */
export async function addPaymentReminders(accounts) {
  const doc = state.doc;
  const list = accounts.filter((a) => !paymentRuleFor(doc, a.id));
  if (!list.length) {
    toast('Every card and loan already has a payment reminder.');
    return false;
  }

  const fromI = accountSelect(doc, {
    filter: (a) => !isLiability(a.type),
    value: (doc.accounts.find((a) => !a.archived && a.type === 'checking') || {}).id,
  });
  const dayInputs = new Map();

  const rows = list.map((a) => {
    const dayI = textInput({
      type: 'number',
      min: 1,
      max: 31,
      value: a.dueDay || '',
      placeholder: '28',
      style: { width: '80px' },
    });
    dayInputs.set(a.id, dayI);
    const owed = Math.abs(balanceOf(doc, a.id));
    return h(
      'div.list-row',
      null,
      h('div.avatar', null, a.type === 'credit' ? '💳' : '🏛️'),
      h(
        'div.l-main',
        null,
        h('div.l-title', null, a.name),
        h(
          'div.l-sub',
          null,
          a.type === 'credit'
            ? `${money(owed)} owed · minimum ${money(minimumPayment(a, -owed))}`
            : `${money(owed)} owed · payment ${money(Number(a.paymentAmount) || 0)}`
        )
      ),
      h('div.row.gap-6', null, h('span.small.muted', null, 'Due day'), dayI)
    );
  });

  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
      m.close();
    };
    const m = modal({
      title: 'Add these payments to Bills & Income',
      body: h(
        'div.col.gap-16',
        null,
        h(
          'p.muted.small',
          null,
          'Each one becomes a monthly item you can see on the calendar and in the forecast. Card amounts follow the balance, so the minimum is always current.'
        ),
        field('Pay from', fromI),
        h('div.card', null, h('div.card-body.flush', null, ...rows)),
        h('p.tiny.dim', null, 'Leave a due day blank to use the 1st. You can change any of this later.')
      ),
      footer: [
        h('button.btn', { onclick: () => done(false) }, 'Cancel'),
        h(
          'button.btn.primary',
          {
            autofocus: true,
            onclick: () => {
              commit(`Add ${list.length} payment reminder${list.length === 1 ? '' : 's'}`, (d) => {
                for (const a of list) {
                  const day = Number(dayInputs.get(a.id).value) || Number(a.dueDay) || 1;
                  d.recurring.push(
                    touchRule(
                      buildPaymentRule(d, a, { fromAccountId: fromI.value, dayOfMonth: day })
                    )
                  );
                }
              });
              toastOk(`${list.length} payment${list.length === 1 ? '' : 's'} added to Bills & Income`);
              done(true);
            },
          },
          icon('plus', { size: 15 }),
          `Add ${list.length}`
        ),
      ],
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      },
    });
  });
}

function touchRule(rule) {
  return { ...rule, updatedAt: new Date().toISOString() };
}

/* ---------------------- mark a scheduled item paid ---------------- */

export function markOccurrencePaid(rule, date) {
  const doc = state.doc;
  // An amount set for this one date is what should be offered, not the rule's
  // usual figure — that is the whole point of having set it.
  const resolved = resolveOccurrenceAmount(doc, rule, date || today());
  const linked = rule.linkedAccountId ? byId(doc.accounts, rule.linkedAccountId) : null;
  const owed = linked ? Math.max(0, -balanceOf(doc, linked.id)) : 0;

  const amountI = moneyInput({ value: Number(resolved.amount || 0).toFixed(2) });
  const dateI = dateInput({ value: date || today() });
  const accountI = accountSelect(doc, { value: rule.accountId });
  const noteI = textInput({ placeholder: 'Optional note' });
  // Autopay has almost certainly gone through; anything else is the person's
  // call, and they were not being asked.
  const clearedI = checkbox('Cleared the bank', { checked: !!rule.autoPay });

  /* ---- what the payment is actually made of ---- */

  // Only for loans and mortgages. A card's interest is charged by the issuer
  // and shows on the statement; it is not carved out of what you choose to pay.
  const amortising = !!linked && isAmortising(linked.type);
  const suggested = amortising
    ? paymentBreakdown(doc, linked, { amount: Number(resolved.amount) || 0, balance: -owed })
    : null;

  const splitI = checkbox('Split out escrow and interest', { checked: true });
  const escrowI = moneyInput({ value: suggested ? suggested.escrow.toFixed(2) : '' });
  const interestI = moneyInput({ value: suggested ? suggested.interest.toFixed(2) : '' });
  const splitSummary = h('div.small.mt-8');
  const splitFields = h(
    'div.grid.grid-2.mt-8',
    null,
    field('Escrow', escrowI),
    field('Interest this month', interestI)
  );

  /** What the entered amount breaks into, given whatever is in the boxes. */
  function currentSplit(total) {
    const escrow = Math.min(total, Math.abs(readMoney(escrowI) || 0));
    const toLoan = round2(total - escrow);
    const interest = round2(Math.max(0, Math.min(Math.abs(readMoney(interestI) || 0), toLoan)));
    return { escrow, toLoan, interest, principal: round2(toLoan - interest) };
  }

  function refreshSplit() {
    if (!amortising) return;
    const on = splitI.querySelector('input').checked;
    splitFields.classList.toggle('hidden', !on);
    const total = Math.abs(readMoney(amountI) || 0);
    if (!on) {
      mount(
        splitSummary,
        h(
          'span.muted',
          null,
          `The whole ${money(total)} will come off the balance. That is only right if this lender ` +
            'charges no interest.'
        )
      );
      return;
    }
    const parts = currentSplit(total);
    const after = round2(owed - parts.principal);
    mount(
      splitSummary,
      h(
        'div.row.wrap.gap-12',
        null,
        h('span.strong.pos', null, `${money(parts.principal)} off the balance`),
        h('span.muted', null, `· ${money(after)} left owing`),
        parts.principal <= 0
          ? h('span.neg.strong', null, '· this payment does not cover the interest')
          : null
      )
    );
  }

  const splitBox = amortising
    ? h(
        'div.card.pad',
        { style: { background: 'var(--surface-2)' } },
        splitI,
        splitFields,
        splitSummary,
        h(
          'p.tiny.dim.mt-8',
          null,
          'Your lender takes the month’s interest first, and escrow never reaches the loan at ' +
            'all. Recording the payment as one lump would shrink the balance faster than the ' +
            'lender does.'
        )
      )
    : null;

  if (amortising) {
    splitI.querySelector('input').addEventListener('change', refreshSplit);
    for (const el of [escrowI, interestI, amountI]) {
      el.addEventListener('input', refreshSplit);
      el.addEventListener('change', refreshSplit);
    }
    refreshSplit();
  }

  // Paying a card? Offer the two amounts people actually choose between.
  const shortcuts = linked && owed > 0 && !amortising
    ? h(
        'div.row.gap-6',
        null,
        h(
          'button.btn.sm',
          {
            onclick: () => {
              amountI.querySelector('input').value = minimumPayment(linked, -owed).toFixed(2);
            },
          },
          `Minimum ${money(minimumPayment(linked, -owed))}`
        ),
        h(
          'button.btn.sm',
          {
            onclick: () => {
              amountI.querySelector('input').value = owed.toFixed(2);
            },
          },
          `Pay in full ${money(owed)}`
        )
      )
    : null;

  const m = modal({
    title: `Record “${rule.name}”`,
    size: 'sm',
    body: h(
      'div.col.gap-12',
      null,
      h(
        'p.muted.small',
        null,
        resolved.note
          ? `${resolved.note}. Change the amount if you are paying something different.`
          : rule.variableAmount
            ? 'This amount varies — enter what was actually paid.'
            : 'Confirm the details and it will be added to your ledger.'
      ),
      field('Amount', amountI),
      shortcuts,
      splitBox,
      field('Date', dateI),
      field(rule.kind === 'income' ? 'Deposit into' : 'Paid from', accountI),
      field('Note', noteI),
      clearedI
    ),
    footer: [
      h('button.btn', { onclick: () => m.close() }, 'Cancel'),
      h(
        'button.btn.primary',
        {
          onclick: () => {
            const amount = Math.abs(readMoney(amountI) || 0);
            const cleared = clearedI.querySelector('input').checked;
            const notes = noteI.value.trim();
            const when = dateI.value;
            const split = amortising && splitI.querySelector('input').checked;
            const parts = split ? currentSplit(amount) : null;

            commit(`Record ${rule.name}`, (d) => {
              const add = (tx) =>
                d.transactions.push(
                  touch({ id: uid('tx'), cleared: false, tags: [], splits: [], ...tx })
                );

              // The payment itself. On an amortising loan the escrow never
              // reaches the lender, so only the rest moves to the loan.
              add({
                type: rule.kind === 'income' ? 'income' : rule.kind === 'transfer' ? 'transfer' : 'expense',
                date: when,
                amount: parts ? parts.toLoan : amount,
                accountId: accountI.value,
                transferAccountId: rule.kind === 'transfer' ? rule.transferAccountId : '',
                categoryId: rule.categoryId || '',
                payee: rule.payee || rule.name,
                notes,
                cleared,
                recurringId: rule.id,
              });

              if (parts && parts.escrow > 0) {
                add({
                  type: 'expense',
                  date: when,
                  amount: parts.escrow,
                  accountId: accountI.value,
                  transferAccountId: '',
                  categoryId: categoryIdNamed(d, 'Escrow (tax & insurance)') || categoryIdNamed(d, 'Property Tax'),
                  payee: rule.payee || rule.name,
                  notes: 'Escrow — taxes and insurance',
                  cleared,
                });
              }

              if (parts && parts.interest > 0) {
                // Charged *to the loan*, which is what stops the balance
                // falling by the whole payment.
                add({
                  type: 'expense',
                  date: when,
                  amount: parts.interest,
                  accountId: linked.id,
                  transferAccountId: '',
                  categoryId: categoryIdNamed(d, 'Interest Charge'),
                  payee: linked.institution || linked.name,
                  notes: 'Interest portion of the payment',
                  cleared: true,
                });
              }

              const r = d.recurring.find((x) => x.id === rule.id);
              if (r) r.lastPaidDate = when;
            });

            m.close();
            toastOk(
              parts && parts.interest > 0
                ? `${rule.name} recorded — ${money(parts.principal)} off the balance`
                : `${rule.name} recorded`
            );
          },
        },
        'Record it'
      ),
    ],
  });
}

/* ---------------- change one occurrence's amount ------------------ */

/**
 * Set the amount for a single dated occurrence.
 *
 * A payday that varies is the case this exists for: the schedule is right and
 * the usual amount is right on average, but the amount arriving on the 15th is
 * known now. Editing the rule itself would rewrite every future occurrence, so
 * the figure is attached to the one date instead.
 */
export function adjustOccurrence(rule, date) {
  const doc = state.doc;
  const usual = resolveRuleAmount(doc, rule);
  const current = resolveOccurrenceAmount(doc, rule, date);
  const existing = occurrenceOverride(rule, date);
  const income = rule.kind === 'income';

  const amountI = moneyInput({ value: Number(current.amount || 0).toFixed(2) });
  const noteI = textInput({
    value: existing ? existing.note || '' : '',
    placeholder: income ? 'e.g. overtime week' : 'e.g. quarterly true-up',
  });

  const m = modal({
    title: `${fmtDate(date, 'long')} — ${rule.name}`,
    size: 'sm',
    body: h(
      'div.col.gap-12',
      null,
      h(
        'p.muted.small',
        null,
        income
          ? 'Set what you are actually being paid on this date. Every other payday keeps the usual amount.'
          : 'Set what this one is actually going to be. Every other occurrence keeps the usual amount.'
      ),
      field('Amount for this date', amountI),
      field('Note', noteI),
      h(
        'div.between.small.muted',
        null,
        h('span', null, 'Usual amount'),
        h('span.money-mask', null, `${usual.estimated ? '~' : ''}${money(usual.amount || 0)}`)
      )
    ),
    footer: [
      existing
        ? h(
            'button.btn.left',
            {
              onclick: () => {
                clearOverride(rule, date);
                m.close();
                toastOk(`${rule.name} back to ${money(usual.amount || 0)} on ${fmtDate(date, 'day')}`);
              },
            },
            'Use the usual amount'
          )
        : null,
      h('button.btn', { onclick: () => m.close() }, 'Cancel'),
      h(
        'button.btn.primary',
        {
          onclick: () => {
            const amount = Math.abs(readMoney(amountI) || 0);
            const cutoff = addDays(today(), -400);
            const note = noteI.value.trim();
            commit(`Set amount for ${rule.name}`, (d) => {
              const r = d.recurring.find((x) => x.id === rule.id);
              if (!r) return;
              if (!Array.isArray(r.overrides)) r.overrides = [];
              const entry = r.overrides.find((o) => o && o.date === date);
              if (entry) {
                entry.amount = amount;
                entry.note = note;
                entry.createdAt = new Date().toISOString();
                delete entry.removedAt;
              } else {
                r.overrides.push({ date, amount, note, createdAt: new Date().toISOString() });
              }
              r.overrides = pruneOverrides(r.overrides, cutoff);
              touch(r);
            });
            m.close();
            toastOk(`${fmtDate(date, 'day')} set to ${money(amount)}`);
          },
        },
        'Save for this date'
      ),
    ].filter(Boolean),
  });
}

function clearOverride(rule, date) {
  commit(`Reset ${rule.name}`, (d) => {
    const r = d.recurring.find((x) => x.id === rule.id);
    if (!r || !Array.isArray(r.overrides)) return;
    const entry = r.overrides.find((o) => o && o.date === date);
    if (entry) entry.removedAt = new Date().toISOString();
    touch(r);
  });
}

/* ------------------- skip a single occurrence --------------------- */

const SKIP_REASONS = [
  { value: 'lender', label: "Lender's skip-a-pay", text: "Lender's skip-a-pay offer" },
  { value: 'ahead', label: 'Paid ahead', text: 'Already paid ahead' },
  { value: 'nothing', label: 'Not due', text: 'Nothing due this time' },
  { value: 'other', label: 'Other', text: '' },
];

/**
 * Skip one occurrence of a schedule.
 *
 * This is the answer to "my bank lets me skip a payment in December". Deleting
 * the schedule would lose every future payment with it and pausing would stop
 * them all until it was remembered; a skip takes out exactly one month and
 * leaves January due on the 5th as before.
 *
 * Interest is the part people are surprised by, so the dialog states it rather
 * than hiding it: a lender's skip-a-pay does not pause interest, which is how
 * the offer pays for itself.
 */
export function skipOccurrence(rule, date) {
  const doc = state.doc;
  const resolved = resolveRuleAmount(doc, rule);
  const linked = rule.linkedAccountId ? byId(doc.accounts, rule.linkedAccountId) : null;
  const owed = linked ? Math.max(0, -balanceOf(doc, linked.id)) : 0;
  const isCard = !!linked && linked.type === 'credit';
  const income = rule.kind === 'income';
  const interest = linked ? skipInterest(linked, owed) : 0;

  let reason = income ? 'nothing' : linked ? 'lender' : 'nothing';
  const otherI = textInput({ placeholder: 'Why are you skipping it?' });
  const otherRow = h('div.field.hidden', null, otherI);
  const reasonI = segmented(
    SKIP_REASONS.map((r) => ({ value: r.value, label: r.label })),
    reason,
    (v) => {
      reason = v;
      otherRow.classList.toggle('hidden', v !== 'other');
      if (v === 'other') otherI.focus();
    }
  );

  const interestI = checkbox(`Interest still accrues — add ${money(interest)} to ${linked ? linked.name : ''}`, {
    checked: interest > 0,
  });
  const feeI = moneyInput({ value: '' });
  const feeAccountI = accountSelect(doc, { value: linked ? linked.id : rule.accountId });

  const liabilityRows = linked
    ? h(
        'div.col.gap-12',
        null,
        interest > 0
          ? h(
              'div.col.gap-4',
              null,
              interestI,
              h(
                'div.tiny.dim',
                null,
                `One month of interest on ${money(owed, { cents: false })} at ${Number(linked.apr) || 0}% APR. ` +
                  'Skipping a payment does not pause it.'
              )
            )
          : null,
        h('div.grid.grid-2', null, field('Skip fee (if any)', feeI), field('Fee charged to', feeAccountI))
      )
    : null;

  const consequence = isCard
    ? h(
        'div.card.pad.small',
        { style: { borderLeft: '3px solid var(--st-warning)' } },
        h('div.strong', null, 'Card issuers do not offer skip-a-pay'),
        h(
          'div.muted.mt-4',
          null,
          'If this payment is genuinely owed, skipping it means a late fee, interest on the ' +
            'whole balance, and a possible mark on your credit report. If you have already ' +
            'paid this month ahead of the due date, carry on.'
        )
      )
    : linked
      ? h(
          'p.muted.small',
          null,
          'Your payoff date moves out by about a month and total interest goes up. ' +
            'The rest of the schedule is untouched.'
        )
      : h('p.muted.small', null, 'Only this one date is skipped — the rest of the schedule is untouched.');

  const m = modal({
    title: `Skip “${rule.name}”?`,
    size: 'sm',
    body: h(
      'div.col.gap-12',
      null,
      h(
        'div.between',
        null,
        h('span.muted', null, fmtDate(date, 'long')),
        h(
          'span.strong.money-mask',
          null,
          `${resolved.estimated ? '~' : ''}${money(resolved.amount || 0)}`
        )
      ),
      h(
        'p.muted.small',
        null,
        income
          ? 'This deposit will not be expected, so it stops showing as due and drops out of the forecast.'
          : 'It stops showing as due, comes off the calendar and leaves the forecast alone.'
      ),
      field('Reason', reasonI),
      otherRow,
      liabilityRows,
      consequence
    ),
    footer: [
      h('button.btn', { onclick: () => m.close() }, 'Cancel'),
      h(
        'button.btn.primary',
        {
          onclick: () => {
            const picked = SKIP_REASONS.find((r) => r.value === reason) || SKIP_REASONS[3];
            const text = reason === 'other' ? otherI.value.trim() : picked.text;
            const addInterest = interest > 0 && interestI.querySelector('input').checked;
            const fee = Math.abs(readMoney(feeI) || 0);
            const extra = [];
            if (linked && addInterest) {
              extra.push({
                type: 'expense',
                date,
                amount: interest,
                accountId: linked.id,
                categoryId: categoryIdNamed(doc, 'Interest Charge'),
                payee: linked.institution || linked.name,
                notes: 'Interest during a skipped payment',
              });
            }
            if (fee > 0) {
              extra.push({
                type: 'expense',
                date,
                amount: fee,
                accountId: feeAccountI.value,
                categoryId: categoryIdNamed(doc, 'Bank Fees'),
                payee: linked ? linked.institution || linked.name : rule.payee || rule.name,
                notes: 'Skip-a-pay fee',
              });
            }
            applySkip(rule, date, text, extra);
            m.close();
            toastOk(`${rule.name} skipped for ${fmtDate(date, 'day')}`, {
              action: { label: 'Undo', onClick: () => unskipOccurrence(rule, date, { quiet: true }) },
            });
          },
        },
        'Skip this payment'
      ),
    ],
  });
}

/** Write the skip and any interest or fee it causes as one undoable change. */
function applySkip(rule, date, reason, extraTransactions = []) {
  const cutoff = addDays(today(), -400);
  commit(`Skip ${rule.name}`, (d) => {
    const r = d.recurring.find((x) => x.id === rule.id);
    if (!r) return;
    if (!Array.isArray(r.skips)) r.skips = [];
    const existing = r.skips.find((s) => s && s.date === date);
    if (existing) {
      existing.reason = reason;
      existing.createdAt = new Date().toISOString();
      delete existing.removedAt;
    } else {
      r.skips.push({ date, reason, createdAt: new Date().toISOString() });
    }
    r.skips = pruneSkips(r.skips, cutoff);
    touch(r);
    for (const tx of extraTransactions) {
      d.transactions.push(touch({ id: uid('tx'), cleared: false, tags: [], splits: [], ...tx }));
    }
  });
}

/**
 * Put a skipped occurrence back. The record is kept with `removedAt` rather
 * than deleted so that a merge can tell an undo from a computer that never
 * heard about the skip.
 */
export function unskipOccurrence(rule, date, { quiet = false } = {}) {
  commit(`Restore ${rule.name}`, (d) => {
    const r = d.recurring.find((x) => x.id === rule.id);
    if (!r || !Array.isArray(r.skips)) return;
    const entry = r.skips.find((s) => s && s.date === date);
    if (entry) entry.removedAt = new Date().toISOString();
    touch(r);
  });
  if (!quiet) toastOk(`${rule.name} is due again on ${fmtDate(date, 'day')}`);
}

function categoryIdNamed(doc, name) {
  const wanted = String(name).toLowerCase();
  const match = (doc.categories || []).find((c) => !c.archived && String(c.name).toLowerCase() === wanted);
  return match ? match.id : '';
}

/* ================================================================== */
/* Goal                                                               */
/* ================================================================== */

export function openGoalEditor(existing = null) {
  const doc = state.doc;
  const goal = existing
    ? { ...existing }
    : { name: '', targetAmount: 0, targetDate: '', accountId: '', baseline: 0, monthlyContribution: 0, color: '#1baf7a', notes: '', contributions: [] };

  const nameI = textInput({ value: goal.name, placeholder: 'Emergency fund' });
  const targetI = moneyInput({ value: goal.targetAmount ? Number(goal.targetAmount).toFixed(2) : '' });
  const dateI = dateInput({ value: goal.targetDate || '' });
  const acctI = accountSelect(doc, { value: goal.accountId, allowEmpty: true, filter: (a) => !isLiability(a.type) });
  const baseI = moneyInput({ value: goal.baseline ? Number(goal.baseline).toFixed(2) : '' });
  const monthlyI = moneyInput({ value: goal.monthlyContribution ? Number(goal.monthlyContribution).toFixed(2) : '' });
  const colorI = h('input', {
    type: 'color', value: goal.color || '#1baf7a',
    style: { width: '44px', height: '36px', border: '1px solid var(--border-2)', borderRadius: '9px' },
  });
  const notesI = textArea({ value: goal.notes || '', rows: 2 });

  const m = modal({
    title: existing ? 'Edit goal' : 'New savings goal',
    body: h(
      'div.col.gap-16',
      null,
      h('div.grid.grid-2', null, field('Goal name', nameI), field('Target amount', targetI)),
      h('div.grid.grid-2', null, field('Target date', dateI), field('Monthly contribution', monthlyI)),
      field('Track against account', acctI, {
        hint: 'Optional. Progress is measured by the growth of this account above the starting point below.',
      }),
      field('Starting point in that account', baseI, { hint: 'The balance that was already there when the goal began.' }),
      h('div.row', null, h('div.grow', null, field('Notes', notesI)), h('div.field', null, h('label.label', null, 'Colour'), colorI))
    ),
    footer: [
      existing
        ? h(
            'button.btn.danger-soft.left',
            {
              onclick: async () => {
                if (await confirm({ title: `Delete “${existing.name}”?`, confirmLabel: 'Delete', tone: 'danger' })) {
                  removeFrom('goals', existing.id, 'Delete goal');
                  m.close();
                }
              },
            },
            'Delete'
          )
        : null,
      h('button.btn', { onclick: () => m.close() }, 'Cancel'),
      h(
        'button.btn.primary',
        {
          onclick: () => {
            const name = nameI.value.trim();
            if (!name) return toast('Name your goal.', { tone: 'warn' });
            upsert(
              'goals',
              {
                id: existing ? existing.id : uid('goal'),
                name,
                targetAmount: readMoney(targetI),
                targetDate: dateI.value || '',
                accountId: acctI.value || '',
                baseline: readMoney(baseI),
                monthlyContribution: readMoney(monthlyI),
                color: colorI.value,
                notes: notesI.value.trim(),
                contributions: goal.contributions || [],
                priority: goal.priority || 0,
              },
              existing ? 'Edit goal' : 'Add goal'
            );
            m.close();
            toastOk(existing ? 'Goal updated' : 'Goal created');
            return undefined;
          },
        },
        'Save'
      ),
    ].filter(Boolean),
  });
}

export function openContributionDialog(goal) {
  const amountI = moneyInput({});
  const dateI = dateInput({ value: today() });
  const m = modal({
    title: `Add to “${goal.name}”`,
    size: 'sm',
    body: h('div.col.gap-12', null, field('Amount', amountI), field('Date', dateI)),
    footer: [
      h('button.btn', { onclick: () => m.close() }, 'Cancel'),
      h(
        'button.btn.primary',
        {
          onclick: () => {
            const amount = readMoney(amountI);
            if (!amount) return toast('Enter an amount.', { tone: 'warn' });
            commit('Add goal contribution', (d) => {
              const g = d.goals.find((x) => x.id === goal.id);
              if (g) {
                g.contributions = g.contributions || [];
                g.contributions.push({ id: uid('con'), amount, date: dateI.value });
              }
            });
            m.close();
            toastOk('Contribution added');
            return undefined;
          },
        },
        'Add'
      ),
    ],
  });
}

/* ================================================================== */
/* Budget                                                             */
/* ================================================================== */

export function openBudgetEditor(month) {
  const doc = state.doc;
  const rows = new Map();
  for (const b of doc.budgets || []) {
    if (b.month === month || !b.month || b.month === 'default') rows.set(b.categoryId, b);
  }

  const expenseCats = (doc.categories || [])
    .filter((c) => c.kind === 'expense' && !c.archived)
    .sort((a, b) => (a.group || '').localeCompare(b.group || '') || (a.sort || 0) - (b.sort || 0));

  const inputs = new Map();
  const grouped = new Map();
  for (const c of expenseCats) {
    if (!grouped.has(c.group)) grouped.set(c.group, []);
    grouped.get(c.group).push(c);
  }

  const body = h(
    'div.col.gap-16',
    null,
    h('p.muted.small', null, 'Leave a category blank to leave it unbudgeted. Rollover carries anything unspent into next month.'),
    ...[...grouped.entries()].map(([group, cats]) =>
      h(
        'div',
        null,
        h('div.eyebrow.mb-8', null, group),
        h(
          'div.col.gap-8',
          null,
          ...cats.map((c) => {
            const existing = rows.get(c.id);
            const amt = moneyInput({ value: existing ? Number(existing.amount).toFixed(2) : '' });
            const roll = checkbox('Rollover', { checked: !!(existing && existing.rollover) });
            inputs.set(c.id, { amt, roll });
            return h(
              'div.row',
              null,
              h('div.grow', null, `${c.icon || ''} ${c.name}`),
              h('div', { style: { width: '150px' } }, amt),
              roll
            );
          })
        )
      )
    )
  );

  const m = modal({
    title: `Budget for ${month}`,
    size: 'lg',
    body,
    footer: [
      h('button.btn', { onclick: () => m.close() }, 'Cancel'),
      h(
        'button.btn.primary',
        {
          onclick: () => {
            commit('Update budget', (d) => {
              d.budgets = (d.budgets || []).filter((b) => b.month !== month);
              for (const [categoryId, { amt, roll }] of inputs) {
                const amount = readMoney(amt);
                if (!amount) continue;
                d.budgets.push({
                  id: uid('bud'),
                  categoryId,
                  month,
                  amount,
                  rollover: roll.querySelector('input').checked,
                });
              }
            });
            m.close();
            toastOk('Budget saved');
          },
        },
        'Save budget'
      ),
    ],
  });
}

/* ================================================================== */
/* Category manager                                                   */
/* ================================================================== */

/* ================================================================== */
/* Categories                                                         */
/* ================================================================== */

export function openCategoryManager() {
  const doc = state.doc;
  const list = h('div.col.gap-8');

  const render = () => {
    const groups = new Map();
    for (const c of doc.categories) {
      if (!groups.has(c.group)) groups.set(c.group, []);
      groups.get(c.group).push(c);
    }

    const row = (c, depth) => {
      const kids = depth === 0 ? categoryChildren(doc, c.id, { includeArchived: true }) : [];
      return h(
        'div.list-row',
        {
          style: depth ? { paddingLeft: '34px' } : null,
          onclick: (e) => { if (!e.target.closest('button')) openCategoryDialog(c, render); },
        },
        depth ? h('span.dim', { style: { marginRight: '-4px' } }, '↳') : null,
        h('div.avatar', null, c.icon || '•'),
        h(
          'div.l-main',
          null,
          h('div.l-title', null, c.name),
          h(
            'div.l-sub',
            null,
            `${c.kind}${c.archived ? ' · archived' : ''}`,
            kids.length ? ` · ${kids.length} sub-categor${kids.length === 1 ? 'y' : 'ies'}` : ''
          )
        ),
        depth === 0
          ? h(
              'button.btn.ghost.icon.sm',
              {
                title: 'Add a sub-category',
                onclick: () => openCategoryDialog(null, render, { parentId: c.id }),
              },
              icon('plus', { size: 14 })
            )
          : null,
        h(
          'button.btn.ghost.icon.sm',
          { title: 'Edit', onclick: () => openCategoryDialog(c, render) },
          icon('edit', { size: 14 })
        ),
        h(
          'button.btn.ghost.icon.sm',
          {
            title: c.archived ? 'Restore' : 'Archive',
            onclick: () => {
              commit('Archive category', (d) => {
                const cat = d.categories.find((x) => x.id === c.id);
                if (cat) cat.archived = !cat.archived;
              });
              render();
            },
          },
          icon('archive', { size: 14 })
        )
      );
    };

    mount(
      list,
      ...[...groups.entries()].map(([group, cats]) => {
        const parents = cats.filter((c) => !c.parentId);
        const rows = [];
        for (const parent of parents) {
          rows.push(row(parent, 0));
          for (const child of cats.filter((c) => c.parentId === parent.id)) rows.push(row(child, 1));
        }
        // A child whose parent lives in another group still has to appear.
        const placedIds = new Set(
          parents.flatMap((p) => [p.id, ...cats.filter((c) => c.parentId === p.id).map((c) => c.id)])
        );
        for (const stray of cats.filter((c) => !placedIds.has(c.id))) rows.push(row(stray, 1));
        return h(
          'div.card',
          null,
          h('div.card-head', null, h('div.h3', null, group)),
          h('div.card-body.flush', null, ...rows)
        );
      })
    );
  };
  render();

  modal({
    title: 'Categories',
    size: 'lg',
    body: h(
      'div.col.gap-16',
      null,
      h(
        'div.row',
        null,
        h('div.muted.small.grow', null, 'Click a category to change its name, group or icon.'),
        h(
          'button.btn.primary',
          { onclick: () => openCategoryDialog(null, render) },
          icon('plus', { size: 15 }),
          'New category'
        )
      ),
      list
    ),
  });
}

/**
 * Add or edit one category. The icon is a real picker rather than a text box
 * with an emoji placeholder — that looked like a single fixed icon on offer,
 * and typing nothing in it quietly saved a bullet instead.
 */
export function openCategoryDialog(existing = null, onSaved = null, defaults = {}) {
  const doc = state.doc;
  const groups = [...new Set((doc.categories || []).map((c) => c.group).filter(Boolean))].sort();
  const startingParent = existing ? existing.parentId || '' : defaults.parentId || '';
  const parentOf = byId(doc.categories, startingParent);

  const nameI = textInput({ value: existing ? existing.name : '', placeholder: 'Groceries' });
  const groupI = textInput({
    value: existing ? existing.group : '',
    placeholder: 'Food',
    list: 'category-groups',
  });
  const groupList = h(
    'datalist',
    { id: 'category-groups' },
    ...groups.map((g) => h('option', { value: g }))
  );
  const kindI = select(
    [
      { value: 'expense', label: 'Expense' },
      { value: 'income', label: 'Income' },
    ],
    { value: existing ? existing.kind : 'expense' }
  );
  const iconI = emojiPicker({ value: existing ? existing.icon || '' : '' });

  // Only top-level categories can be parents, and nothing can be its own.
  // One level of nesting is the whole design — deeper is a filing system
  // nobody keeps up and totals stop being legible.
  const parentChoices = (doc.categories || [])
    .filter((c) => !c.parentId && !c.archived && (!existing || c.id !== existing.id))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const hasChildren = !!existing && categoryChildren(doc, existing.id, { includeArchived: true }).length > 0;
  const parentI = select(
    [
      { value: '', label: '— none, this is a top-level category —' },
      ...parentChoices.map((c) => ({ value: c.id, label: `${c.icon || ''} ${c.name}`.trim() })),
    ],
    { value: startingParent, disabled: hasChildren }
  );
  const parentRow = field('Sits under', parentI, {
    hint: hasChildren
      ? 'This one already has sub-categories of its own, so it cannot become a sub-category.'
      : 'A sub-category counts toward its parent’s totals and budget.',
  });

  const m = modal({
    title: existing
      ? `Edit “${existing.name}”`
      : parentOf
        ? `New sub-category under ${parentOf.name}`
        : 'New category',
    size: 'md',
    body: h(
      'div.col.gap-14',
      null,
      groupList,
      h('div.grid.grid-2', null, field('Name', nameI), field('Group', groupI)),
      h('div.grid.grid-2', null, field('Type', kindI), parentRow),
      field('Icon', iconI)
    ),
    footer: [
      existing && !existing.system
        ? h(
            'button.btn.danger-soft.left',
            {
              onclick: async () => {
                const used = (doc.transactions || []).filter((t) => t.categoryId === existing.id).length;
                const kids = categoryChildren(doc, existing.id, { includeArchived: true });
                const ok = await confirm({
                  title: `Delete “${existing.name}”?`,
                  message: [
                    used
                      ? `${used} transaction${used === 1 ? '' : 's'} will become uncategorised.`
                      : 'Nothing is using it.',
                    kids.length
                      ? `Its ${kids.length} sub-categor${kids.length === 1 ? 'y' : 'ies'} will be kept and moved to the top level.`
                      : '',
                  ].filter(Boolean).join(' '),
                  confirmLabel: 'Delete',
                  tone: 'danger',
                });
                if (!ok) return;
                commit('Delete category', (d) => {
                  for (const t of d.transactions || []) {
                    if (t.categoryId === existing.id) t.categoryId = '';
                  }
                  // Sub-categories are promoted rather than deleted with the
                  // parent — losing a year of "Vet bills" to tidy up "Pets"
                  // would be a nasty surprise.
                  for (const c of d.categories || []) {
                    if (c.parentId === existing.id) c.parentId = null;
                  }
                  d.categories = d.categories.filter((c) => c.id !== existing.id);
                });
                m.close();
                if (onSaved) onSaved();
              },
            },
            icon('trash', { size: 15 }),
            'Delete'
          )
        : null,
      h('button.btn', { onclick: () => m.close() }, 'Cancel'),
      h(
        'button.btn.primary',
        {
          onclick: () => {
            const name = nameI.value.trim();
            if (!name) {
              toast('Give it a name.', { tone: 'warn' });
              nameI.focus();
              return;
            }
            const parentId = hasChildren ? existing.parentId || null : parentI.value || null;
            const parent = byId(doc.categories, parentId);
            const patch = {
              name,
              // A sub-category lives in its parent's group, so the tree and the
              // headings can never disagree about where it belongs.
              group: parent ? parent.group : groupI.value.trim() || 'Other',
              kind: parent ? parent.kind : kindI.value,
              icon: iconI.value.trim() || '•',
              parentId,
            };
            commit(existing ? 'Edit category' : 'Add category', (d) => {
              if (existing) {
                const cat = d.categories.find((x) => x.id === existing.id);
                if (cat) {
                  Object.assign(cat, patch);
                  touch(cat);
                }
              } else {
                d.categories.push(
                  touch({ id: uid('cat'), ...patch, color: null, archived: false, sort: d.categories.length })
                );
              }
            });
            m.close();
            toastOk(existing ? 'Category updated' : `${name} added`);
            if (onSaved) onSaved();
          },
        },
        'Save'
      ),
    ].filter(Boolean),
  });
}
