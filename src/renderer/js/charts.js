/**
 * Dependency-free SVG charts.
 *
 * Follows the project's visualization rules: one y-axis only, categorical hues
 * assigned in fixed slot order (never cycled), 2px lines, 4px rounded data-ends
 * anchored to the baseline, a 2px surface gap between stacked segments, a
 * legend whenever there are two or more series, direct end-labels at four or
 * fewer, a crosshair/hover tooltip on every plot, and a table view toggle so
 * values are never carried by color alone.
 */

import { h, mount } from './dom.js';

const NS = 'http://www.w3.org/2000/svg';
const SLOTS = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8'];

export function seriesColor(i) {
  return `var(${SLOTS[i % SLOTS.length]})`;
}

/* ----------------------------- helpers ---------------------------- */

function svgEl(name, attrs = {}) {
  const el = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    el.setAttribute(k, String(v));
  }
  return el;
}

function niceScale(min, max, ticks = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, step: 1, values: [0, 1] };
  if (min === max) {
    const pad = Math.abs(min || 1) * 0.5 || 1;
    min -= pad;
    max += pad;
  }
  const range = max - min;
  const raw = range / Math.max(1, ticks - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(raw) || 1)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const values = [];
  for (let v = lo; v <= hi + step / 2; v += step) values.push(round(v, 10));
  return { min: lo, max: hi, step, values };
}

function round(n, p = 2) {
  const f = Math.pow(10, p);
  return Math.round(n * f) / f;
}

/** Bar path with rounded corners on the value end only. */
function barPath(x, y, w, hgt, r, dir = 'up') {
  const rad = Math.max(0, Math.min(r, w / 2, Math.abs(hgt)));
  if (Math.abs(hgt) < 0.6) return `M${x} ${y}h${w}`;
  if (dir === 'up') {
    return `M${x} ${y + hgt}V${y + rad}a${rad} ${rad} 0 0 1 ${rad} ${-rad}h${w - rad * 2}a${rad} ${rad} 0 0 1 ${rad} ${rad}V${y + hgt}Z`;
  }
  if (dir === 'down') {
    const b = y + hgt;
    return `M${x} ${y}V${b - rad}a${rad} ${rad} 0 0 0 ${rad} ${rad}h${w - rad * 2}a${rad} ${rad} 0 0 0 ${rad} ${-rad}V${y}Z`;
  }
  // horizontal, rounded on the right
  return `M${x} ${y}h${w - rad}a${rad} ${rad} 0 0 1 ${rad} ${rad}v${hgt - rad * 2}a${rad} ${rad} 0 0 1 ${-rad} ${rad}H${x}Z`;
}

function smoothPath(pts) {
  if (pts.length < 2) return pts.length ? `M${pts[0][0]} ${pts[0][1]}` : '';
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length; i += 1) d += `L${pts[i][0]} ${pts[i][1]}`;
  return d;
}

/* ----------------------------- tooltip ---------------------------- */

