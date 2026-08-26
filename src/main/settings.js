'use strict';

const path = require('node:path');
const { app } = require('electron');
const { JsonStore, deepMerge } = require('./store');

const DEFAULTS = {
  version: 1,

  window: {
    width: 1320,
    height: 860,
    x: null,
    y: null,
    maximized: false,
  },

  appearance: {
    theme: 'orbit-noche',
    /** opaque | translucent | acrylic (acrylic solo Win11) */
    surface: 'translucent',
    /** Opacidad del chrome de la app (barra de pestanas, toolbar, paneles). */
    chromeOpacity: 0.78,
    /** Opacidad de la "hoja" de fondo detras del contenido. */
    shellOpacity: 0.92,
    accent: '#7aa2f7',
    radius: 14,
    /** La pagina flota con margen: se ve el escritorio alrededor. */
    floatingPage: true,
    pageInset: 10,
    fontScale: 1,
    /** Desenfoque CSS interno del chrome (no afecta al escritorio). */
    chromeBlur: 20,
    /** top | left | right */
    tabStrip: 'top',
    /** Ancho del rail de pestañas cuando está a un lado. */
    tabStripWidth: 214,
  },

  resources: {
    /** saver | balanced | performance | custom */
    profile: 'balanced',

    // --- En caliente: se aplica sin reiniciar ---
    /** Dormir pestanas inactivas: libera el proceso del renderer completo. */
    sleepEnabled: true,
    sleepAfterMinutes: 10,
    /** Maximo de pestanas con proceso vivo. 0 = sin limite. */
    maxLiveTabs: 8,
    /** No dormir pestanas que estan reproduciendo audio. */
    keepAudibleAwake: true,
    /** No dormir pestanas fijadas. */
    keepPinnedAwake: false,
    /** Intervalo de muestreo de metricas (solo mientras el panel esta abierto). */
    metricsIntervalMs: 2000,

    // --- Requiere pestana nueva ---
    /** Frenar timers/rAF de pestanas en segundo plano. */
    backgroundThrottle: true,
    /** allowed | animateOnce | noAnimation */
    imageAnimationPolicy: 'allowed',

    // --- Requiere reiniciar la app ---
    hardwareAcceleration: true,
    gpuRasterization: true,
    /** Limite de procesos de renderer de Chromium. 0 = automatico. */
    rendererProcessLimit: 0,
    /** Tope de heap de V8 por pestana en MB. 0 = default de Chromium. */
    jsHeapMB: 0,
    /** Cache de disco HTTP en MB. 0 = default. */
    diskCacheMB: 0,
  },

  browsing: {
    startPage: 'orbit://start',
    searchTemplate: 'https://duckduckgo.com/?q=%s',
    blockTrackers: true,
    restoreSession: true,
    /** Pestanas restauradas arrancan dormidas: inicio instantaneo. */
    restoreAsleep: true,
  },
};

/**
 * Perfiles de recursos. Cada perfil es un parche sobre `resources`.
 *
 * Idea central del proyecto: el usuario elige cuanto quiere gastar, y el
 * navegador no se vuelve lento por administrarlo. Todo lo que se puede hacer
 * en caliente se hace en caliente; lo que Chromium solo lee al arrancar se
 * marca como "requiere reinicio" en vez de reiniciar a escondidas.
 */
const PROFILES = {
  saver: {
    label: 'Ahorro',
    description: 'Menos RAM y CPU. Duerme pestañas rápido y limita procesos.',
    patch: {
      sleepEnabled: true,
      sleepAfterMinutes: 3,
      maxLiveTabs: 3,
      backgroundThrottle: true,
      imageAnimationPolicy: 'animateOnce',
      gpuRasterization: false,
      rendererProcessLimit: 3,
      jsHeapMB: 512,
      diskCacheMB: 128,
    },
  },
  balanced: {
    label: 'Equilibrado',
    description: 'Uso normal. Duerme lo que no tocas, sin limitar el resto.',
    patch: {
      sleepEnabled: true,
      sleepAfterMinutes: 10,
      maxLiveTabs: 8,
      backgroundThrottle: true,
      imageAnimationPolicy: 'allowed',
      gpuRasterization: true,
      rendererProcessLimit: 0,
      jsHeapMB: 0,
      diskCacheMB: 0,
    },
  },
  performance: {
    label: 'Rendimiento',
    description: 'Nada duerme, todo en GPU. Más RAM a cambio de fluidez.',
    patch: {
      sleepEnabled: false,
      sleepAfterMinutes: 60,
      maxLiveTabs: 0,
      backgroundThrottle: false,
      imageAnimationPolicy: 'allowed',
      gpuRasterization: true,
      rendererProcessLimit: 0,
      jsHeapMB: 0,
      diskCacheMB: 512,
    },
  },
};

/** Ajustes que Chromium solo lee al arrancar. */
const RESTART_KEYS = new Set([
  'hardwareAcceleration',
  'gpuRasterization',
  'rendererProcessLimit',
  'jsHeapMB',
  'diskCacheMB',
]);

/** Ajustes que se aplican solo a pestanas creadas despues del cambio. */
const NEW_TAB_KEYS = new Set(['backgroundThrottle', 'imageAnimationPolicy']);

let store = null;

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function initSettings() {
  store = new JsonStore(settingsPath(), DEFAULTS, { debounceMs: 500 });
  return store.data;
}

/**
 * Lee settings sin necesitar `app` listo (para los switches de Chromium, que
 * deben aplicarse antes de `app.whenReady`).
 */
function readSettingsEarly() {
  const early = new JsonStore(settingsPath(), DEFAULTS);
  return early.data;
}

function getSettings() {
  if (!store) throw new Error('settings no inicializado');
  return store.data;
}

/** Aplica un parche parcial y devuelve { settings, restartNeeded, newTabOnly }. */
function patchSettings(patch) {
  const before = structuredClone(store.data.resources);
  store.data = deepMerge(store.data, patch);
  store.save();

  const changed = Object.keys(patch.resources ?? {}).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(store.data.resources[key]),
  );

  return {
    settings: store.data,
    restartNeeded: changed.filter((k) => RESTART_KEYS.has(k)),
    newTabOnly: changed.filter((k) => NEW_TAB_KEYS.has(k)),
  };
}

/** Cambia de perfil aplicando su parche completo. */
function applyProfile(name) {
  const profile = PROFILES[name];
  if (!profile) throw new Error(`perfil desconocido: ${name}`);
  return patchSettings({ resources: { profile: name, ...profile.patch } });
}

function saveSettingsNow() {
  store?.saveNow();
}

module.exports = {
  DEFAULTS,
  PROFILES,
  RESTART_KEYS,
  NEW_TAB_KEYS,
  initSettings,
  readSettingsEarly,
  getSettings,
  patchSettings,
  applyProfile,
  saveSettingsNow,
};
