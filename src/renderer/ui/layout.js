import { h, raf } from './dom.js';
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
export function enableTitlebarDoubleClick(titlebar) {
  titlebar.addEventListener('dblclick', (event) => {
    if (event.target.closest('.tab, .icon-btn, .win-btn')) return;
    window.orbit.window.toggleMaximize();
  });
}