let tipEl = null;
function tooltip() {
  if (!tipEl) {
    tipEl = h('div.tip', { style: { display: 'none' } });
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

function showTip(x, y, content) {
  const el = tooltip();
  mount(el, content);
  el.style.display = 'block';
  const r = el.getBoundingClientRect();
  let left = x + 14;
  let top = y - r.height - 12;
  if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
  if (top < 8) top = y + 18;
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${Math.max(8, top)}px`;
}

export function hideTip() {
  if (tipEl) tipEl.style.display = 'none';
}

function tipBlock(title, rows) {
  return h(
    'div',
    null,
    title ? h('div.tip-title', null, title) : null,
    ...rows.map(([label, value, color]) =>
      h(
        'div.tip-row',
        null,
        h(
          'span.k',
          null,
          color ? h('span.swatch', { style: { background: color } }) : null,
          label
        ),
        h('span.v', null, value)
      )
    )
  );
}

/* --------------------------- responsive --------------------------- */

const observers = new WeakMap();

/** Render `draw(width)` into `container`, re-drawing when its width changes. */
export function responsive(container, draw) {
  const run = () => {
    const w = Math.max(220, container.clientWidth || 600);
    const node = draw(w);
    if (node) mount(container, node);
  };
  run();
  if (observers.has(container)) observers.get(container).disconnect();
  if (typeof ResizeObserver !== 'undefined') {
    let last = container.clientWidth;
    const ro = new ResizeObserver(() => {
      const w = container.clientWidth;
      if (Math.abs(w - last) > 6) {
        last = w;
        run();
      }
    });
    ro.observe(container);
    observers.set(container, ro);
  }
  return container;
}

/* ---------------------------- line chart -------------------------- */

/**
 * @param {object} o
 * @param {string[]} o.labels          x categories (usually ISO dates)
 * @param {{name:string,values:number[],color?:string,dashed?:boolean}[]} o.series
 */
export function lineChart(container, o = {}) {
  const opts = {
    height: 230,
    area: true,
    yFormat: (v) => String(v),
    xFormat: (v) => String(v),
    tipFormat: null,
    zeroLine: true,
    threshold: null,
    maxXLabels: 8,
    directLabels: true,
    ...o,
  };
  return responsive(container, (width) => draw(width, opts));

  function draw(width, c) {
    const series = (c.series || []).filter((s) => s && s.values && s.values.length);
    const labels = c.labels || [];
    const showDirect = c.directLabels && series.length <= 4 && series.length > 1;
    const longest = showDirect ? Math.max(...series.map((s) => String(s.name).length)) : 0;
    const padL = 58;
    const padR = showDirect ? Math.min(140, Math.max(72, longest * 6.4 + 18)) : 18;
    const padT = 12;
    const padB = 28;
    const height = c.height;
    const iw = Math.max(40, width - padL - padR);
    const ih = Math.max(40, height - padT - padB);

    const all = series.flatMap((s) => s.values).filter(Number.isFinite);
    let lo = Math.min(...all, c.threshold ? c.threshold.value : Infinity);
    let hi = Math.max(...all, c.threshold ? c.threshold.value : -Infinity);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = 0;
      hi = 1;
    }
    if (c.zeroLine) {
      lo = Math.min(lo, 0);
      hi = Math.max(hi, 0);
    }
    const scale = niceScale(lo, hi, 5);
    const n = Math.max(1, labels.length - 1);
    const X = (i) => padL + (i / n) * iw;
    const Y = (v) => padT + ih - ((v - scale.min) / (scale.max - scale.min || 1)) * ih;

    const svg = svgEl('svg', {
      viewBox: `0 0 ${width} ${height}`,
      width,
      height,
      role: 'img',
      'aria-label': c.ariaLabel || 'Line chart',
    });

    // gradients for area fills
    const defs = svgEl('defs');
    series.forEach((s, i) => {
      const id = `ffgrad${i}-${Math.random().toString(36).slice(2, 7)}`;
      s._gradId = id;
      const g = svgEl('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 });
      const c1 = svgEl('stop', { offset: '0%', 'stop-color': s.color || seriesColor(i), 'stop-opacity': 0.26 });
      const c2 = svgEl('stop', { offset: '100%', 'stop-color': s.color || seriesColor(i), 'stop-opacity': 0.01 });
      g.append(c1, c2);
      defs.appendChild(g);
    });
    svg.appendChild(defs);

    // grid + y labels
    const grid = svgEl('g', { class: 'chart-grid' });
    const axis = svgEl('g', { class: 'chart-axis' });
    for (const v of scale.values) {
      const y = Y(v);
      grid.appendChild(svgEl('line', { x1: padL, x2: padL + iw, y1: y, y2: y }));
      const t = svgEl('text', { x: padL - 9, y: y + 3.5, 'text-anchor': 'end' });
      t.textContent = c.yFormat(v);
      axis.appendChild(t);
    }
    svg.append(grid, axis);

    // x labels, thinned to whatever actually fits the plot width
    const maxLabels = Math.max(2, Math.min(c.maxXLabels, Math.floor(iw / 62)));
    const stride = Math.max(1, Math.ceil(labels.length / maxLabels));
    const xAxis = svgEl('g', { class: 'chart-axis' });
    labels.forEach((lab, i) => {
      if (i % stride !== 0 && i !== labels.length - 1) return;
      const t = svgEl('text', { x: X(i), y: padT + ih + 17, 'text-anchor': 'middle' });
      t.textContent = c.xFormat(lab, i);
      xAxis.appendChild(t);
    });
    svg.appendChild(xAxis);

    // zero baseline
    if (scale.min < 0 && scale.max > 0) {
      svg.appendChild(
        svgEl('line', { class: 'chart-baseline', x1: padL, x2: padL + iw, y1: Y(0), y2: Y(0) })
      );
    }

    // threshold marker (e.g. low-balance line)
    if (c.threshold) {
      const y = Y(c.threshold.value);
      svg.appendChild(
        svgEl('line', {
          x1: padL, x2: padL + iw, y1: y, y2: y,
          stroke: 'var(--st-critical)', 'stroke-width': 1.5, 'stroke-dasharray': '5 4', opacity: 0.85,
        })
      );
      if (c.threshold.label) {
        const t = svgEl('text', {
          x: padL + 4, y: y - 5, class: 'chart-label', fill: 'var(--st-critical)',
        });
        t.textContent = c.threshold.label;
        svg.appendChild(t);
      }
    }

    // series
    const endpoints = [];
    series.forEach((s, i) => {
      const color = s.color || seriesColor(i);
      const pts = s.values.map((v, j) => [X(j), Y(Number(v) || 0)]);
      if (c.area && series.length <= 2) {
        const base = Y(Math.max(scale.min, 0));
        const d = `${smoothPath(pts)}L${pts[pts.length - 1][0]} ${base}L${pts[0][0]} ${base}Z`;
        svg.appendChild(svgEl('path', { d, fill: `url(#${s._gradId})`, stroke: 'none' }));
      }
      svg.appendChild(
        svgEl('path', {
          d: smoothPath(pts),
          fill: 'none',
          stroke: color,
          'stroke-width': 2,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
          'stroke-dasharray': s.dashed ? '6 5' : null,
        })
      );
      const last = pts[pts.length - 1];
      if (last) {
        svg.appendChild(
          svgEl('circle', { cx: last[0], cy: last[1], r: 4, fill: color, stroke: 'var(--chart-surface)', 'stroke-width': 2 })
        );
        endpoints.push({ x: last[0], y: last[1], name: s.name, color });
      }
    });

    // Direct labels at the line ends, nudged apart so two series that finish at
    // the same value do not print on top of each other.
    if (showDirect && endpoints.length) {
      const gap = 14;
      const sorted = [...endpoints].sort((a, b) => a.y - b.y);
      for (let i = 1; i < sorted.length; i += 1) {
        if (sorted[i].y - sorted[i - 1].y < gap) sorted[i].y = sorted[i - 1].y + gap;
      }
      const overflow = sorted.length ? sorted[sorted.length - 1].y - (padT + ih) : 0;
      if (overflow > 0) for (const p of sorted) p.y -= overflow;
      const maxChars = Math.max(4, Math.floor((padR - 14) / 6.4));
      for (const p of sorted) {
        const t = svgEl('text', {
          x: p.x + 9,
          y: Math.max(padT + 6, p.y + 4),
          class: 'chart-label',
          fill: p.color,
        });
        t.textContent = truncate(p.name, maxChars);
        svg.appendChild(t);
      }
    }

    // crosshair + hover
    const cross = svgEl('g', { class: 'chart-crosshair', opacity: 0 });
    const vline = svgEl('line', { y1: padT, y2: padT + ih, stroke: 'var(--axis)', 'stroke-width': 1 });
    cross.appendChild(vline);
    const dots = series.map((s, i) =>
      svgEl('circle', {
        r: 4.5,
        fill: s.color || seriesColor(i),
        stroke: 'var(--chart-surface)',
        'stroke-width': 2,
      })
    );
    dots.forEach((d) => cross.appendChild(d));
    svg.appendChild(cross);

    const hit = svgEl('rect', { class: 'chart-hit', x: padL, y: padT, width: iw, height: ih });
    svg.appendChild(hit);

    hit.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      const relX = ((e.clientX - rect.left) / rect.width) * width;
      let idx = Math.round(((relX - padL) / iw) * n);
      idx = Math.max(0, Math.min(labels.length - 1, idx));
      const x = X(idx);
      vline.setAttribute('x1', x);
      vline.setAttribute('x2', x);
      dots.forEach((d, i) => {
        const v = Number(series[i].values[idx]);
        if (!Number.isFinite(v)) {
          d.setAttribute('opacity', 0);
          return;
        }
        d.setAttribute('opacity', 1);
        d.setAttribute('cx', x);
        d.setAttribute('cy', Y(v));
      });
      cross.setAttribute('opacity', 1);
      const rows = series.map((s, i) => [
        s.name,
        (c.tipFormat || c.yFormat)(s.values[idx]),
        s.color || seriesColor(i),
      ]);
      showTip(e.clientX, e.clientY, tipBlock(c.xFormat(labels[idx], idx, true), rows));
    });
    hit.addEventListener('mouseleave', () => {
      cross.setAttribute('opacity', 0);
      hideTip();
    });

    return wrap(svg, c, () => tableFor(labels, series, c));
  }
}

