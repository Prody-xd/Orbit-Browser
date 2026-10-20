'use strict';

const os = require('node:os');
const { app } = require('electron');

/**
 * Orbit es Chromium-en-Electron. Cloudflare (Turnstile) cruza el User-Agent
 * con las Client Hints (`sec-ch-ua`) y con `navigator.userAgentData`.
 * Electron mete su propia marca ahi: el UA ya dice Chrome, las hints dicen
 * Electron, y el desafio falla.
 *
 * En la web normal alineamos cabeceras y APIs JS con Chrome estable.
 *
 * En accounts.google.com ocurre lo contrario: si finges Chrome, Google lanza
 * Botguard contra el Chrome de verdad y te manda a /signin/rejected. Ahi hay
 * que presentarse como Electron (sin el nombre de la app), usar el flujo
 * ligero WebLiteSignIn, y borrar las cookies que el rechazo deja envenenadas.
 */

const wired = new WeakSet();
const googleAuthRetryAt = new WeakMap();

function chromeVersion() {
  return String(process.versions.chrome || '142.0.0.0');
}

function chromeMajor() {
  return chromeVersion().split('.')[0] || '142';
}

function electronVersion() {
  return String(process.versions.electron || '39.8.10');
}

function pageUserAgent() {
  const chrome = chromeVersion();
  if (process.platform === 'win32') {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
  }
  if (process.platform === 'darwin') {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
  }
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}

