'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

/**
 * Firma VMP de Widevine (Castlabs EVS) sobre el paquete ya empaquetado.
 *
 * Sin esta firma, Windows trata Orbit como cliente de desarrollo y Netflix
 * rechaza el DRM. Si no hay cuenta EVS, el build sigue; hay que firmar a mano:
 *   python -m castlabs_evs.vmp sign-pkg dist/win-unpacked
 */
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32' && context.electronPlatformName !== 'darwin') return;
  const dir = context.appOutDir;
  const candidates = process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
  let lastErr = null;
  for (const bin of candidates) {
    try {
      const args = bin === 'py' ? ['-3', '-m', 'castlabs_evs.vmp', 'sign-pkg', '--no-ask', dir] : ['-m', 'castlabs_evs.vmp', 'sign-pkg', '--no-ask', dir];
      await execFileAsync(bin, args, { windowsHide: true });
      console.log('[widevine] paquete firmado con EVS:', dir);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  const detail = lastErr?.stderr || lastErr?.stdout || lastErr?.message;
  console.warn('[widevine] no se firmo VMP (Netflix puede seguir fallando):', String(detail).slice(0, 400));
};