/* ---------------------------- bar chart --------------------------- */

/**
 * Vertical bars — grouped or stacked. Negative values drop below the baseline.
 */
export function barChart(container, o = {}) {
  const opts = {
    height: 230,
    stacked: false,
    yFormat: (v) => String(v),
    xFormat: (v) => String(v),
    maxXLabels: 12,
    ...o,
  };
  return responsive(container, (width) => draw(width, opts));

  function draw(width, c) {
    const labels = c.labels || [];
    const series = (c.series || []).filter(Boolean);
    const padL = 58;
    const padR = 14;
    const padT = 12;
    const padB = 28;
    const height = c.height;
    const iw = Math.max(40, width - padL - padR);
    const ih = Math.max(40, height - padT - padB);

    let lo = 0;
    let hi = 0;
    if (c.stacked) {
      labels.forEach((_, i) => {
        let pos = 0;
        let neg = 0;
        series.forEach((s) => {
          const v = Number(s.values[i]) || 0;
          if (v >= 0) pos += v;
          else neg += v;
        });
        hi = Math.max(hi, pos);
        lo = Math.min(lo, neg);
      });
    } else {
      const all = series.flatMap((s) => s.values.map(Number)).filter(Number.isFinite);
      hi = Math.max(0, ...all);
      lo = Math.min(0, ...all);
    }
    const scale = niceScale(lo, hi, 5);
    const Y = (v) => padT + ih - ((v - scale.min) / (scale.max - scale.min || 1)) * ih;
    const band = iw / Math.max(1, labels.length);
    const groupW = band * 0.68;
    const barW = c.stacked ? groupW : groupW / Math.max(1, series.length);

    const svg = svgEl('svg', {
      viewBox: `0 0 ${width} ${height}`, width, height,
      role: 'img', 'aria-label': c.ariaLabel || 'Bar chart',
    });

    const grid = svgEl('g', { class: 'chart-grid' });
    const axis = svgEl('g', { class: 'chart-axis' });
    for (const v of scale.values) {
      const y = Y(v);
      grid.appendChild(svgEl('line', { x1: padL, x2: padL + iw, y1: y, y2: y }));
      const t = svgEl('text', { x: padL - 9, y: y + 3.5, 'text-anchor': 'end' });
      t.textContent = c.yFormat(v);
      axis.appendChild(t);
    }
    svg.append(grid, axis);

    const zeroY = Y(0);
    svg.appendChild(svgEl('line', { class: 'chart-baseline', x1: padL, x2: padL + iw, y1: zeroY, y2: zeroY }));

    const maxLabels = Math.max(2, Math.min(c.maxXLabels, Math.floor(iw / 44)));
    const stride = Math.max(1, Math.ceil(labels.length / maxLabels));
    const xAxis = svgEl('g', { class: 'chart-axis' });
    labels.forEach((lab, i) => {
      if (i % stride !== 0) return;
      const t = svgEl('text', { x: padL + band * i + band / 2, y: padT + ih + 17, 'text-anchor': 'middle' });
      t.textContent = c.xFormat(lab, i);
      xAxis.appendChild(t);
    });
    svg.appendChild(xAxis);

    labels.forEach((lab, i) => {
      const x0 = padL + band * i + (band - groupW) / 2;
      let posTop = 0;
      let negBottom = 0;
      series.forEach((s, si) => {
        const v = Number(s.values[i]) || 0;
        const color = s.color || seriesColor(si);
        let x;
        let y;
        let hgt;
        if (c.stacked) {
          x = x0;
          if (v >= 0) {
            const top = posTop + v;
            y = Y(top);
            hgt = Y(posTop) - Y(top);
            posTop = top;
          } else {
            const bottom = negBottom + v;
            y = Y(negBottom);
            hgt = Y(bottom) - Y(negBottom);
            negBottom = bottom;
          }
          // 2px surface gap between stacked segments
          if (hgt > 3) hgt -= 2;
        } else {
          x = x0 + barW * si;
          const y0 = Y(0);
          const y1 = Y(v);
          y = Math.min(y0, y1);
          hgt = Math.abs(y1 - y0);
        }
        if (hgt <= 0) return;
        const w = Math.max(2, barW - (c.stacked ? 0 : 2));
        const d = barPath(x + 1, y, w, hgt, 4, v >= 0 ? 'up' : 'down');
        const rect = svgEl('path', { d, fill: color });
        rect.addEventListener('mousemove', (e) => {
          showTip(e.clientX, e.clientY, tipBlock(c.xFormat(lab, i, true), [[s.name, c.yFormat(v), color]]));
        });
        rect.addEventListener('mouseleave', hideTip);
        svg.appendChild(rect);
      });
    });

    return wrap(svg, c, () => tableFor(labels, series, c));
  }
}

