'use strict';

const { app } = require('electron');

/**
 * Traduce los ajustes de recursos a flags de linea de comandos de Chromium.
 *
 * Esto se ejecuta ANTES de `app.whenReady()`: Chromium lee estos switches una
 * sola vez al arrancar. Por eso la UI marca estos ajustes como
 * "requiere reiniciar" en lugar de fingir que se aplican en caliente.
 *
 * @param {ReturnType<import('./settings').readSettingsEarly>} settings
 * @returns {string[]} lista legible de lo aplicado (para mostrarlo en la UI)
 */
function applyChromiumSwitches(settings) {
  const r = settings.resources ?? {};
  const applied = [];

  if (r.hardwareAcceleration === false) {
    app.disableHardwareAcceleration();
    applied.push('aceleración por hardware: desactivada');
  } else if (r.gpuRasterization === false) {
    // Mantiene la GPU para composicion pero pinta en CPU: menos VRAM.
    app.commandLine.appendSwitch('disable-gpu-rasterization');
    applied.push('rasterización en GPU: desactivada');
  } else {
    app.commandLine.appendSwitch('enable-gpu-rasterization');
    app.commandLine.appendSwitch('enable-zero-copy');
    applied.push('rasterización en GPU: activada');
  }

  const limit = Number(r.rendererProcessLimit) || 0;
  if (limit > 0) {
    // Chromium reutiliza procesos al llegar al tope: menos RAM, mas
    // acoplamiento entre pestanas (una pestana pesada afecta a sus vecinas).
    app.commandLine.appendSwitch('renderer-process-limit', String(limit));
    applied.push(`límite de procesos de renderer: ${limit}`);
  }

  const heap = Number(r.jsHeapMB) || 0;
  if (heap > 0) {
    app.commandLine.appendSwitch('js-flags', `--max-old-space-size=${heap}`);
    applied.push(`memoria JS por pestaña: ${heap} MB`);
  }

  const cache = Number(r.diskCacheMB) || 0;
  if (cache > 0) {
    app.commandLine.appendSwitch('disk-cache-size', String(cache * 1024 * 1024));
    applied.push(`caché en disco: ${cache} MB`);
  }

  // Windows avisa a Chromium cuando una ventana queda tapada, y Chromium deja
  // de pintarla. IntensiveWakeUpThrottling frena timers de pestanas que no
  // se ven, sin tocar la que estas usando.
  const enable = ['IntensiveWakeUpThrottling'];
  if (process.platform === 'win32') enable.push('CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('enable-features', enable.join(','));
  applied.push('limitación de pestañas en segundo plano: activada');

  // SpareRenderer deja un proceso renderer vacio por si acaso (~decenas de MB).
  // Sin el, una pestana nueva tarda un pelin mas; la que ya esta abierta no cambia.
  // No invertir paginas claras: el modo oscuro lo decide el sitio.
  app.commandLine.appendSwitch(
    'disable-features',
    [
      'SpareRendererForSitePerProcess',
      'WebContentsForceDark',
      'WebContentsForceDarkMode',
      'ForceWebContentsDarkMode',
      'AutoDarkMode',
    ].join(','),
  );
  app.commandLine.appendSwitch('blink-settings', 'forceDarkModeEnabled=false');
  app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
  applied.push('proceso renderer de reserva: desactivado');

  return applied;
}

module.exports = { applyChromiumSwitches };
