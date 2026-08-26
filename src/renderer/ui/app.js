import { $ } from './dom.js';
import { applyTheme } from './theme.js';
import { startLayoutSync, mountResizers, mountWindowControls, enableTitlebarDoubleClick } from './layout.js';
import { createTabstrip } from './tabstrip.js';
import { createToolbar } from './toolbar.js';
import { createPanel } from './panel.js';

/**
 * Arranque de la interfaz.
 *
 * El orden importa: primero pedimos el estado, aplicamos el tema y medimos el
 * layout, y solo entonces el proceso principal coloca la pagina. Asi la ventana
 * aparece ya con su aspecto final, sin un salto visible al cargar.
 */

const api = window.orbit;

const state = {
  settings: null,
  themes: [],
  profiles: {},
  visuals: {},
  versions: {},
  paths: {},
  windowMode: 'opaque',
  appliedSwitches: [],
  tabs: { activeId: null, tabs: [] },
  blockerStats: null,
};

let panelOpen = false;
let panel = null;
let tabstrip = null;
let toolbar = null;
let pushLayout = null;

async function main() {
  const boot = await api.bootstrap();
  Object.assign(state, {
    settings: boot.settings,
    themes: boot.themes,
    profiles: boot.profiles,
    visuals: boot.visuals,
    versions: boot.versions,
    paths: boot.paths,
    windowMode: boot.windowMode,
    appliedSwitches: boot.appliedSwitches,
    tabs: boot.tabs,
  });

  const theme = state.themes.find((t) => t.id === state.settings.appearance.theme) ?? state.themes[0];
  applyTheme(theme, state.settings.appearance, state.visuals);

  const applyWindowState = mountWindowControls(document.body);
  applyWindowState(boot.windowState);
  mountResizers($('#resizers'));
  enableTitlebarDoubleClick($('#titlebar'));

  tabstrip = createTabstrip($('#tabstrip'));
  toolbar = createToolbar({ onOpenPanel: togglePanel });
  panel = createPanel({
    container: $('#panel-body'),
    tabsEl: $('#panel-tabs'),
    state,
    onSectionChange: () => pushLayout?.(),
  });

  pushLayout = startLayoutSync($('#page-slot'));

  renderTabs(state.tabs);

  api.tabs.onUpdate((snapshot) => renderTabs(snapshot));
  api.window.onState((windowState) => {
    applyWindowState(windowState);
    // El redondeo cambia al maximizar, y con el el rectangulo de la pagina.
    pushLayout?.();
  });
  api.settings.onChange((settings) => {
    state.settings = settings;
  });
  api.app.onShortcut(handleCombo);

  window.addEventListener('keydown', onKeyDown);
}

function renderTabs(snapshot) {
  state.tabs = snapshot;
  tabstrip.render(snapshot);
  toolbar.render(snapshot);
  panel.setTabs();
}

// ------------------------------------------------------------------ panel

async function togglePanel(force) {
  const next = force ?? !panelOpen;
  if (next === panelOpen) return;
  panelOpen = next;

  const el = $('#panel');
  el.hidden = !panelOpen;
  $('#btn-panel').classList.toggle('active', panelOpen);

  if (panelOpen) {
    // Las metricas solo se muestrean con el panel abierto: mirar el consumo no
    // deberia ser una de las cosas que consume.
    if (!state.blockerStats) state.blockerStats = await api.resources.blockerStats();
    panel.render();
    panel.setSample(await api.resources.subscribe());
  } else {
    await api.resources.unsubscribe();
  }

  // El panel se acopla, asi que el hueco de la pagina cambia de tamano.
  pushLayout?.();
}

api.resources.onSample((sample) => {
  if (panelOpen) panel.setSample(sample);
});

// -------------------------------------------------------------- atajos

function onKeyDown(event) {
  const combo = comboOf(event);
  if (!combo) return;
  // En la barra de direcciones, Enter y Escape los gestiona la propia barra.
  if (event.target.tagName === 'INPUT' && !combo.startsWith('ctrl') && !combo.startsWith('alt')) return;
  if (handleCombo(combo)) event.preventDefault();
}

function comboOf(event) {
  const key = String(event.key ?? '').toLowerCase();
  if (!key || key === 'control' || key === 'shift' || key === 'alt') return null;
  const parts = [];
  if (event.ctrlKey) parts.push('ctrl');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  parts.push({ arrowleft: 'left', arrowright: 'right' }[key] ?? key);
  return parts.join('+');
}

function handleCombo(combo) {
  const active = state.tabs.activeId;

  switch (combo) {
    case 'ctrl+t':
      api.tabs.create(null, { active: true });
      return true;
    case 'ctrl+w':
      if (active != null) api.tabs.close(active);
      return true;
    case 'ctrl+l':
      toolbar.focusOmnibox();
      return true;
    case 'ctrl+r':
    case 'f5':
      if (active != null) api.tabs.reload(active);
      return true;
    case 'ctrl+shift+r':
      if (active != null) api.tabs.reload(active, { ignoreCache: true });
      return true;
    case 'alt+left':
      if (active != null) api.tabs.back(active);
      return true;
    case 'alt+right':
      if (active != null) api.tabs.forward(active);
      return true;
    case 'ctrl+tab':
      cycleTab(1);
      return true;
    case 'ctrl+shift+tab':
      cycleTab(-1);
      return true;
    case 'ctrl+,':
      togglePanel();
      return true;
    case 'f6':
      // Dormir el resto: el atajo para recuperar memoria de golpe.
      api.tabs.sleepOthers();
      return true;
    default:
      break;
  }

  const numeric = /^ctrl\+([1-9])$/.exec(combo);
  if (numeric) {
    const index = Number(numeric[1]) - 1;
    const target = state.tabs.tabs[index];
    if (target) api.tabs.activate(target.id);
    return true;
  }

  return false;
}

function cycleTab(direction) {
  const list = state.tabs.tabs;
  if (list.length < 2) return;
  const current = list.findIndex((t) => t.id === state.tabs.activeId);
  const next = (current + direction + list.length) % list.length;
  api.tabs.activate(list[next].id);
}

main().catch((err) => {
  console.error('[ui] fallo al arrancar:', err);
  document.body.append(
    Object.assign(document.createElement('pre'), {
      textContent: `Error al arrancar la interfaz:\n${err?.stack ?? err}`,
      style: 'padding:20px;color:#f7768e;font-family:monospace;white-space:pre-wrap',
    }),
  );
});
