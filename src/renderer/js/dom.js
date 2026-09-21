/**
 * Tiny DOM builder. `h(tag, props, ...children)` returns a real element, so
 * views compose plain functions instead of a framework.
 *
 *   h('button.btn.primary', { onclick: save }, icon('save'), 'Save')
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
// Properties that exist on the element but are read-only, so they must be set
// as attributes (`input.list` is the classic trap).
const ATTRIBUTE_ONLY = new Set(['list', 'form', 'type']);

const SVG_TAGS = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'line', 'polyline', 'polygon', 'text',
  'tspan', 'defs', 'linearGradient', 'stop', 'clipPath', 'ellipse', 'use', 'title',
]);

export function h(spec, props, ...children) {
  const [tag, ...rest] = String(spec).split(/(?=[.#])/);
  const name = tag || 'div';
  const el = SVG_TAGS.has(name)
    ? document.createElementNS(SVG_NS, name)
    : document.createElement(name);

  for (const token of rest) {
    const name_ = token.slice(1);
    if (!name_) continue; // tolerate `div.${maybeEmpty}`
    if (token.startsWith('.')) el.classList.add(name_);
    else if (token.startsWith('#')) el.id = name_;
  }

  if (props) applyProps(el, props);
  append(el, children);
  return el;
}

function applyProps(el, props) {
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class' || key === 'className') {
      for (const c of String(value).split(/\s+/).filter(Boolean)) el.classList.add(c);
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(el.style, value);
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (key === 'html') {
      el.innerHTML = value;
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'ref' && typeof value === 'function') {
      value(el);
    } else if (
      el instanceof SVGElement ||
      key.includes('-') ||
      key.startsWith('aria') ||
      key === 'role' ||
      ATTRIBUTE_ONLY.has(key)
    ) {
      el.setAttribute(key, value === true ? '' : String(value));
    } else if (key in el) {
      try {
        el[key] = value;
      } catch {
        el.setAttribute(key, value === true ? '' : String(value));
      }
    } else {
      el.setAttribute(key, String(value));
    }
  }
}

function append(el, children) {
  for (const child of children.flat(8)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Replace all children of `el` with `nodes`. */
export function mount(el, ...nodes) {
  el.replaceChildren();
  append(el, nodes);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function on(el, event, handler, opts) {
  el.addEventListener(event, handler, opts);
  return () => el.removeEventListener(event, handler, opts);
}

/** Delegated listener: fires when the event target matches `selector`. */
export function delegate(root, event, selector, handler) {
  return on(root, event, (e) => {
    const match = e.target.closest(selector);
    if (match && root.contains(match)) handler(e, match);
  });
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

export function frag(...children) {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}
