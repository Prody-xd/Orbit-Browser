import { h, raf, $ } from './dom.js';
import { icons } from './icons.js';

/**
 * Puente entre el layout CSS y la vista nativa de la pagina.
 *
 * La pagina no es un elemento del DOM: es una vista de Chromium que el proceso
 * principal coloca con coordenadas absolutas. Para no duplicar el layout en dos
 * sitios, aqui medimos el hueco `#page-slot` y le mandamos su rectangulo. Asi
 * el CSS sigue siendo la unica fuente de verdad del diseno, y basta con mover
 * un div para que la pagina lo siga.
 */
export function startLayoutSync(slot) {
  let last = '';

  const push = raf(() => {
    const rect = slot.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;

    const radius = Number.parseFloat(getComputedStyle(slot).borderRadius) || 0;
    const payload = {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };

    // Evitamos IPC redundante: durante un arrastre de ventana el observer
    // dispara muchas veces con el mismo tamano.
    const key = `${payload.x},${payload.y},${payload.width},${payload.height},${radius}`;
    if (key === last) return;
    last = key;

    window.orbit.layout.setPageBounds(payload, radius);
  });

  new ResizeObserver(push).observe(slot);
  window.addEventListener('resize', push);
  // Un empujon inicial y otro tras el primer paint, por si las fuentes o el
  // tema cambian las medidas.
  push();
  requestAnimationFrame(push);

  return push;
}

/** Zonas de agarre para redimensionar la ventana sin marco nativo. */
export function mountResizers(container) {
  const edges = ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se'];
  container.replaceChildren(
    ...edges.map((edge) =>
      h(`div.rz.rz-${edge}`, {
        on: {
          pointerdown: (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            window.orbit.window.resizeStart(edge);
          },
        },
      }),
    ),
  );

  // El arrastre lo sigue el proceso principal leyendo el cursor, asi que solo
  // hace falta avisar cuando se suelta, en cualquier parte de la ventana.
  for (const event of ['pointerup', 'pointercancel', 'blur']) {
    window.addEventListener(event, () => window.orbit.window.resizeEnd());
  }
}

/** Botones de minimizar / maximizar / cerrar. */
export function mountWindowControls(root) {
  const buttons = root.querySelectorAll('.win-btn');
  for (const button of buttons) {
    const action = button.dataset.win;
    button.innerHTML = action === 'min' ? icons.min : action === 'max' ? icons.max : icons.winclose;
    button.addEventListener('click', () => {
      if (action === 'min') window.orbit.window.minimize();
      else if (action === 'max') window.orbit.window.toggleMaximize();
      else window.orbit.window.close();
    });
  }

  return function applyState(state) {
    document.body.classList.toggle('maximized', Boolean(state.maximized));
    document.body.classList.toggle('blurred', state.focused === false);
    const maxButton = root.querySelector('.win-btn[data-win="max"]');
    if (maxButton) maxButton.innerHTML = state.maximized ? icons.restore : icons.max;
  };
}

/** Doble clic en la barra de titulo: maximizar/restaurar, como en Windows. */
export function enableTitlebarDoubleClick(...roots) {
  for (const root of roots) {
    if (!root) continue;
    root.addEventListener('dblclick', (event) => {
      if (event.target.closest('.tab, .icon-btn, .win-btn, input, .omnibox, .tab-rail-split, .net-btn, .tab-stats')) return;
      window.orbit.window.toggleMaximize();
    });
  }
}

const TAB_RAIL_DEFAULT = 214;
const TAB_RAIL_MIN = 52;
const TAB_RAIL_MAX = 420;
/** Por debajo, solo se ve el favicon. */
const TAB_RAIL_COMPACT = 76;

export function clampTabRailWidth(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return TAB_RAIL_DEFAULT;
  const max = Math.min(TAB_RAIL_MAX, Math.max(TAB_RAIL_MIN, window.innerWidth - 380));
  return Math.round(Math.min(max, Math.max(TAB_RAIL_MIN, n)));
}

