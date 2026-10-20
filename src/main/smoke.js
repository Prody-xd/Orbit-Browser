'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const settingsModule = require('./settings');

/**
 * Prueba de humo automatizada.
 *
 * Un navegador no se puede validar solo leyendo el codigo: hay que abrirlo,
 * navegar, dormir una pestana y comprobar que el estado cambia. Este modulo
 * hace ese recorrido sin manos, guarda capturas y escribe un informe.
 *
 * Se carga solo con `VITRAL_SMOKE=1`, asi que no pesa nada en el arranque
 * normal.
 *
 * Uso: `npm run smoke`
 */
async function runSmoke({ window, tabs, metrics, blocker, windowMode, host, downloads, forms }) {
  const outDir = path.join(app.getAppPath(), 'out', 'smoke');
  fs.mkdirSync(outDir, { recursive: true });

  const report = [];
  const log = (line) => {
    report.push(line);
    console.log(`[smoke] ${line}`);
  };
  const fails = [];
  const check = (label, ok, detail = '') => {
    log(`${ok ? 'OK  ' : 'FALLO'} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) fails.push(label);
  };

  const shot = async (name, contents) => {
    try {
      // `capturePage()` puede no resolver nunca si la vista aun no ha pintado,
      // asi que nunca lo esperamos sin limite: una captura perdida no debe
      // bloquear el resto de la verificacion.
      const image = await withTimeout(contents.capturePage(), 6000);
      if (!image) return log(`captura ${name}: sin respuesta en 6 s, se omite`);
      const file = path.join(outDir, `${name}.png`);
      fs.writeFileSync(file, image.toPNG());
      log(`captura ${name}.png (${image.getSize().width}x${image.getSize().height})`);
    } catch (err) {
      log(`captura ${name} fallo: ${err.message}`);
    }
  };

  try {
    await resetWorkspace({ tabs, host, window });
    await wait(800);

    // --- 1. la cascara y la primera pestana existen ---
    const first = tabs.snapshot();
    check('la ventana abre con una pestana', first.tabs.length === 1, `${first.tabs.length} pestanas`);
    check('hay pestana activa', first.activeId != null, `id ${first.activeId}`);

    // --- 2. el layout llego desde el renderer y la vista se coloco ---
    const bounds = tabs.pageBounds;
    check(
      'el renderer reporto el hueco de la pagina',
      bounds.width > 100 && bounds.height > 100,
      `${bounds.width}x${bounds.height} en (${bounds.x},${bounds.y})`,
    );

    const activeTab = tabs.tabs.get(tabs.activeId);
    check('la pestana activa tiene vista nativa', Boolean(activeTab?.view));

    // La pagina de inicio va por el protocolo interno `orbit://`.
    const startLoaded = await waitFor(() => {
      const t = tabs.tabs.get(tabs.activeId);
      return t?.view && !t.loading && !t.error;
    }, 8000);
    check('la pagina de inicio carga por orbit://', startLoaded, activeTab?.error?.description ?? 'sin error');

    const startTitle = activeTab?.view
      ? await withTimeout(activeTab.view.webContents.executeJavaScript('document.title', true), 3000)
      : null;
    check('la pagina de inicio ejecuta su script', startTitle === 'Orbit', String(startTitle));

    // El atajo real llega por IPC (foco en la pagina o en el chrome). El
    // KeyboardEvent sintetico no basta: Chromium no lo trata como Ctrl+F.
    window.webContents.send('app:shortcut', 'ctrl+f');
    await wait(250);
    const findOpened = await window.webContents.executeJavaScript(
      "Boolean(document.getElementById('findbar') && !document.getElementById('findbar').hidden)",
      true,
    );
    check('Ctrl+F abre la barra de busqueda', findOpened);
    await window.webContents.executeJavaScript(
      `(() => {
        const input = document.getElementById('find-input');
        if (!input) return;
        input.focus();
        input.value = 'Orbit';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`,
      true,
    );
    let findCount = '';
    const foundDeadline = Date.now() + 4000;
    let found = false;
    while (Date.now() < foundDeadline) {
      findCount = (await withTimeout(
        window.webContents.executeJavaScript("document.getElementById('find-count')?.textContent || ''", true),
        800,
      )) || '';
      if (findCount && findCount !== 'Sin resultados' && /\d/.test(findCount)) {
        found = true;
        break;
      }
      await wait(150);
    }
    check('buscar en la pagina encuentra coincidencias', found, String(findCount));
    window.webContents.send('app:shortcut', 'escape');
    await wait(200);
    const findClosed = await withTimeout(
      window.webContents.executeJavaScript("Boolean(document.getElementById('findbar')?.hidden)", true),
      800,
    );
    check('Esc cierra la barra de busqueda', findClosed === true);

    const alertPage = tabs.tabs.get(tabs.activeId)?.view?.webContents;
    const alertDone = alertPage
      ? alertPage.executeJavaScript('alert("hola-orbit"); "done"', true)
      : Promise.resolve(null);
    const alertOpened = await waitFor(() => tabs.jsDialogs?.isOpen?.(), 5000);
    check('alert abre el dialogo de Orbit', alertOpened);
    let alertText = '';
    if (alertOpened && tabs.jsDialogs.overlayContents) {
      alertText = (await withTimeout(
        tabs.jsDialogs.overlayContents.executeJavaScript(
          `JSON.stringify({
            title: document.getElementById('title')?.textContent || '',
            message: document.getElementById('message')?.textContent || '',
          })`,
          true,
        ),
        2000,
      )) || '';
      await shot('02b-alert', tabs.jsDialogs.overlayContents);
      await tabs.jsDialogs.overlayContents.executeJavaScript("document.getElementById('btn-ok')?.click()", true);
    }
    check('el dialogo muestra el mensaje del alert', /hola-orbit/.test(alertText), String(alertText));
    const alertClosed = await withTimeout(alertDone, 4000);
    check('aceptar cierra el alert y el script sigue', alertClosed === 'done' && !tabs.jsDialogs.isOpen(), String(alertClosed));

    const formStamp = Date.now();
    const formUrl = `https://forms.example/login-${formStamp}`;
    if (forms) {
      for (let i = 0; i < 4; i++) forms.noteVisit(formUrl);
      forms.record({ url: formUrl, field: 'email', value: 'yo@orbit.local' });
      forms.record({ url: formUrl, field: 'email', value: 'yo@orbit.local' });
      const hints = forms.suggest({ url: formUrl, field: 'email', prefix: 'yo' });
      check(
        'sugiere el texto repetido tras 4 visitas',
        Array.isArray(hints) && hints.some((h) => h.value === 'yo@orbit.local'),
        JSON.stringify(hints),
      );
      const fewUrl = `https://forms.example/once-${formStamp}`;
      forms.noteVisit(fewUrl);
      forms.noteVisit(fewUrl);
      forms.noteVisit(fewUrl);
      forms.record({ url: fewUrl, field: 'q', value: 'hola' });
      forms.record({ url: fewUrl, field: 'q', value: 'hola' });
      check('no sugiere con 3 visitas o menos', forms.suggest({ url: fewUrl, field: 'q', prefix: '' }).length === 0);
      forms.record({ url: formUrl, field: 'password', value: 'secreto123' });
      check(
        'no recuerda contrasenas',
        !forms.suggest({ url: formUrl, field: 'password', prefix: '', kind: 'password' }).some((h) => /secreto/.test(h.value)),
      );
      const userUrl = `https://forms.example/signin-${formStamp}`;
      forms.noteVisit(userUrl);
      forms.record({ url: userUrl, field: 'username', value: 'prody', kind: 'username' });
      check(
        'sugiere el usuario desde la primera vez',
        forms.suggest({ url: userUrl, field: 'username', prefix: '', kind: 'username' }).some((h) => h.value === 'prody'),
      );
    }

    const hasDlBtn = await window.webContents.executeJavaScript(
      "Boolean(document.getElementById('btn-downloads'))",
      true,
    );
    check('hay boton de descargas', hasDlBtn);

    if (downloads && alertPage) {
      try {
        alertPage.downloadURL(`data:text/plain,${encodeURIComponent('hola-orbit-dl')}`);
      } catch (err) {
        log(`downloadURL fallo: ${err.message}`);
      }
      const dlSeen = await waitFor(() => (downloads.snapshot().items || []).length > 0 || downloads.snapshot().busy, 8000);
      const dlSnap = downloads.snapshot();
      check(
        'una descarga aparece en el panel',
        dlSeen && (dlSnap.busy || dlSnap.items.length > 0),
        `${dlSnap.items.length} items · ${dlSnap.items[0]?.filename || ''} · ${dlSnap.items[0]?.state || ''} · ${dlSnap.percent}%`,
      );
    }

    const themeCss = activeTab?.view
      ? await withTimeout(
          activeTab.view.webContents.executeJavaScript(
            "getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()",
            true,
          ),
          3000,
        )
      : null;
    check('la pagina interna hereda el tema', Boolean(themeCss), `--accent = ${themeCss}`);

    await shot('01-shell', window.webContents);
    if (activeTab?.view) await shot('02-pagina-inicio', activeTab.view.webContents);

    // --- 3. navegacion real por la red ---
    const netTab = tabs.create('https://example.com', { active: true });
    const loaded = await waitFor(() => {
      const t = tabs.tabs.get(netTab);
      return t && !t.loading && /example\.com/.test(t.url);
    }, 15000);
    const netState = tabs.tabs.get(netTab);
    check('carga una pagina de internet', loaded && !netState.error, netState?.url ?? 'sin url');
    check('la pagina reporta titulo', Boolean(netState?.title), netState?.title ?? '');
    if (netState?.view) await shot('03-pagina-web', netState.view.webContents);
    await shot('04-shell-dos-pestanas', window.webContents);

    // --- 4. la barra de direcciones resuelve texto y urls ---
    check('texto suelto se convierte en busqueda', tabs._resolveInput('gatos').includes('duckduckgo'));
    check('un dominio se convierte en https', tabs._resolveInput('example.com') === 'https://example.com');
    check('una url se respeta', tabs._resolveInput('http://example.com/x') === 'http://example.com/x');

    // --- 5. dormir libera el proceso ---
    const beforeSleep = process.platform === 'win32' ? metrics.sample().totals : null;
    tabs.sleep(first.tabs[0].id);
    await waitFor(() => tabs.tabs.get(first.tabs[0].id)?.sleeping === true, 4000);
    const slept = tabs.tabs.get(first.tabs[0].id);
    check('dormir marca la pestana', slept?.sleeping === true);
    check('dormir destruye la vista nativa', slept?.view == null);
    check('dormir conserva la url', Boolean(slept?.url), slept?.url);

    await wait(900);
    const afterSleep = metrics.sample().totals;
    check(
      'las metricas cuentan la pestana dormida',
      afterSleep.sleepingTabs >= 1 && afterSleep.liveTabs < afterSleep.totalTabs,
      `${afterSleep.liveTabs} vivas / ${afterSleep.sleepingTabs} dormidas · ${afterSleep.memoryMB} MB`,
    );
    if (beforeSleep) log(`memoria antes ${beforeSleep.memoryMB} MB, despues ${afterSleep.memoryMB} MB`);

    // --- 6. despertar recupera la pagina ---
    tabs.activate(first.tabs[0].id);
    const woke = await waitFor(() => {
      const t = tabs.tabs.get(first.tabs[0].id);
      return t && !t.sleeping && Boolean(t.view) && !t.loading;
    }, 12000);
    check('despertar vuelve a cargar la pestana', woke);

    // --- 7. el tope de pestanas vivas se respeta ---
    settingsModule.patchSettings({ resources: { maxLiveTabs: 1 } });
    tabs.enforceLimits();
    await wait(1200);
    const live = [...tabs.tabs.values()].filter((t) => t.view).length;
    check('el tope de pestanas vivas se aplica', live <= 1, `${live} vivas con tope 1`);
    settingsModule.patchSettings({ resources: { maxLiveTabs: 8 } });

    // --- 8. el bloqueador esta activo ---
    const stats = blocker.stats();
    check('el bloqueador tiene reglas cargadas', stats.rules > 10, `${stats.rules} dominios`);
    log(`peticiones bloqueadas hasta ahora: ${stats.blockedCount}`);

    const netInBar = await window.webContents.executeJavaScript(
      `(() => {
        const net = document.getElementById('btn-network');
        const statsEl = document.getElementById('tab-stats');
        if (!net || !statsEl) return false;
        return Boolean(net.compareDocumentPosition(statsEl) & Node.DOCUMENT_POSITION_FOLLOWING);
      })()`,
      true,
    );
    check('el recuento de fetch esta a la izquierda de las pestañas vivas', netInBar);

    // --- 9. la UI responde: abrir el panel encoge el hueco de la pagina ---
    const widthBefore = tabs.pageBounds.width;
    await window.webContents.executeJavaScript("document.querySelector('#btn-panel').click()", true);
    await waitFor(() => tabs.pageBounds.width < widthBefore - 100, 4000);
    check(
      'abrir el panel reajusta la pagina',
      tabs.pageBounds.width < widthBefore - 100,
      `${widthBefore} -> ${tabs.pageBounds.width}`,
    );

    const widthOpen = tabs.pageBounds.width;
    await window.webContents.executeJavaScript("document.querySelector('#btn-panel').click()", true);
    const closed = await waitFor(() => tabs.pageBounds.width > widthOpen + 80, 4000);
    check(
      'el mismo boton cierra el panel',
      closed && tabs.pageBounds.width > widthOpen + 80,
      `${widthOpen} -> ${tabs.pageBounds.width}`,
    );
    await window.webContents.executeJavaScript("document.querySelector('#btn-panel').click()", true);
    await waitFor(() => tabs.pageBounds.width < widthBefore - 100, 4000);
    const widthOpenAgain = tabs.pageBounds.width;
    await window.webContents.executeJavaScript("document.querySelector('#btn-panel-close').click()", true);
    const closedByX = await waitFor(() => tabs.pageBounds.width > widthOpenAgain + 80, 4000);
    check(
      'la X del panel lo cierra',
      closedByX && tabs.pageBounds.width > widthOpenAgain + 80,
      `${widthOpenAgain} -> ${tabs.pageBounds.width}`,
    );
    await window.webContents.executeJavaScript("document.querySelector('#btn-panel').click()", true);
    await waitFor(() => tabs.pageBounds.width < widthBefore - 100, 4000);

    await wait(1500);
    await shot('05-panel-recursos', window.webContents);

    // --- 10. cambiar de seccion en el panel no rompe la UI ---
    for (const [index, name] of [[1, 'apariencia'], [2, 'navegacion'], [3, 'sistema']]) {
      await window.webContents.executeJavaScript(
        `document.querySelectorAll('.panel-tab')[${index}].click()`,
        true,
      );
      await wait(500);
      const rendered = await window.webContents.executeJavaScript(
        "document.querySelectorAll('#panel-body .section').length",
        true,
      );
      check(`la seccion ${name} se dibuja`, rendered > 0, `${rendered} bloques`);
      await shot(`06-panel-${name}`, window.webContents);
    }

    // --- 11. la apariencia se aplica en vivo ---
    await window.webContents.executeJavaScript(
      "document.querySelectorAll('.panel-tab')[1].click()",
      true,
    );
    await wait(400);
    const applied = await window.webContents.executeJavaScript(
      `(() => {
        const r = document.documentElement.style;
        return { radius: r.getPropertyValue('--radius'), alpha: r.getPropertyValue('--alpha-shell'), inset: r.getPropertyValue('--inset') };
      })()`,
      true,
    );
    check(
      'el tema escribe variables CSS',
      Boolean(applied.radius && applied.alpha),
      JSON.stringify(applied),
    );

    const neonClicked = await window.webContents.executeJavaScript(
      `(() => {
        const card = [...document.querySelectorAll('.theme-card')].find((el) => /ne[oó]n rojo/i.test(el.textContent));
        if (!card) return false;
        card.click();
        return true;
      })()`,
      true,
    );
    await wait(700);
    const glow = await window.webContents.executeJavaScript(
      "document.documentElement.style.getPropertyValue('--glow-strength').trim()",
      true,
    );
    check('el tema neon rojo existe y se aplica', neonClicked && glow === '18px', `glow=${glow}`);
    await shot('07-tema-neon-rojo', window.webContents);

    const moved = await window.webContents.executeJavaScript(
      `(() => {
        const select = [...document.querySelectorAll('select')].find((el) =>
          [...el.options].some((o) => o.value === 'left'),
        );
        if (!select) return false;
        select.value = 'left';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
      true,
    );
    await wait(700);
    const railHidden = await window.webContents.executeJavaScript(
      "document.getElementById('tabs-host-side')?.hidden === false && document.body.classList.contains('tabs-side')",
      true,
    );
    check('las pestanas se pueden mover a un lado', moved && railHidden);
    const widthSide = tabs.pageBounds.width;
    await window.webContents.executeJavaScript(
      "document.documentElement.style.setProperty('--tab-rail', '320px')",
      true,
    );
    const widened = await waitFor(() => tabs.pageBounds.width < widthSide - 60, 4000);
    check(
      'el rail izquierdo se puede ensanchar',
      widened && tabs.pageBounds.width < widthSide - 60,
      `${widthSide} -> ${tabs.pageBounds.width}`,
    );
    const widthWide = tabs.pageBounds.width;
    await window.webContents.executeJavaScript(
      `(() => {
        document.documentElement.style.setProperty('--tab-rail', '52px');
        document.body.classList.add('tabs-compact');
      })()`,
      true,
    );
    const compacted = await waitFor(() => tabs.pageBounds.width > widthWide + 80, 4000);
    const titlesHidden = await window.webContents.executeJavaScript(
      `(() => {
        const title = document.querySelector('.tabs-host-side .tab-title');
        return !title || getComputedStyle(title).display === 'none';
      })()`,
      true,
    );
    check(
      'el rail se puede dejar en solo iconos',
      compacted && titlesHidden,
      `${widthWide} -> ${tabs.pageBounds.width}`,
    );
    await shot('08-pestanas-izquierda', window.webContents);
    await window.webContents.executeJavaScript(
      `(() => {
        const select = [...document.querySelectorAll('select')].find((el) =>
          [...el.options].some((o) => o.value === 'top'),
        );
        if (!select) return;
        select.value = 'top';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`,
      true,
    );
    await wait(400);

    await window.webContents.executeJavaScript(
      `([...document.querySelectorAll('.theme-card')].find((el) => /noche/i.test(el.textContent)) || document.querySelector('.theme-card'))?.click()`,
      true,
    );
    await wait(400);

    // --- 12. la ventana es de verdad translucida ---
    if (windowMode === 'transparent') {
      const image = await withTimeout(window.webContents.capturePage(), 6000);
      if (image) {
        const size = image.getSize();
        const bitmap = image.toBitmap(); // BGRA
        const alphaAt = (x, y) => bitmap[(y * size.width + x) * 4 + 3];
        // La esquina de una ventana redondeada queda fuera de la forma: si la
        // ventana tiene canal alfa, ese pixel es transparente.
        const corner = alphaAt(0, 0);
        const middle = alphaAt(Math.floor(size.width / 2), 4);
        check(
          'la ventana tiene canal alfa (esquina transparente)',
          corner < 128 && middle > 128,
          `alfa esquina ${corner}, alfa barra ${middle}`,
        );
      }
    }

    // --- 13. los atajos de teclado estan conectados ---
    const tabsBefore = tabs.order.length;
    await window.webContents.executeJavaScript(
      "window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true }))",
      true,
    );
    const opened = await waitFor(() => tabs.order.length === tabsBefore + 1, 4000);
    check('Ctrl+T abre una pestana', opened, `${tabsBefore} -> ${tabs.order.length}`);

    // --- 13b. los popups de OAuth conservan window.opener ---
    const page = tabs.tabs.get(tabs.activeId)?.view?.webContents;
    if (page && !page.isDestroyed()) {
      const shellsBefore = new Set(host ? host.list().map((s) => s.window.id) : [window.id]);
      const beforePopups = BrowserWindow.getAllWindows().length;
      const openerOk = await withTimeout(
        page.executeJavaScript(
          `(() => {
            const w = window.open('about:blank', 'orbit_oauth_test', 'width=420,height=520');
            return Boolean(w && w.opener === window);
          })()`,
          true,
        ),
        4000,
      );
      check('window.open conserva window.opener', openerOk === true, String(openerOk));
      const popped = await waitFor(() => BrowserWindow.getAllWindows().length > beforePopups, 4000);
      check('window.open con tamano abre un popup', popped, `${BrowserWindow.getAllWindows().length} ventanas`);
      for (const extra of BrowserWindow.getAllWindows()) {
        if (extra.isDestroyed()) continue;
        if (extra.id === window.id || shellsBefore.has(extra.id)) continue;
        extra.close();
      }
    }

    // --- 14. los ajustes llegan al disco ---
    const settingsFile = path.join(app.getPath('userData'), 'settings.json');
    settingsModule.patchSettings({ appearance: { radius: 21 } });
    settingsModule.saveSettingsNow();
    const onDisk = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    check('los ajustes se guardan en disco', onDisk.appearance?.radius === 21, `radius = ${onDisk.appearance?.radius}`);
    settingsModule.patchSettings({ appearance: { radius: 14 } });
    settingsModule.saveSettingsNow();

    const { storeSource } = require('./source-view');
    const sourceToken = storeSource({ url: 'https://example.com/', html: '<html><body>fuente-orbit</body></html>' });
    const srcId = tabs.create(`orbit://source/${sourceToken}`, { active: true });
    const srcOk = await waitFor(() => {
      const t = tabs.tabs.get(srcId);
      return Boolean(t && !t.loading && !t.error && /orbit:\/\/source\//.test(t.url));
    }, 8000);
    const srcText = srcOk
      ? await withTimeout(tabs.tabs.get(srcId).view.webContents.executeJavaScript('document.body.innerText', true), 3000)
      : '';
    check('el visor de fuente muestra el documento', Boolean(srcOk && /fuente-orbit/.test(srcText || '')), String(srcText).slice(0, 80));

    // --- 16. arrastrar una pestana fuera abre otra ventana ---
    if (host) {
      const beforeWindows = host.list().length;
      const extraId = tabs.create('https://example.com/', { active: true });
      await waitFor(() => {
        const t = tabs.tabs.get(extraId);
        return t && !t.loading && /example\.com/.test(t.url);
      }, 12000);
      const bounds = window.getBounds();
      host.tearOff(host.list().find((s) => s.window === window) ?? host.list()[0], extraId, {
        x: bounds.x + bounds.width + 80,
        y: bounds.y + 48,
      });
      const torn = await waitFor(() => host.list().length === beforeWindows + 1, 6000);
      check('separar una pestana abre otra ventana', torn, `${host.list().length} ventanas`);
      const other = host.list().find((s) => s.window !== window);
      check('la pestana vive en la ventana nueva', Boolean(other?.tabs.order.length), `${other?.tabs.order.length ?? 0} pestanas`);
      check('la ventana original conserva pestanas', tabs.order.length >= 1, `${tabs.order.length} pestanas`);
      if (other && !other.window.isDestroyed()) other.window.close();
      await waitFor(() => host.list().length === beforeWindows, 4000);
    }

    // --- 15. errores de consola en la UI ---
    check('la UI no dejo errores en consola', consoleErrors.length === 0, consoleErrors.join(' | ') || 'ninguno');
  } catch (err) {
    check('el recorrido termino sin excepciones', false, err.stack ?? String(err));
  }

  const summary = `${fails.length ? `FALLOS: ${fails.length}` : 'TODO OK'} (${report.length} comprobaciones)`;
  log(summary);
  fs.writeFileSync(path.join(outDir, 'informe.txt'), `${report.join('\n')}\n`, 'utf8');
  console.log(`[smoke] informe en ${path.join(outDir, 'informe.txt')}`);

  app.exit(fails.length ? 1 : 0);
}

const consoleErrors = [];

/** Recoge errores de la consola del renderer para incluirlos en el informe. */
function watchConsole(window) {
  window.webContents.on('console-message', (event) => {
    const level = event.level ?? event;
    const message = event.message ?? '';
    if (level === 'error' || level === 3) consoleErrors.push(message.slice(0, 200));
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cierra pestanas y ventanas de tandas anteriores y deja solo el inicio. */
async function resetWorkspace({ tabs, host, window }) {
  if (host) {
    for (const extra of host.list()) {
      if (extra.window !== window && !extra.window.isDestroyed()) extra.window.close();
    }
  }
  const start = settingsModule.getSettings().browsing.startPage;
  for (const id of [...tabs.order]) tabs.close(id);
  tabs.create(start, { active: true });
  await waitFor(() => {
    const t = tabs.tabs.get(tabs.activeId);
    return Boolean(t?.view && !t.loading && /orbit:\/\/start/i.test(t.url || ''));
  }, 8000);
}

/** Resuelve a `null` si la promesa tarda mas de `ms`. */
function withTimeout(promise, ms) {
  return Promise.race([promise, wait(ms).then(() => null)]);
}

async function waitFor(predicate, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(150);
  }
  return false;
}

module.exports = { runSmoke, watchConsole };
