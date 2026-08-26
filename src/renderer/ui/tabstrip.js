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
          click: () => window.orbit.tabs.activate(tab.id),
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