/* ------------------------ horizontal bars ------------------------- */

/**
 * Ranked horizontal bars — the right form for "which categories cost most".
 * Every row is directly labelled, so identity never rests on hue.
 */
export function rankedBars(container, o = {}) {
  const opts = {
    rowHeight: 30,
    valueFormat: (v) => String(v),
    max: null,
    monochrome: true,
    ...o,
  };
  return responsive(container, (width) => draw(width, opts));

  function draw(width, c) {
    const items = c.items || [];
    if (!items.length) return h('div.empty', null, h('div.empty-msg', null, 'No data for this period'));
    const labelW = Math.min(190, Math.max(110, Math.round(width * 0.3)));
    const valueW = 92;
    const padR = 6;
    const trackW = Math.max(30, width - labelW - valueW - padR);
    const height = items.length * c.rowHeight + 6;
    const max = c.max || Math.max(...items.map((i) => Math.abs(i.value) || 0), 1);

    const svg = svgEl('svg', {
      viewBox: `0 0 ${width} ${height}`, width, height,
      role: 'img', 'aria-label': c.ariaLabel || 'Ranked bar chart',
    });

    items.forEach((item, i) => {
      const y = i * c.rowHeight + 3;
      const barH = Math.min(15, c.rowHeight - 12);
      const w = Math.max(2, (Math.abs(item.value) / max) * trackW);
      const color = item.color || (c.monochrome ? 'var(--s1)' : seriesColor(i));

      const label = svgEl('text', {
        x: 0, y: y + barH / 2 + 4.5, class: 'chart-label', fill: 'var(--text-2)',
      });
      label.textContent = truncate(item.label, Math.floor(labelW / 6.6));
      svg.appendChild(label);

      svg.appendChild(
        svgEl('rect', {
          x: labelW, y, width: trackW, height: barH, rx: 4, fill: 'var(--surface-3)',
        })
      );
      const bar = svgEl('path', {
        d: barPath(labelW, y, w, barH, 4, 'right'),
        fill: color,
      });
      bar.addEventListener('mousemove', (e) => {
        showTip(e.clientX, e.clientY, tipBlock(item.label, [
          ['Amount', c.valueFormat(item.value), color],
          ...(item.sub ? [['Share', item.sub]] : []),
        ]));
      });
      bar.addEventListener('mouseleave', hideTip);
      svg.appendChild(bar);

      const val = svgEl('text', {
        x: width - padR, y: y + barH / 2 + 4.5, 'text-anchor': 'end', class: 'chart-value',
      });
      val.textContent = c.valueFormat(item.value);
      svg.appendChild(val);

      // The whole row is the target, not the drawn bar — a short bar would
      // otherwise be a pixel-hunt. Added last so it sits above everything.
      if (c.onSelect) {
        const hit = svgEl('rect', {
          x: 0, y: i * c.rowHeight, width, height: c.rowHeight, fill: 'transparent',
          style: 'cursor:pointer', role: 'button', tabindex: '0',
          'aria-label': `${item.label}: ${c.valueFormat(item.value)}`,
        });
        hit.addEventListener('click', () => c.onSelect(item, i));
        hit.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            c.onSelect(item, i);
          }
        });
        hit.addEventListener('mousemove', (e) => {
          showTip(e.clientX, e.clientY, tipBlock(item.label, [
            ['Amount', c.valueFormat(item.value), color],
            ...(item.sub ? [['Share', item.sub]] : []),
          ]));
        });
        hit.addEventListener('mouseleave', hideTip);
        svg.appendChild(hit);
      }
    });

    return svg;
  }
}

