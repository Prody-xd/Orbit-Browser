/**
 * Aplicacion de temas.
 *
 * Un tema es JSON con colores; la apariencia (opacidad, radio, desenfoque,
 * margen) son ajustes aparte. Los dos se combinan en variables CSS, asi que
 * cambiar cualquier cosa se ve al instante y sin recargar la UI: no hay que
 * reconstruir nodos, solo reasignar variables en `:root`.
 */

function rgbTriplet(hex) {
  const clean = String(hex || '').replace('#', '').trim();
  const full = clean.length === 3 ? clean.replace(/./g, (c) => c + c) : clean;
  const num = Number.parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(num)) return '0 0 0';
  return `${(num >> 16) & 255} ${(num >> 8) & 255} ${num & 255}`;
}

export function applyTheme(theme, appearance, visuals) {
  const root = document.documentElement.style;
  const c = theme?.colors ?? {};
  const accent = appearance.accent || c.accent || '#7aa2f7';

  root.setProperty('--rgb-base', rgbTriplet(c.base));
  root.setProperty('--rgb-chrome', rgbTriplet(c.chrome ?? c.base));
  root.setProperty('--rgb-elevated', rgbTriplet(c.elevated ?? c.chrome ?? c.base));
  root.setProperty('--rgb-border', rgbTriplet(c.border));
  root.setProperty('--rgb-accent', rgbTriplet(accent));

  root.setProperty('--c-text', c.text ?? '#c9d1e6');
  root.setProperty('--c-muted', c.muted ?? '#79839e');
  root.setProperty('--c-accent', accent);
  root.setProperty('--c-border', c.border ?? '#2b2e42');
  root.setProperty('--c-danger', c.danger ?? '#f7768e');
  root.setProperty('--c-ok', c.ok ?? '#9ece6a');
  root.setProperty('--c-warn', c.warn ?? '#e0af68');

  const opaque = appearance.surface === 'opaque';
  root.setProperty('--alpha-shell', String(opaque ? 1 : appearance.shellOpacity));
  root.setProperty('--alpha-chrome', String(opaque ? 1 : appearance.chromeOpacity));
  root.setProperty('--radius', `${appearance.radius}px`);
  root.setProperty('--inset', `${appearance.floatingPage ? appearance.pageInset : 0}px`);
  root.setProperty('--font-scale', String(appearance.fontScale));

  // El desenfoque CSS afecta a lo que hay dentro de la ventana. El escritorio
  // solo se desenfoca de verdad si el sistema lo hace (acrylic en Win11); en
  // Windows 10 la translucidez es limpia, sin difuminar el fondo.
  root.setProperty('--blur', `${opaque ? 0 : appearance.chromeBlur}px`);

  document.body.classList.toggle('surface-opaque', opaque);
  document.body.classList.toggle('theme-light', theme?.dark === false);
  document.body.dataset.surface = appearance.surface;
  document.body.dataset.visualBlur = String(Boolean(visuals?.supportsBlur));
}

/** Colores para la miniatura de un tema en el selector. */
export function themeSwatch(theme) {
  const c = theme?.colors ?? {};
  return `linear-gradient(135deg, ${c.base ?? '#000'} 0%, ${c.chrome ?? '#111'} 55%, ${c.accent ?? '#888'} 100%)`;
}
