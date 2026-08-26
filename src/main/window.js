'use strict';

const path = require('node:path');
const { BrowserWindow, screen } = require('electron');

/**
 * Crea la ventana-cascara: sin marco nativo, con nuestro propio chrome HTML.
 *
 * En Windows 11 pedimos un material del sistema (acrylic) porque da desenfoque
 * real. En Windows 10 usamos `transparent: true`, que da translucidez con
 * canal alfa. Son caminos distintos y no se pueden combinar: `transparent`
 * y `backgroundMaterial` se excluyen.
 */
function createShellWindow({ settings, visuals }) {
  const { appearance, window: win } = settings;
  const useMaterial = visuals.supportsBackgroundMaterial && appearance.surface === 'acrylic';
  const useTransparent = !useMaterial && appearance.surface !== 'opaque';

  const bounds = sanitizeBounds(win);

  const options = {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 620,
    minHeight: 420,
    frame: false,
    show: false,
    // Sin transparencia, el fondo debe ser opaco para evitar flashes blancos.
    backgroundColor: useTransparent ? '#00000000' : '#12131a',
    transparent: useTransparent,
    // Necesario en Windows para que la ventana sin marco siga redimensionable
    // desde los bordes cuando no es transparente.
    thickFrame: !useTransparent,
    roundedCorners: !useTransparent,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'shell.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // El chrome de la app es UI local: sin throttling para que las
      // animaciones y el panel de recursos sigan fluidos.
      backgroundThrottling: false,
      spellcheck: false,
    },
  };

  if (useMaterial) options.backgroundMaterial = 'acrylic';

  const window = new BrowserWindow(options);
  window.setMenuBarVisibility(false);

  if (win.maximized) window.maximize();

  window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  window.once('ready-to-show', () => window.show());

  return { window, mode: useMaterial ? 'acrylic' : useTransparent ? 'transparent' : 'opaque' };
}

/** Descarta posiciones guardadas que ya no caen en ninguna pantalla. */
function sanitizeBounds(win) {
  const width = clamp(win.width ?? 1320, 620, 10000);
  const height = clamp(win.height ?? 860, 420, 10000);
  if (win.x == null || win.y == null) return { width, height, x: undefined, y: undefined };

  const visible = screen.getAllDisplays().some((display) => {
    const wa = display.workArea;
    return win.x < wa.x + wa.width && win.x + width > wa.x && win.y < wa.y + wa.height && win.y + height > wa.y;
  });

  return visible ? { width, height, x: win.x, y: win.y } : { width, height, x: undefined, y: undefined };
}

function clamp(value, min, max) {
  return Math.min(Math.max(Number(value) || min, min), max);
}

/**
 * Redimensionado manual para ventanas transparentes.
 *
 * Windows no dibuja bordes de redimension en ventanas con canal alfa, asi que
 * el renderer marca zonas de agarre y el proceso principal sigue el cursor
 * mientras se arrastra. El bucle solo existe durante el arrastre.
 */
function createResizeController(window) {
  let timer = null;
  let edge = null;
  let start = null;

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    edge = null;
    start = null;
  }

  return {
    begin(nextEdge) {
      if (!window || window.isDestroyed() || window.isMaximized()) return;
      stop();
      edge = nextEdge;
      const cursor = screen.getCursorScreenPoint();
      start = { cursor, bounds: window.getBounds() };
      const min = window.getMinimumSize();

      timer = setInterval(() => {
        if (!window || window.isDestroyed()) return stop();
        const now = screen.getCursorScreenPoint();
        const dx = now.x - start.cursor.x;
        const dy = now.y - start.cursor.y;
        const b = { ...start.bounds };

        if (edge.includes('e')) b.width = Math.max(min[0], start.bounds.width + dx);
        if (edge.includes('s')) b.height = Math.max(min[1], start.bounds.height + dy);
        if (edge.includes('w')) {
          const width = Math.max(min[0], start.bounds.width - dx);
          b.x = start.bounds.x + (start.bounds.width - width);
          b.width = width;
        }
        if (edge.includes('n')) {
          const height = Math.max(min[1], start.bounds.height - dy);
          b.y = start.bounds.y + (start.bounds.height - height);
          b.height = height;
        }

        window.setBounds(b);
      }, 16);
    },
    end: stop,
    dispose: stop,
  };
}

module.exports = { createShellWindow, createResizeController };
