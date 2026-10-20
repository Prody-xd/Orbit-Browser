import { h, clear } from './dom.js';
import { icons } from './icons.js';

/**
 * Barra de pestanas.
 *
 * Reconstruye solo cuando cambia algo visible. El proceso principal ya agrupa
 * las rafagas de eventos de Chromium, asi que aqui basta con comparar una firma
 * del estado para no repintar en cada tecleo de una pagina que carga.
 */
export function createTabstrip(container) {
  let signature = '';

  function render(snapshot) {
    const next = snapshot.tabs
      .map((t) => `${t.id}:${t.title}:${t.favicon ?? ''}:${t.loading}:${t.sleeping}:${t.pinned}:${t.audible}:${t.muted}`)
      .join('|') + `#${snapshot.activeId}`;
    if (next === signature) return;
    signature = next;

    clear(container);
    for (const tab of snapshot.tabs) container.append(tabNode(tab, snapshot.activeId));
  }

  function tabNode(tab, activeId) {
    const classes = ['tab'];
    if (tab.id === activeId) classes.push('active');
    if (tab.sleeping) classes.push('sleeping');
    if (tab.pinned) classes.push('pinned');
    if (tab.audible) classes.push('audible');
    if (tab.muted) classes.push('muted');

    const favicon = h('div.tab-favicon', { class: tab.loading ? 'spin' : null }, [
      tab.favicon ? h('img', { src: tab.favicon, on: { error: (e) => e.target.remove() } }) : h('div.dot'),
    ]);

    return h(
      'div',
      {
        class: classes.join(' '),
        title: tab.sleeping ? `${tab.title} — dormida, sin proceso\n${tab.url}` : `${tab.title}\n${tab.url}`,
        on: {
          pointerdown: (event) => beginTearOff(event, tab),
          click: (event) => {
            if (event.currentTarget.dataset.tore === '1') {
              delete event.currentTarget.dataset.tore;
              return;
            }
            window.orbit.tabs.activate(tab.id);
          },
          auxclick: (event) => {
            // Clic con la rueda cierra, como en cualquier navegador.
            if (event.button === 1) {
              event.preventDefault();
              window.orbit.tabs.close(tab.id);
            }
          },
          contextmenu: (event) => {
            event.preventDefault();
            window.orbit.tabs.menu(tab.id);
          },
        },
      },
      [
        favicon,
        h('div.tab-title', { text: tab.title }),
        h('button.tab-mute', {
          html: tab.muted ? icons.speakerOff : icons.speaker,
          title: tab.muted ? 'Activar sonido' : 'Silenciar esta pestaña',
          on: {
            click: (event) => {
              event.stopPropagation();
              window.orbit.tabs.mute(tab.id, !tab.muted);
            },
          },
        }),
        tab.sleeping ? h('div.tab-badge', { text: 'z', title: 'Dormida: no gasta memoria' }) : null,
        h('button.tab-close', {
          html: icons.close,
          title: 'Cerrar (Ctrl+W)',
          on: {
            click: (event) => {
              event.stopPropagation();
              window.orbit.tabs.close(tab.id);
            },
          },
        }),
      ],
    );
  }

  return { render };
}

const TEAR_PX = 10;

function beginTearOff(event, tab) {
  if (event.button !== 0) return;
  if (event.target.closest?.('.tab-close, .tab-mute')) return;

  window.orbit.tabs.activate(tab.id);

  const el = event.currentTarget;
  const startX = event.clientX;
  const startY = event.clientY;
  let tearing = false;

  const onMove = (moveEvent) => {
    if (tearing) return;
    const dx = moveEvent.clientX - startX;
    const dy = moveEvent.clientY - startY;
    if (Math.hypot(dx, dy) < TEAR_PX) return;
    tearing = true;
    el.classList.add('tearing');
    document.body.classList.add('tearing-tab');
    try {
      el.setPointerCapture(moveEvent.pointerId);
    } catch {
      /* captura no disponible */
    }
    window.orbit.layout.ignorePageMouse(true);
  };

  const finish = (upEvent) => {
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', finish);
    el.removeEventListener('pointercancel', finish);
    if (!tearing) return;
    el.dataset.tore = '1';
    el.classList.remove('tearing');
    document.body.classList.remove('tearing-tab');
    window.orbit.layout.ignorePageMouse(false);
    if (upEvent.type === 'pointercancel') return;
    const force = leftTheStrip(el, upEvent) || outsideTheWindow(upEvent);
    window.orbit.tabs.detach(tab.id, { x: upEvent.screenX, y: upEvent.screenY, force });
  };

  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
}

function leftTheStrip(el, event) {
  const strip = el.closest('.tabstrip');
  if (!strip) return true;
  const r = strip.getBoundingClientRect();
  const pad = 28;
  return event.clientX < r.left - pad || event.clientX > r.right + pad || event.clientY < r.top - pad || event.clientY > r.bottom + pad;
}

function outsideTheWindow(event) {
  return event.clientX < 0 || event.clientY < 0 || event.clientX > window.innerWidth || event.clientY > window.innerHeight;
}
