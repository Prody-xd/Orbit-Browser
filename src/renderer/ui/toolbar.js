import { $ } from './dom.js';
import { icons } from './icons.js';

/**
 * Barra de navegacion: atras/adelante/recargar, barra de direcciones y el
 * contador de pestanas vivas.
 *
 * El contador se alimenta del propio estado de pestanas, que ya llega por otros
 * motivos. No consulta metricas del sistema: eso solo ocurre con el panel
 * abierto, para que ver el consumo no sea en si mismo un consumo.
 */
export function createToolbar({ onOpenPanel, onClosePanel }) {
  const back = $('#nav-back');
  const forward = $('#nav-forward');
  const reload = $('#nav-reload');
  const omnibox = $('#omnibox');
  const scheme = $('#omnibox-scheme');
  const stats = $('#tab-stats');
  const netBtn = $('#btn-network');
  const netIcon = $('#net-icon');
  const netCount = $('#net-count');
  const sleepOthers = $('#btn-sleep-others');
  const panelButton = $('#btn-panel');
  const panelClose = $('#btn-panel-close');
  const newTab = $('#btn-new-tab');
  const pageError = $('#page-error');

  back.innerHTML = icons.back;
  forward.innerHTML = icons.forward;
  reload.innerHTML = icons.reload;
  sleepOthers.innerHTML = icons.moon;
  panelButton.innerHTML = icons.settings;
  if (panelClose) panelClose.innerHTML = icons.close;
  newTab.innerHTML = icons.plus;
  if (netIcon) netIcon.innerHTML = icons.fetch;

  let active = null;
  let editing = false;

  back.addEventListener('click', () => active && window.orbit.tabs.back(active.id));
  forward.addEventListener('click', () => active && window.orbit.tabs.forward(active.id));
  reload.addEventListener('click', () => {
    if (!active) return;
    if (active.loading) window.orbit.tabs.stop(active.id);
    else window.orbit.tabs.reload(active.id);
  });
  newTab.addEventListener('click', () => window.orbit.tabs.create(null, { active: true }));
  sleepOthers.addEventListener('click', () => window.orbit.tabs.sleepOthers());
  netBtn?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const box = netBtn.getBoundingClientRect();
    window.orbit.network.menu({ x: box.right, y: box.bottom + 6 });
  });
  panelButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    onOpenPanel();
  });
  panelClose?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    onClosePanel?.();
  });

  omnibox.addEventListener('focus', () => {
    editing = true;
    omnibox.select();
  });

  omnibox.addEventListener('blur', () => {
    editing = false;
    if (active) writeUrl(active.url);
  });

  omnibox.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      if (!active) return;
      window.orbit.tabs.navigate(active.id, omnibox.value);
      omnibox.blur();
    } else if (event.key === 'Escape') {
      if (active) writeUrl(active.url);
      omnibox.blur();
    }
  });

  function writeUrl(url) {
    const value = String(url ?? '');
    // Las paginas internas se muestran tal cual; el resto pierde el esquema
    // para que la barra sea legible, y el esquema se indica al lado.
    if (value.startsWith('orbit://')) {
      scheme.textContent = 'orbit';
      scheme.className = 'omnibox-scheme';
      omnibox.value = value.replace('orbit://', '');
      return;
    }
    try {
      const parsed = new URL(value);
      const secure = parsed.protocol === 'https:';
      scheme.textContent = secure ? 'https' : parsed.protocol.replace(':', '');
      scheme.className = `omnibox-scheme${secure ? '' : ' insecure'}`;
      omnibox.value = value.replace(/^https?:\/\//, '');
    } catch {
      scheme.textContent = '';
      scheme.className = 'omnibox-scheme';
      omnibox.value = value;
    }
  }

  function render(snapshot) {
    active = snapshot.tabs.find((t) => t.id === snapshot.activeId) ?? null;

    back.disabled = !active?.canGoBack;
    forward.disabled = !active?.canGoForward;
    reload.innerHTML = active?.loading ? icons.stop : icons.reload;
    reload.title = active?.loading ? 'Detener' : 'Recargar (Ctrl+R)';
    back.title = 'Atrás (Alt+Izquierda)';
    forward.title = 'Adelante (Alt+Derecha)';

    if (active && !editing) writeUrl(active.url);

    const live = snapshot.tabs.filter((t) => t.live).length;
    const asleep = snapshot.tabs.filter((t) => t.sleeping).length;
    stats.innerHTML = `<b>${live}</b> ${live === 1 ? 'viva' : 'vivas'}${
      asleep ? ` · <span class="zz">${asleep} z</span>` : ''
    }`;
    stats.title = `${live} ${live === 1 ? 'pestaña' : 'pestañas'} con proceso vivo, ${asleep} ${
      asleep === 1 ? 'dormida' : 'dormidas'
    }, ${snapshot.tabs.length} en total`;
    sleepOthers.disabled = live <= 1;

    if (active?.error) {
      pageError.hidden = false;
      pageError.textContent = `No se pudo cargar la página: ${active.error.description} (${active.error.code})`;
    } else {
      pageError.hidden = true;
    }
  }

  function renderNetwork(snapshot) {
    if (!netBtn || !netCount) return;
    const count = Number(snapshot?.count) || 0;
    netCount.textContent = formatNetCount(count);
    netBtn.classList.toggle('has-traffic', count > 0);
    netBtn.title =
      count === 0
        ? 'Solicitudes fetch de esta pestaña'
        : `${count} ${count === 1 ? 'solicitud fetch' : 'solicitudes fetch'} · clic para ver endpoints`;
  }

  return { render, renderNetwork, focusOmnibox: () => omnibox.focus(), getActive: () => active };
}

function formatNetCount(n) {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(n / 1000)}k`;
}