/** UA nativo de Electron, sin Orbit/productName: Google no lo trata como Chrome falso. */
function electronUserAgent() {
  const chrome = chromeVersion();
  const electron = electronVersion();
  if (process.platform === 'win32') {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Electron/${electron} Safari/537.36`;
  }
  if (process.platform === 'darwin') {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Electron/${electron} Safari/537.36`;
  }
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Electron/${electron} Safari/537.36`;
}

function uaPlatform() {
  if (process.platform === 'win32') return 'Windows';
  if (process.platform === 'darwin') return 'macOS';
  return 'Linux';
}

function platformVersion() {
  if (process.platform !== 'win32') return '0.0.0';
  const build = Number(String(os.release()).split('.')[2]) || 0;
  return build >= 22000 ? '15.0.0' : '10.0.0';
}

/** GREASE de Chromium 120+: Cloudflare comprueba que coincida cabecera y JS. */
const GREASE_BRAND = 'Not(A:Brand';
const GREASE_MAJOR = '8';
const GREASE_FULL = '8.0.0.0';

function lowEntropyBrands() {
  const major = chromeMajor();
  return `"Google Chrome";v="${major}", "Chromium";v="${major}", "${GREASE_BRAND}";v="${GREASE_MAJOR}"`;
}

function electronLowEntropyBrands() {
  const major = chromeMajor();
  const electronMajor = electronVersion().split('.')[0] || '39';
  return `"${GREASE_BRAND}";v="${GREASE_MAJOR}", "Chromium";v="${major}", "Electron";v="${electronMajor}"`;
}

function fullVersionList() {
  const full = chromeVersion();
  const major = chromeMajor();
  return `"Google Chrome";v="${full}", "Chromium";v="${full}", "${GREASE_BRAND}";v="${GREASE_FULL}"`;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isGoogleAuthUrl(url) {
  const host = hostOf(url);
  if (!host) return false;
  return (
    host === 'accounts.google.com' ||
    host.endsWith('.accounts.google.com') ||
    host === 'accounts.youtube.com' ||
    host === 'signin.google.com' ||
    host === 'oauthaccountmanager.googleapis.com'
  );
}

function rewriteGoogleAuthUrl(url) {
  const raw = String(url || '');
  if (!isGoogleAuthUrl(raw) || !raw.includes('flowName=GlifWebSignIn')) return null;
  return raw.replaceAll('flowName=GlifWebSignIn', 'flowName=WebLiteSignIn');
}

function recoverGoogleSignInUrl(rejectedUrl) {
  try {
    const parsed = new URL(rejectedUrl);
    const cont = parsed.searchParams.get('continue') || 'https://mail.google.com/mail/';
    const next = new URL('https://accounts.google.com/ServiceLogin');
    next.searchParams.set('continue', cont);
    return next.toString();
  } catch {
    return 'https://accounts.google.com/ServiceLogin';
  }
}

function stripHintHeaders(headers) {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase().startsWith('sec-ch-ua')) delete headers[key];
  }
}

function hadHighEntropyHints(headers) {
  return Object.keys(headers).some((key) => {
    const name = key.toLowerCase();
    return name.startsWith('sec-ch-ua-') && name !== 'sec-ch-ua-mobile' && name !== 'sec-ch-ua-platform';
  });
}

function applyChromePageHeaders(headers) {
  const extra = hadHighEntropyHints(headers);
  stripHintHeaders(headers);
  headers['User-Agent'] = pageUserAgent();
  headers['sec-ch-ua'] = lowEntropyBrands();
  headers['sec-ch-ua-mobile'] = '?0';
  headers['sec-ch-ua-platform'] = `"${uaPlatform()}"`;
  if (!extra) return;
  headers['sec-ch-ua-full-version-list'] = fullVersionList();
  headers['sec-ch-ua-arch'] = '"x86"';
  headers['sec-ch-ua-bitness'] = '"64"';
  headers['sec-ch-ua-model'] = '""';
  headers['sec-ch-ua-wow64'] = '?0';
  headers['sec-ch-ua-platform-version'] = `"${platformVersion()}"`;
  headers['sec-ch-ua-full-version'] = `"${chromeVersion()}"`;
}

function applyGoogleAuthHeaders(headers) {
  stripHintHeaders(headers);
  headers['User-Agent'] = electronUserAgent();
  headers['sec-ch-ua'] = electronLowEntropyBrands();
  headers['sec-ch-ua-mobile'] = '?0';
  headers['sec-ch-ua-platform'] = `"${uaPlatform()}"`;
}

function applyRequestHeaders(ses) {
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    if (!/^https?:/i.test(details.url)) return callback({ requestHeaders: details.requestHeaders });
    const headers = { ...details.requestHeaders };
    if (isGoogleAuthUrl(details.url)) applyGoogleAuthHeaders(headers);
    else applyChromePageHeaders(headers);
    callback({ requestHeaders: headers });
  });
}

function pageWorldScript() {
  const major = chromeMajor();
  const full = chromeVersion();
  const platform = uaPlatform();
  const platVer = platformVersion();
  return `(() => {
    const brands = [
      { brand: 'Google Chrome', version: ${JSON.stringify(major)} },
      { brand: 'Chromium', version: ${JSON.stringify(major)} },
      { brand: ${JSON.stringify(GREASE_BRAND)}, version: ${JSON.stringify(GREASE_MAJOR)} },
    ];
    const fullVersionList = [
      { brand: 'Google Chrome', version: ${JSON.stringify(full)} },
      { brand: 'Chromium', version: ${JSON.stringify(full)} },
      { brand: ${JSON.stringify(GREASE_BRAND)}, version: ${JSON.stringify(GREASE_FULL)} },
    ];
    const data = {
      brands,
      mobile: false,
      platform: ${JSON.stringify(platform)},
      getHighEntropyValues(hints) {
        const out = {
          brands,
          mobile: false,
          platform: ${JSON.stringify(platform)},
        };
        const extra = {
          platformVersion: ${JSON.stringify(platVer)},
          architecture: 'x86',
          bitness: '64',
          model: '',
          uaFullVersion: ${JSON.stringify(full)},
          fullVersionList,
        };
        for (const hint of hints || []) {
          if (hint in extra) out[hint] = extra[hint];
        }
        return Promise.resolve(out);
      },
      toJSON() {
        return { brands, mobile: false, platform: ${JSON.stringify(platform)} };
      },
    };
    const target = typeof Navigator === 'function' ? Navigator.prototype : navigator;
    try {
      Object.defineProperty(target, 'userAgentData', { configurable: true, enumerable: true, get: () => data });
    } catch {
      try {
        Object.defineProperty(navigator, 'userAgentData', { configurable: true, get: () => data });
      } catch {
        /* el motor no deja redefinir */
      }
    }
  })()`;
}

function inject(contents) {
  if (!contents || contents.isDestroyed()) return;
  const url = contents.getURL?.() || '';
  if (!shouldSpoofChrome(url)) return;
  contents.executeJavaScript(pageWorldScript(), true).catch(() => {});
}

function shouldSpoofChrome(url) {
  return /^https?:/i.test(url) && !isGoogleAuthUrl(url);
}

function applyUserAgentForUrl(contents, url) {
  if (!contents || contents.isDestroyed()) return;
  try {
    contents.setUserAgent(isGoogleAuthUrl(url) ? electronUserAgent() : pageUserAgent());
  } catch {
    /* ya cerrado */
  }
}

function navUrl(eventOrDetails, url, isMainFrame) {
  if (eventOrDetails && typeof eventOrDetails === 'object' && typeof eventOrDetails.url === 'string') {
    return { url: eventOrDetails.url, isMainFrame: eventOrDetails.isMainFrame !== false };
  }
  return { url: String(url || ''), isMainFrame: isMainFrame !== false };
}

function cookieUrl(cookie) {
  const domain = String(cookie.domain || '').replace(/^\./, '');
  const path = cookie.path || '/';
  const scheme = cookie.secure ? 'https://' : 'http://';
  return `${scheme}${domain}${path}`;
}

function isPoisonedGoogleCookie(cookie) {
  const name = String(cookie.name || '');
  return name === 'OTZ' || name === '__Host-GAPS' || name.startsWith('__Host-GAPS');
}

async function clearGoogleAuthCookies(ses) {
  if (!ses?.cookies) return;
  try {
    const cookies = await ses.cookies.get({ domain: 'accounts.google.com' });
    await Promise.all(
      cookies
        .filter(isPoisonedGoogleCookie)
        .map((cookie) => ses.cookies.remove(cookieUrl(cookie), cookie.name).catch(() => {})),
    );
  } catch {
    /* la sesion puede haberse cerrado */
  }
}

async function retryGoogleSignIn(contents, url) {
  const last = googleAuthRetryAt.get(contents) || 0;
  if (Date.now() - last < 12_000) return;
  googleAuthRetryAt.set(contents, Date.now());
  await clearGoogleAuthCookies(contents.session);
  if (contents.isDestroyed()) return;
  const next = recoverGoogleSignInUrl(url);
  contents.loadURL(next).catch(() => {});
}

function attachToContents(contents) {
  if (!contents || contents.isDestroyed() || wired.has(contents)) return;
  wired.add(contents);
  applyUserAgentForUrl(contents, contents.getURL?.() || '');

  contents.on('did-start-navigation', (event, url, _inPlace, isMainFrame) => {
    const nav = navUrl(event, url, isMainFrame);
    if (!nav.isMainFrame) return;
    applyUserAgentForUrl(contents, nav.url);
  });

  contents.on('did-navigate', (event, url) => {
    const nav = navUrl(event, url, true);
    if (/accounts\.google\.com\/.*signin\/rejected/i.test(nav.url)) {
      retryGoogleSignIn(contents, nav.url).catch(() => {});
      return;
    }
    inject(contents);
  });
  contents.on('dom-ready', () => inject(contents));
  contents.on('frame-created', (_e, details) => {
    const frame = details?.frame;
    if (!frame || frame.isDestroyed?.()) return;
    const frameUrl = frame.url || contents.getURL?.() || '';
    if (!shouldSpoofChrome(frameUrl)) return;
    frame.executeJavaScript(pageWorldScript()).catch(() => {});
  });
}

function applyChromeCompat(ses) {
  app.userAgentFallback = pageUserAgent();
  ses.setUserAgent(pageUserAgent());
  applyRequestHeaders(ses);
  app.on('web-contents-created', (_e, contents) => {
    if (contents.session === ses) attachToContents(contents);
  });
}

module.exports = {
  pageUserAgent,
  electronUserAgent,
  applyChromeCompat,
  attachToContents,
  isGoogleAuthUrl,
  rewriteGoogleAuthUrl,
};
