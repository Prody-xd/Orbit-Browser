/**
 * Helpers de DOM.
 *
 * El chrome se construye sin framework: son unos pocos cientos de nodos y
 * cambian poco. Una dependencia de UI aqui costaria arranque y memoria en el
 * mismo proceso que debe sentirse instantaneo.
 */

/**
 * @param {string} tag etiqueta, opcionalmente con clases: "div.tab.active"
 * @param {object} [props] atributos, `class`, `text`, `html`, `on` y `style`
 * @param {Array<Node|string|null|undefined>} [children]
 */
export function h(tag, props = {}, children = []) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');

  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = [el.className, value].filter(Boolean).join(' ');
    else if (key === 'text') el.textContent = String(value);
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'style') Object.assign(el.style, value);
    else if (key === 'on') for (const [event, fn] of Object.entries(value)) el.addEventListener(event, fn);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key in el && typeof el[key] !== 'object') el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }

  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export const $ = (selector, root = document) => root.querySelector(selector);

export function clear(node) {
  node.replaceChildren();
  return node;
}

/** Fila de ajuste: etiqueta + descripcion + control. */
export function row(label, description, control, value) {
  return h('div.row', {}, [
    h('div.row-label', {}, [label, description ? h('small', { text: description }) : null]),
    value != null ? h('div.row-value', { text: value }) : null,
    control,
  ]);
}

/** Interruptor on/off. */
export function toggle(value, onChange) {
  return h('button', {
    class: `switch${value ? ' on' : ''}`,
    on: { click: () => onChange(!value) },
  });
}

/** Deslizador con lectura numerica. */
export function slider({ min, max, step = 1, value, onChange }) {
  return h('input', {
    type: 'range',
    min,
    max,
    step,
    value,
    on: {
      input: (event) => onChange(Number(event.target.value)),
    },
  });
}

export function select(options, value, onChange) {
  return h(
    'select',
    { on: { change: (event) => onChange(event.target.value) } },
    options.map(([id, label]) => h('option', { value: id, text: label, selected: id === value })),
  );
}

/** Limita la frecuencia de una funcion a un frame. */
export function raf(fn) {
  let queued = false;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...lastArgs);
    });
  };
}

export function formatMB(mb) {
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${Math.round(mb)} MB`;
}
