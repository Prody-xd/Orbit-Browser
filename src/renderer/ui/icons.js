/**
 * Iconos como SVG en linea.
 *
 * Sin archivos ni fuentes de iconos: heredan `currentColor`, asi que cambiar
 * de tema no requiere regenerar nada.
 */

const svg = (paths, size = 16) =>
  `<svg viewBox="0 0 ${size} ${size}" aria-hidden="true">${paths}</svg>`;

export const icons = {
  back: svg('<path d="M10 3.5 5.5 8l4.5 4.5"/>'),
  forward: svg('<path d="M6 3.5 10.5 8 6 12.5"/>'),
  reload: svg('<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.5V5h-2.5"/>'),
  stop: svg('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'),
  plus: svg('<path d="M8 4v8M4 8h8"/>'),
  close: svg('<path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/>', 12),
  speaker: svg('<path d="M2.5 6h2.2L8 3.5v9L4.7 10H2.5z"/><path d="M10 6.2a2.4 2.4 0 0 1 0 3.6"/>'),
  speakerOff: svg('<path d="M2.5 6h2.2L8 3.5v9L4.7 10H2.5z"/><path d="M10.2 5.5l4.3 5M14.5 5.5l-4.3 5"/>'),
  fetch: svg('<circle cx="8" cy="8" r="2.2"/><path d="M8 2.4v1.8M8 11.8v1.8M2.4 8h1.8M11.8 8h1.8M4 4l1.3 1.3M10.7 10.7 12 12M12 4l-1.3 1.3M5.3 10.7 4 12"/>'),
  settings: svg('<circle cx="8" cy="8" r="2"/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1"/>'),
  moon: svg('<path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z"/>'),
  min: svg('<path d="M1 5h8"/>', 10),
  max: svg('<rect x="1" y="1" width="8" height="8" rx="1"/>', 10),
  restore: svg('<rect x="1" y="3" width="6" height="6" rx="1"/><path d="M3 3V1.5h5.5V7"/>', 10),
  winclose: svg('<path d="M1 1l8 8M9 1l-8 8"/>', 10),
};
