'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
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
async function runSmoke({ window, tabs, metrics, blocker, windowMode }) {
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
    await wait(1800);

    // --- 1. la cascara y la primera pestana existen ---
    const first = tabs.snapshot();
    check('la ventana abre con una pestana', first.tabs.length >= 1, `${first.tabs.length} pestanas`);
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

    // --- 9. la UI responde: abrir el panel encoge el hueco de la pagina ---
    const widthBefore = tabs.pageBounds.width;
    await window.webContents.executeJavaScript("document.querySelector('#btn-panel').click()", true);
    await waitFor(() => tabs.pageBounds.width < widthBefore - 100, 4000);
    check(
      'abrir el panel reajusta la pagina',
      tabs.pageBounds.width < widthBefore - 100,
      `${widthBefore} -> ${tabs.pageBounds.width}`,
    );
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

    // --- 14. los ajustes llegan al disco ---
    const settingsFile = path.join(app.getPath('userData'), 'settings.json');
    settingsModule.patchSettings({ appearance: { radius: 21 } });
    settingsModule.saveSettingsNow();
    const onDisk = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    check('los ajustes se guardan en disco', onDisk.appearance?.radius === 21, `radius = ${onDisk.appearance?.radius}`);
    settingsModule.patchSettings({ appearance: { radius: 14 } });
    settingsModule.saveSettingsNow();

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
