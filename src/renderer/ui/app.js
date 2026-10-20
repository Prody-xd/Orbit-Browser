import { $ } from './dom.js';
import { applyTheme } from './theme.js';
import { startLayoutSync, mountResizers, mountWindowControls, enableTitlebarDoubleClick, applyTabStripPosition, mountTabRailResize } from './layout.js';
import { createTabstrip } from './tabstrip.js';
import { createToolbar } from './toolbar.js';
import { createPanel } from './panel.js';
import { createFindbar } from './findbar.js';

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
let findbar = null;
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
  applyTabStripPosition(state.settings.appearance.tabStrip, state.settings.appearance.tabStripWidth);

  const applyWindowState = mountWindowControls(document.body);
  applyWindowState(boot.windowState);
  mountResizers($('#resizers'));
  enableTitlebarDoubleClick($('#titlebar'), $('#toolbar'), $('#tabs-host-side'));
  mountTabRailResize({
    onLive: (width) => {
      state.settings.appearance.tabStripWidth = width;
      pushLayout?.();
    },
    onCommit: (width) => {
      state.settings.appearance.tabStripWidth = width;
      api.settings.patch({ appearance: { tabStripWidth: width } });
    },
  });

  tabstrip = createTabstrip($('#tabstrip'));
  findbar = createFindbar({
    getActiveId: () => state.tabs.activeId,
    onLayout: () => pushLayout?.(),
  });
  toolbar = createToolbar({
    onOpenPanel: () => togglePanel(),
    onClosePanel: () => togglePanel(false),
  });
  panel = createPanel({
    container: $('#panel-body'),
    tabsEl: $('#panel-tabs'),
    state,
    onSectionChange: () => pushLayout?.(),
    onLayoutChange: () => {
      applyTabStripPosition(state.settings.appearance.tabStrip, state.settings.appearance.tabStripWidth);
      pushLayout?.();
    },
  });

  pushLayout = startLayoutSync($('#page-slot'));

  renderTabs(state.tabs);
  toolbar.renderNetwork(boot.network ?? { count: 0 });
  toolbar.renderDownloads(boot.downloads ?? { busy: false, percent: 0, items: [] });

  api.tabs.onUpdate((snapshot) => renderTabs(snapshot));
  api.network.onUpdate((snapshot) => toolbar.renderNetwork(snapshot));
  api.downloads.onUpdate((snapshot) => toolbar.renderDownloads(snapshot));
  api.window.onState((windowState) => {
    applyWindowState(windowState);
    // El redondeo cambia al maximizar, y con el el rectangulo de la pagina.
    pushLayout?.();
  });
  api.settings.onChange((settings) => {
    state.settings = settings;
    applyTabStripPosition(settings.appearance?.tabStrip, settings.appearance?.tabStripWidth);
  });
  api.app.onShortcut(handleCombo);

  window.addEventListener('keydown', onKeyDown);
}

function renderTabs(snapshot) {
  const prevActive = state.tabs.activeId;
  state.tabs = snapshot;
  tabstrip.render(snapshot);
  toolbar.render(snapshot);
  panel.setTabs();
  if (findbar && prevActive !== snapshot.activeId) findbar.onTabChange(snapshot.activeId);
}

// ------------------------------------------------------------------ panel

async function togglePanel(force) {
  const el = $('#panel');
  const currentlyOpen = el.classList.contains('is-open');
  const next = typeof force === 'boolean' ? force : !currentlyOpen;
  panelOpen = next;

  el.classList.toggle('is-open', next);
  el.toggleAttribute('hidden', !next);
  $('#btn-panel').classList.toggle('active', next);
  // Encoger o agrandar la pagina ya, sin esperar a las metricas.
  pushLayout?.();

  if (next === currentlyOpen) return;

  if (next) {
    // Las metricas solo se muestrean con el panel abierto: mirar el consumo no
    // deberia ser una de las cosas que consume.
    if (!state.blockerStats) state.blockerStats = await api.resources.blockerStats();
    panel.render();
    panel.setSample(await api.resources.subscribe());
  } else {
    await api.resources.unsubscribe();
  }
}

api.resources.onSample((sample) => {
  if (panelOpen) panel.setSample(sample);
});

// -------------------------------------------------------------- atajos

let panelShortcutLock = false;

function requestPanelToggle() {
  if (panelShortcutLock) return;
  panelShortcutLock = true;
  // El chrome y la pagina pueden mandar el mismo Ctrl+, con unos ms de
  // diferencia. Sin este candado, el segundo evento vuelve a abrir el panel.
  setTimeout(() => {
    panelShortcutLock = false;
  }, 80);
  togglePanel();
}

function onKeyDown(event) {
  // `event.code` no depende del idioma del teclado: Ctrl+, tiene que cerrar
  // igual en un teclado español. `repeat` se ignora: si no, al mantener la
  // tecla el panel abre y cierra en bucle y parece que no se cierra.
  if (event.ctrlKey && !event.altKey && !event.shiftKey && event.code === 'Comma') {
    event.preventDefault();
    if (event.repeat) return;
    requestPanelToggle();
    return;
  }

  const combo = comboOf(event);
  if (!combo) return;
  // En la barra de direcciones, Enter y Escape los gestiona la propia barra.
  if (event.target.tagName === 'INPUT' && !combo.startsWith('ctrl') && !combo.startsWith('alt') && combo !== 'escape' && combo !== 'f3' && combo !== 'shift+f3') return;
  if (handleCombo(combo)) event.preventDefault();
}

function comboOf(event) {
  const key = String(event.key ?? '').toLowerCase();
  if (!key || key === 'control' || key === 'shift' || key === 'alt') return null;
  const parts = [];
  if (event.ctrlKey) parts.push('ctrl');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  parts.push({ arrowleft: 'left', arrowright: 'right', comma: ',' }[key] ?? key);
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
    case 'ctrl+f':
      findbar?.open();
      return true;
    case 'f3':
    case 'ctrl+g':
      findbar?.next();
      return true;
    case 'shift+f3':
    case 'ctrl+shift+g':
      findbar?.prev();
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
      requestPanelToggle();
      return true;
    case 'escape':
      if (findbar?.isOpen()) {
        findbar.close();
        return true;
      }
      if (panelOpen) {
        togglePanel(false);
        return true;
      }
      return false;
    case 'ctrl+u':
      if (active != null) api.tabs.viewSource(active);
      return true;
    case 'ctrl+shift+i':
      if (active != null) api.tabs.inspect(active);
      return true;
    case 'ctrl+p':
      if (active != null) api.tabs.print(active);
      return true;
    case 'ctrl+s':
      if (active != null) api.tabs.save(active);
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
