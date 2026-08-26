'use strict';

const os = require('node:os');

/**
 * Capacidades visuales del sistema.
 *
 * Windows 11 (build >= 22000) tiene materiales de fondo dibujados por el
 * sistema (acrylic / mica): desenfoque real del escritorio detras de la
 * ventana. Windows 10 no los expone a Electron, asi que ahi usamos una
 * ventana `transparent` con tinte alfa: se ve a traves, sin desenfoque.
 *
 * Detectarlo permite que el mismo tema se vea lo mejor posible en cada SO
 * en vez de prometer un efecto que el sistema no puede dar.
 */
function detectVisuals() {
  const platform = process.platform;
  const release = os.release();
  const build = platform === 'win32' ? Number.parseInt(release.split('.')[2] ?? '0', 10) : 0;

  const isWindows = platform === 'win32';
  const isWin11 = isWindows && build >= 22000;

  return {
    platform,
    release,
    build,
    /** Materiales del sistema con desenfoque real (acrylic/mica). */
    supportsBackgroundMaterial: isWin11,
    /** Ventana con canal alfa: translucidez sin desenfoque. */
    supportsTransparency: true,
    /** Vidrio con desenfoque de verdad, sin hacks nativos. */
    supportsBlur: isWin11 || platform === 'darwin',
    osLabel: isWindows ? `Windows ${isWin11 ? '11' : '10'} (build ${build})` : platform,
  };
}

module.exports = { detectVisuals };
