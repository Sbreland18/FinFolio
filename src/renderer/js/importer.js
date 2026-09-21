/**
 * Statement import wizard: CSV / OFX / QFX / QIF → transactions.
 *
 * Three steps — choose the file, confirm how the columns map, review what will
 * be added. Duplicates are detected against the existing ledger and skipped by
 * default, and auto-categorisation rules run before the preview so what you see
 * is exactly what gets saved.
 */

import { h, mount } from './dom.js';
import { icon } from './icons.js';
import { money, fmtDate, today, round2 } from './format.js';
import {
  parseCSV, parseOFX, parseQIF, guessMapping, parseDate, parseNumber, detectDelimiter,
} from './parsers.js';
import { findDuplicate, applyRules, suggestCategory, categoryName, accountName, isLiability, byId } from './finance.js';
import {
  modal, field, select, checkbox, accountSelect, categorySelect, toast, toastOk, toastErr, badge,
} from './ui.js';
import { state, addTransactions } from './state.js';

const api = window.finfolio;

export async function openImporter(defaultAccountId = '') {
  const doc = state.doc;
  if (!doc.accounts.length) {
    toast('Add an account before importing.', { tone: 'warn' });
    return;
  }

  const ctx = {
    step: 0,
    fileName: '',
    raw: '',
    format: 'csv',
    rows: [],
    headers: [],
    hasHeader: true,
    delimiter: ',',
    mapping: {},
    dateOrder: 'auto',
    signMode: 'standard', // standard | inverted | debitCredit
    accountId: defaultAccountId || doc.accounts[0].id,
    parsed: [],
    skipDuplicates: true,
    applyRules: true,
    markCleared: true,
  };

  const body = h('div');
  const foot = h('div.row.gap-8', { style: { marginLeft: 'auto' } });

  const m = modal({
    title: 'Import a statement',
    size: 'xl',
    body,
    footer: [h('div.left.small.muted', { id: 'import-hint' }), foot],
  });

  render();

  /* ---------------------------------------------------------------- */

  function render() {
    mount(foot);
    if (ctx.step === 0) renderPick();
    else if (ctx.step === 1) renderMap();
    else renderPreview();
  }

  /* ------------------------------ step 1 -------------------------- */

  function renderPick() {
    mount(
      body,
      h(
        'div.col.gap-16',
        null,
        h(
          'div.dropzone',
          {
            ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add('over'); },
            ondragleave: (e) => e.currentTarget.classList.remove('over'),
            ondrop: async (e) => {
              e.preventDefault();
              e.currentTarget.classList.remove('over');
              const file = e.dataTransfer.files && e.dataTransfer.files[0];
              if (!file) return;
              loadText(file.name, await file.text());
            },
          },
          h('div.center', null, icon('upload', { size: 28 })),
          h('div.strong.mt-8', null, 'Drop a statement here'),
          h('div.small.muted.mt-4', null, 'CSV, OFX, QFX or QIF exported from your bank'),
          h(
            'button.btn.primary.mt-16',
            {
              onclick: async () => {
                const res = await api.files.openText({
                  title: 'Choose a statement file',
                  filters: [
                    { name: 'Statements', extensions: ['csv', 'ofx', 'qfx', 'qif', 'txt'] },
                    { name: 'All files', extensions: ['*'] },
                  ],
                });
                if (!res.ok) {
                  if (res.error !== 'CANCELED') toastErr(`Could not read the file (${res.error})`);
                  return;
                }
                loadText(res.name, res.content);
              },
            },
            icon('folder', { size: 15 }),
            'Choose a file'
          )
        ),
        h(
          'div.card.pad.small.muted',
          null,
          h('div.strong.mb-8', null, 'Tips'),
          h('div', null, '• Most banks have a "Download / Export" button on the transactions page — CSV or QFX both work.'),
          h('div.mt-4', null, '• Import into the matching account; FinFolio skips anything it already has.'),
          h('div.mt-4', null, '• Set up rules in Settings → Categories & rules to categorise automatically next time.')
        )
      )
    );
  }

  function loadText(name, text) {
    ctx.fileName = name;
    ctx.raw = text;
    const lower = name.toLowerCase();
    if (lower.endsWith('.ofx') || lower.endsWith('.qfx') || /<OFX>/i.test(text)) ctx.format = 'ofx';
    else if (lower.endsWith('.qif') || /^!Type:/im.test(text)) ctx.format = 'qif';
    else ctx.format = 'csv';

    if (ctx.format === 'csv') {
      ctx.delimiter = detectDelimiter(text);
      ctx.rows = parseCSV(text, ctx.delimiter);
      if (!ctx.rows.length) {
        toastErr('That file has no readable rows.');
        return;
      }
      ctx.headers = ctx.rows[0];
      ctx.mapping = guessMapping(ctx.headers);
      // Plenty of banks export separate "Debit" and "Credit" columns instead of
      // one signed amount — pick that layout automatically when we see it.
      if (ctx.mapping.amount < 0 && (ctx.mapping.debit >= 0 || ctx.mapping.credit >= 0)) {
        ctx.signMode = 'debitCredit';
      }
      if (ctx.mapping.date < 0 && ctx.mapping.amount < 0 && ctx.signMode !== 'debitCredit') {
        ctx.hasHeader = false;
      }
      ctx.step = 1;
    } else {
      ctx.step = 2;
      buildParsed();
    }
    render();
  }

  /* ------------------------------ step 2 -------------------------- */

  function renderMap() {
    const columnOptions = [
      { value: '-1', label: '— not used —' },
      ...ctx.headers.map((hh, i) => ({ value: String(i), label: `${i + 1}. ${ctx.hasHeader ? hh : `Column ${i + 1}`}` })),
    ];
    const colSelect = (key) =>
      select(columnOptions, {
        value: String(ctx.mapping[key] ?? -1),
        onchange: (e) => {
          ctx.mapping[key] = Number(e.target.value);
          renderMap();
        },
      });

    const sample = ctx.rows.slice(ctx.hasHeader ? 1 : 0, (ctx.hasHeader ? 1 : 0) + 6);

    mount(
      body,
      h(
        'div.col.gap-16',
        null,
        h(
          'div.row.wrap.gap-12',
          null,
          h('span.badge.accent', null, ctx.fileName),
          h('span.small.muted', null, `${ctx.rows.length - (ctx.hasHeader ? 1 : 0)} rows · delimiter “${ctx.delimiter === '\t' ? 'tab' : ctx.delimiter}”`),
          h('div.grow'),
          checkbox('First row is a header', {
            checked: ctx.hasHeader,
            onchange: (e) => {
              ctx.hasHeader = e.target.checked;
              if (ctx.hasHeader) ctx.mapping = guessMapping(ctx.headers);
              renderMap();
            },
          })
        ),
        h(
          'div.grid.grid-2',
          null,
          field('Date column', colSelect('date')),
          field(
            'Date order',
            select(
              [
                { value: 'auto', label: 'Detect automatically' },
                { value: 'MDY', label: 'Month / Day / Year' },
                { value: 'DMY', label: 'Day / Month / Year' },
              ],
              { value: ctx.dateOrder, onchange: (e) => { ctx.dateOrder = e.target.value; renderMap(); } }
            )
          )
        ),
        h(
          'div.grid.grid-2',
          null,
          field(
            'Amount layout',
            select(
              [
                { value: 'standard', label: 'One column — negative means money out' },
                { value: 'inverted', label: 'One column — positive means money out' },
                { value: 'debitCredit', label: 'Separate debit and credit columns' },
              ],
              { value: ctx.signMode, onchange: (e) => { ctx.signMode = e.target.value; renderMap(); } }
            )
          ),
          ctx.signMode === 'debitCredit'
            ? h('div.grid.grid-2', null, field('Debit (out)', colSelect('debit')), field('Credit (in)', colSelect('credit')))
            : field('Amount column', colSelect('amount'))
        ),
        h(
          'div.grid.grid-2',
          null,
          field('Description / payee', colSelect('payee')),
          field('Memo / notes', colSelect('notes'))
        ),
        h(
          'div.card',
          null,
          h('div.card-head', null, h('div.h3', null, 'Preview of the file')),
          h(
            'div.tablewrap',
            { style: { maxHeight: '220px' } },
            h(
              'table.table.preview-table',
              null,
              h(
                'thead',
                null,
                h('tr', null, ...ctx.headers.map((hh, i) => h('th', null, ctx.hasHeader ? hh : `Column ${i + 1}`)))
              ),
              h(
                'tbody',
                null,
                ...sample.map((r) => h('tr', null, ...ctx.headers.map((_, i) => h('td.truncate', null, r[i] ?? ''))))
              )
            )
          )
        )
      )
    );

    mount(
      foot,
      h('button.btn', { onclick: () => { ctx.step = 0; render(); } }, 'Back'),
      h(
        'button.btn.primary',
        {
          onclick: () => {
            if (ctx.mapping.date < 0) return toast('Choose the date column.', { tone: 'warn' });
            if (ctx.signMode === 'debitCredit') {
              if (ctx.mapping.debit < 0 && ctx.mapping.credit < 0) {
                return toast('Choose at least one of the debit / credit columns.', { tone: 'warn' });
              }
            } else if (ctx.mapping.amount < 0) {
              return toast('Choose the amount column.', { tone: 'warn' });
            }
            buildParsed();
            ctx.step = 2;
            render();
            return undefined;
          },
        },
        'Continue',
        icon('chevronRight', { size: 16 })
      )
    );
  }

  /* --------------------------- parse rows ------------------------- */

  function buildParsed() {
    const doc_ = state.doc;
    let rows = [];

    if (ctx.format === 'ofx') rows = parseOFX(ctx.raw);
    else if (ctx.format === 'qif') rows = parseQIF(ctx.raw);
    else {
      const body_ = ctx.rows.slice(ctx.hasHeader ? 1 : 0);
      for (const r of body_) {
        const date = parseDate(r[ctx.mapping.date], ctx.dateOrder);
        if (!date) continue;
        let amount = null;
        if (ctx.signMode === 'debitCredit') {
          const debit = ctx.mapping.debit >= 0 ? parseNumber(r[ctx.mapping.debit]) : null;
          const credit = ctx.mapping.credit >= 0 ? parseNumber(r[ctx.mapping.credit]) : null;
          if (debit) amount = -Math.abs(debit);
          else if (credit) amount = Math.abs(credit);
        } else {
          amount = parseNumber(r[ctx.mapping.amount]);
          if (amount !== null && ctx.signMode === 'inverted') amount = -amount;
        }
        if (amount === null || amount === 0) continue;
        rows.push({
          date,
          amount,
          payee: ctx.mapping.payee >= 0 ? String(r[ctx.mapping.payee] || '').trim() : '',
          notes: ctx.mapping.notes >= 0 ? String(r[ctx.mapping.notes] || '').trim() : '',
        });
      }
    }

    ctx.parsed = rows.map((r) => {
      const candidate = {
        type: r.amount >= 0 ? 'income' : 'expense',
        date: r.date,
        amount: Math.abs(r.amount),
        accountId: ctx.accountId,
        payee: cleanPayee(r.payee),
        notes: r.notes || '',
        categoryId: '',
        cleared: ctx.markCleared,
        tags: [],
        splits: [],
        importId: r.fitid || '',
      };
      if (ctx.applyRules) {
        const match = applyRules(doc_, candidate);
        if (match) Object.assign(candidate, match.patch);
      }
      if (!candidate.categoryId) {
        const guess = suggestCategory(doc_, candidate.payee);
        if (guess) candidate.categoryId = guess;
      }
      const dup = findDuplicate(doc_, candidate);
      return { ...candidate, _duplicate: !!dup, _include: !dup || !ctx.skipDuplicates };
    });
  }

  /* ------------------------------ step 3 -------------------------- */

  function renderPreview() {
    const included = ctx.parsed.filter((r) => r._include);
    const dupes = ctx.parsed.filter((r) => r._duplicate).length;
    const uncategorised = included.filter((r) => !r.categoryId && r.type === 'expense').length;
    const inflow = round2(included.filter((r) => r.type === 'income').reduce((s, r) => s + r.amount, 0));
    const outflow = round2(included.filter((r) => r.type === 'expense').reduce((s, r) => s + r.amount, 0));

    const table = h(
      'div.tablewrap',
      { style: { maxHeight: '330px' } },
      h(
        'table.table',
        null,
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', { style: { width: '34px' } }, ''),
            h('th', null, 'Date'),
            h('th', null, 'Payee'),
            h('th', null, 'Category'),
            h('th.num', null, 'Amount'),
            h('th', null, '')
          )
        ),
        h(
          'tbody',
          null,
          ...ctx.parsed.slice(0, 400).map((r, i) =>
            h(
              'tr',
              { style: r._include ? null : { opacity: '0.45' } },
              h(
                'td',
                null,
                h('input', {
                  type: 'checkbox',
                  checked: r._include,
                  onchange: (e) => {
                    r._include = e.target.checked;
                    renderPreview();
                  },
                })
              ),
              h('td.nowrap', null, fmtDate(r.date)),
              h('td.truncate', null, r.payee || '—'),
              h(
                'td',
                null,
                categorySelect(state.doc, {
                  value: r.categoryId,
                  kind: r.type === 'income' ? 'income' : 'expense',
                  onchange: (e) => { r.categoryId = e.target.value; },
                  style: { height: '28px', fontSize: '12.5px' },
                })
              ),
              h(
                'td.num',
                { class: r.type === 'income' ? 'pos' : '' },
                `${r.type === 'income' ? '+' : '−'}${money(r.amount)}`
              ),
              h('td', null, r._duplicate ? badge('Duplicate', 'warn') : null)
            )
          )
        )
      )
    );

    mount(
      body,
      h(
        'div.col.gap-16',
        null,
        h(
          'div.grid.grid-2',
          null,
          field(
            'Import into account',
            accountSelect(state.doc, {
              value: ctx.accountId,
              onchange: (e) => {
                ctx.accountId = e.target.value;
                buildParsed();
                renderPreview();
              },
            })
          ),
          h(
            'div.field',
            null,
            h('label.label', null, 'Options'),
            h(
              'div.col.gap-8',
              null,
              checkbox('Skip transactions that look like duplicates', {
                checked: ctx.skipDuplicates,
                onchange: (e) => {
                  ctx.skipDuplicates = e.target.checked;
                  for (const r of ctx.parsed) r._include = !r._duplicate || !ctx.skipDuplicates;
                  renderPreview();
                },
              }),
              checkbox('Mark imported transactions as cleared', {
                checked: ctx.markCleared,
                onchange: (e) => {
                  ctx.markCleared = e.target.checked;
                  for (const r of ctx.parsed) r.cleared = ctx.markCleared;
                },
              })
            )
          )
        ),
        h(
          'div.row.wrap.gap-16.small',
          null,
          h('span.strong', null, `${included.length} to import`),
          dupes ? h('span.warnc', null, `${dupes} duplicate${dupes === 1 ? '' : 's'} found`) : null,
          uncategorised ? h('span.muted', null, `${uncategorised} without a category`) : null,
          h('span.pos', null, `+${money(inflow)}`),
          h('span.neg', null, `−${money(outflow)}`)
        ),
        h('div.card', null, table),
        ctx.parsed.length > 400 ? h('p.tiny.dim', null, `Showing the first 400 of ${ctx.parsed.length} rows — all of them will be imported.`) : null
      )
    );

    mount(
      foot,
      h(
        'button.btn',
        { onclick: () => { ctx.step = ctx.format === 'csv' ? 1 : 0; render(); } },
        'Back'
      ),
      h(
        'button.btn.primary',
        {
          disabled: !included.length,
          onclick: () => {
            const payload = included.map((r) => {
              const { _duplicate, _include, ...rest } = r;
              return { ...rest, accountId: ctx.accountId, cleared: ctx.markCleared };
            });
            addTransactions(payload, `Import ${payload.length} transactions`);
            m.close();
            toastOk(`Imported ${payload.length} transactions into ${accountName(state.doc, ctx.accountId)}`);
          },
        },
        icon('check', { size: 16 }),
        `Import ${included.length}`
      )
    );
  }
}

/** Tidy the noisy payee strings banks emit. */
function cleanPayee(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/\s{2,}/g, ' ');
  s = s.replace(/^(POS |DEBIT |CREDIT |ACH |CHECKCARD |PURCHASE |PAYMENT )+/i, '');
  s = s.replace(/\s+(#\d+|\d{4,})$/g, '');
  s = s.replace(/\s+\d{2}\/\d{2}$/, '');
  if (s === s.toUpperCase() && s.length > 3) {
    s = s
      .toLowerCase()
      .replace(/\b[a-z]/g, (c) => c.toUpperCase())
      .replace(/\b(Llc|Inc|Usa|Atm|Us)\b/g, (mm) => mm.toUpperCase());
  }
  return s.trim();
}