function truncate(s, n) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, Math.max(1, n - 1))}…` : str;
}

/* ---------------------------- sparkline --------------------------- */

export function sparkline(values, { width = 110, height = 30, color = 'var(--s1)', fill = true } = {}) {
  const vals = (values || []).map(Number).filter(Number.isFinite);
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width, height, 'aria-hidden': 'true' });
  if (vals.length < 2) return svg;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const pts = vals.map((v, i) => [
    (i / (vals.length - 1)) * (width - 2) + 1,
    height - 2 - ((v - lo) / span) * (height - 4),
  ]);
  if (fill) {
    svg.appendChild(
      svgEl('path', {
        d: `${smoothPath(pts)}L${pts[pts.length - 1][0]} ${height}L${pts[0][0]} ${height}Z`,
        fill: color,
        opacity: 0.14,
      })
    );
  }
  svg.appendChild(
    svgEl('path', {
      d: smoothPath(pts), fill: 'none', stroke: color,
      'stroke-width': 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    })
  );
  return svg;
}

/* --------------------------- donut meter -------------------------- */

/** Single-value arc — a gauge, not a pie. Used for utilisation and goals. */
export function arcMeter({ value, max = 100, size = 108, thickness = 10, color = 'var(--s1)', label, sub }) {
  const pct = Math.max(0, Math.min(1, max ? value / max : 0));
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const svg = svgEl('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, 'aria-hidden': 'true' });
  const g = svgEl('g', { transform: `rotate(-90 ${size / 2} ${size / 2})` });
  g.appendChild(
    svgEl('circle', {
      cx: size / 2, cy: size / 2, r, fill: 'none',
      stroke: 'var(--surface-3)', 'stroke-width': thickness,
    })
  );
  g.appendChild(
    svgEl('circle', {
      cx: size / 2, cy: size / 2, r, fill: 'none', stroke: color,
      'stroke-width': thickness, 'stroke-linecap': 'round',
      'stroke-dasharray': `${c * pct} ${c}`,
    })
  );
  svg.appendChild(g);
  if (label) {
    const t = svgEl('text', {
      x: size / 2, y: size / 2 + (sub ? 0 : 5), 'text-anchor': 'middle',
      fill: 'var(--text)', 'font-size': 18, 'font-weight': 650,
    });
    t.textContent = label;
    svg.appendChild(t);
  }
  if (sub) {
    const t = svgEl('text', {
      x: size / 2, y: size / 2 + 16, 'text-anchor': 'middle',
      fill: 'var(--text-3)', 'font-size': 11,
    });
    t.textContent = sub;
    svg.appendChild(t);
  }
  return svg;
}

/* --------------------------- chrome ------------------------------- */

function wrap(svg, c, tableFn) {
  const parts = [svg];
  const series = (c.series || []).filter(Boolean);
  if (series.length > 1) {
    parts.push(
      h(
        'div.legend.mt-8',
        null,
        ...series.map((s, i) =>
          h(
            'span.item',
            null,
            h('span.swatch', { style: { background: s.color || seriesColor(i) } }),
            s.name
          )
        )
      )
    );
  }
  if (c.tableView !== false && tableFn) {
    const box = h('div.hidden.mt-12');
    const toggle = h(
      'button.linkbtn.tiny.mt-8',
      {
        type: 'button',
        onclick: () => {
          const showing = !box.classList.contains('hidden');
          box.classList.toggle('hidden', showing);
          if (!showing && !box.childElementCount) mount(box, tableFn());
          toggle.textContent = showing ? 'Show data table' : 'Hide data table';
        },
      },
      'Show data table'
    );
    parts.push(h('div', null, toggle, box));
  }
  return h('div', null, ...parts);
}

function tableFor(labels, series, c) {
  const fmt = c.yFormat || ((v) => String(v));
  return h(
    'div.scrollbox',
    null,
    h(
      'table.table',
      null,
      h(
        'thead',
        null,
        h('tr', null, h('th', null, ''), ...series.map((s) => h('th.num', null, s.name)))
      ),
      h(
        'tbody',
        null,
        ...labels.map((lab, i) =>
          h(
            'tr',
            null,
            h('td', null, c.xFormat ? c.xFormat(lab, i, true) : lab),
            ...series.map((s) => h('td.num', null, fmt(s.values[i])))
          )
        )
      )
    )
  );
}