export function applyTabRailWidth(width) {
  const px = clampTabRailWidth(width);
  document.documentElement.style.setProperty('--tab-rail', `${px}px`);
  const side = document.body.classList.contains('tabs-side');
  document.body.classList.toggle('tabs-compact', side && px <= TAB_RAIL_COMPACT);
  return px;
}

/**
 * Coloca la lista de pestanas arriba o a un lado.
 *
 * Arriba: la fila clasica de pestanas, y debajo la barra de direcciones.
 * A los lados: esa fila desaparece; arriba solo quedan atras/adelante, la URL
 * y los botones de ventana. Las pestanas bajan a un rail vertical.
 */
export function applyTabStripPosition(position, width) {
  const pos = ['top', 'left', 'right'].includes(position) ? position : 'top';
  const side = pos !== 'top';

  document.body.dataset.tabs = pos;
  document.body.classList.toggle('tabs-side', side);
  document.body.classList.toggle('tabs-right', pos === 'right');
  applyTabRailWidth(width);

  const strip = $('#tabstrip');
  const add = $('#btn-new-tab');
  const win = $('#wincontrols');
  const top = $('#tabs-host-top');
  const rail = $('#tabs-host-side');
  const titlebar = $('#titlebar');
  const toolbar = $('#toolbar');
  const split = $('#tab-rail-split');
  const railDrag = $('#tab-rail-drag');
  const toolbarDrag = $('#toolbar-drag');

  if (!strip || !add || !win || !top || !rail || !titlebar || !toolbar) return;

  if (side) {
    rail.append(strip);
    if (railDrag) rail.append(railDrag);
    rail.append(add);
    if (split) rail.append(split);
    toolbar.append(win);
    titlebar.hidden = true;
    rail.hidden = false;
    if (toolbarDrag) toolbarDrag.hidden = false;
  } else {
    top.append(strip, add);
    titlebar.append(win);
    titlebar.hidden = false;
    rail.hidden = true;
    if (toolbarDrag) toolbarDrag.hidden = true;
  }
}

/**
 * Borde interior del rail: arrastrar cambia cuanto espacio queda para la pagina.
 *
 * La pagina es una vista nativa encima del HTML, asi que mientras se arrastra
 * le pedimos que ignore el raton; si no, el cursor se lo come al cruzar.
 */
export function mountTabRailResize({ onLive, onCommit }) {
  const handle = $('#tab-rail-split');
  const rail = $('#tabs-host-side');
  if (!handle || !rail) return;

  let dragging = false;
  let startX = 0;
  let startW = 0;

  const finish = (event) => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('resizing-tabs');
    window.orbit.layout.ignorePageMouse(false);
    if (event) {
      try {
        handle.releasePointerCapture(event.pointerId);
      } catch {
        /* captura ya suelta */
      }
    }
    onCommit?.(clampTabRailWidth(rail.getBoundingClientRect().width));
  };

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (!document.body.classList.contains('tabs-side')) return;
    event.preventDefault();
    dragging = true;
    startX = event.clientX;
    startW = rail.getBoundingClientRect().width;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-tabs');
    window.orbit.layout.ignorePageMouse(true);
  });

  handle.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const right = document.body.classList.contains('tabs-right');
    const delta = event.clientX - startX;
    const next = applyTabRailWidth(startW + (right ? -delta : delta));
    onLive?.(next);
  });

  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
  window.addEventListener('blur', () => finish());

  handle.addEventListener('dblclick', (event) => {
    event.preventDefault();
    const current = clampTabRailWidth(rail.getBoundingClientRect().width);
    const next = applyTabRailWidth(current <= TAB_RAIL_COMPACT ? TAB_RAIL_DEFAULT : TAB_RAIL_MIN);
    onLive?.(next);
    onCommit?.(next);
  });
}
