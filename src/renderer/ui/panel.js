import { h, clear, row, toggle, slider, select, formatMB } from './dom.js';
import { applyTheme, themeSwatch } from './theme.js';

const SECTIONS = [
  ['recursos', 'Recursos'],
  ['apariencia', 'Apariencia'],
  ['navegacion', 'Navegación'],
  ['sistema', 'Sistema'],
];

/**
 * Panel de ajustes.
 *
 * Dos reglas de diseño que se notan al usarlo:
 *
 * 1. Nada se re-renderiza mientras arrastras un deslizador. Los cambios
 *    continuos (opacidad, radio, minutos) actualizan variables CSS y su propia
 *    etiqueta, y nada más. Reconstruir el panel en cada evento `input` haría
 *    que personalizar se sintiera lento, que es justo lo que hay que evitar.
 *
 * 2. Los ajustes se agrupan por cuándo surten efecto: ahora, en la próxima
 *    pestaña, o al reiniciar. Chromium lee algunos parámetros una sola vez al
 *    arrancar, y fingir lo contrario solo confunde.
 */
export function createPanel({ container, tabsEl, state, onSectionChange, onLayoutChange }) {
  let section = 'recursos';
  let metricsBox = null;
  let sample = null;
  const pendingRestart = new Set();

  tabsEl.replaceChildren(
    ...SECTIONS.map(([id, label]) =>
      h('button.panel-tab', {
        text: label,
        dataset: { section: id },
        on: {
          click: () => {
            section = id;
            render();
          },
        },
      }),
    ),
  );

  function syncTabs() {
    for (const button of tabsEl.children) {
      button.classList.toggle('active', button.dataset.section === section);
    }
  }

  // --- escritura de ajustes ---

  /** Cambia ajustes sin reconstruir el panel (para deslizadores). */
  async function patchQuiet(patch) {
    const result = await window.orbit.settings.patch(patch);
    for (const key of result.restartNeeded) pendingRestart.add(key);
    return result;
  }

  /** Cambia ajustes y repinta (para interruptores y selectores). */
  async function patchAndRender(patch) {
    await patchQuiet(patch);
    render();
  }

  function appearance(key, value) {
    state.settings.appearance[key] = value;
    applyTheme(currentTheme(), state.settings.appearance, state.visuals);
    return patchQuiet({ appearance: { [key]: value } });
  }

  function currentTheme() {
    return state.themes.find((t) => t.id === state.settings.appearance.theme) ?? state.themes[0];
  }

  // ------------------------------------------------------------------ render

  function render() {
    syncTabs();
    clear(container);
    if (pendingRestart.size) mount(container, restartBanner());

    if (section === 'recursos') renderRecursos();
    else if (section === 'apariencia') renderApariencia();
    else if (section === 'navegacion') renderNavegacion();
    else renderSistema();

    onSectionChange?.(section);
  }

  function restartBanner() {
    return h('div.banner', {}, [
      h('span', {
        text: 'Hay ajustes del motor que solo se aplican al arrancar. Reinicia para activarlos.',
      }),
      h('button.btn.primary', { text: 'Reiniciar', on: { click: () => window.orbit.app.restart() } }),
    ]);
  }

  // --- Recursos ---

  function renderRecursos() {
    const r = state.settings.resources;

    mount(
      container,
      h('div.section', {}, [
        h('div.section-title', { text: 'Perfil' }),
        h(
          'div.profiles',
          {},
          Object.entries(state.profiles).map(([id, profile]) =>
            h(
              'button',
              {
                class: `profile${r.profile === id ? ' active' : ''}`,
                on: {
                  click: async () => {
                    const result = await window.orbit.settings.applyProfile(id);
                    for (const key of result.restartNeeded) pendingRestart.add(key);
                    state.settings = result.settings;
                    render();
                  },
                },
              },
              [h('b', { text: profile.label }), h('small', { text: profile.description })],
            ),
          ),
        ),
        h('div.profile-note', {
          text:
            r.profile === 'custom'
              ? 'Perfil propio: has cambiado valores a mano.'
              : (state.profiles[r.profile]?.description ?? ''),
        }),
      ]),
    );

    metricsBox = h('div.section');
    mount(container, metricsBox);
    renderMetrics();

    mount(
      container,
      h('div.section', {}, [
        h('div.section-title', { text: 'Suspensión de pestañas · efecto inmediato' }),

        row(
          'Dormir pestañas inactivas',
          'Libera el proceso completo de la pestaña. Al volver se recarga y se recupera el scroll.',
          toggle(r.sleepEnabled, (value) => patchAndRender({ resources: { sleepEnabled: value, profile: 'custom' } })),
        ),

        r.sleepEnabled
          ? liveRow({
              label: 'Dormir después de',
              description: 'Tiempo sin usar una pestaña antes de suspenderla.',
              min: 1,
              max: 120,
              value: r.sleepAfterMinutes,
              format: (v) => `${v} min`,
              apply: (v) => patchQuiet({ resources: { sleepAfterMinutes: v, profile: 'custom' } }),
              onLocal: (v) => (r.sleepAfterMinutes = v),
            })
          : null,

        liveRow({
          label: 'Máximo de pestañas vivas',
          description: 'Al pasar del tope, se duerme la menos usada. 0 = sin límite.',
          min: 0,
          max: 30,
          value: r.maxLiveTabs,
          format: (v) => (v === 0 ? 'sin tope' : String(v)),
          apply: (v) => patchQuiet({ resources: { maxLiveTabs: v, profile: 'custom' } }),
          onLocal: (v) => (r.maxLiveTabs = v),
        }),

        row(
          'No dormir si suena audio',
          'Evita cortar música o vídeo en segundo plano.',
          toggle(r.keepAudibleAwake, (value) =>
            patchAndRender({ resources: { keepAudibleAwake: value, profile: 'custom' } }),
          ),
        ),

        row(
          'No dormir pestañas fijadas',
          'Útil si tienes correo o chat siempre abiertos.',
          toggle(r.keepPinnedAwake, (value) =>
            patchAndRender({ resources: { keepPinnedAwake: value, profile: 'custom' } }),
          ),
        ),

        h('button.btn.wide', {
          text: 'Dormir todas menos la actual',
          on: {
            click: async () => {
              const count = await window.orbit.tabs.sleepOthers();
              renderMetrics(count ? `${count} pestañas dormidas.` : 'No había ninguna que dormir.');
            },
          },
        }),
      ]),
    );

    mount(
      container,
      h('div.section', {}, [
        h('div.section-title', { text: 'Páginas nuevas · afecta a la próxima pestaña' }),

        row(
          'Frenar pestañas en segundo plano',
          'Chromium ralentiza timers y animaciones de lo que no estás viendo.',
          toggle(r.backgroundThrottle, (value) =>
            patchAndRender({ resources: { backgroundThrottle: value, profile: 'custom' } }),
          ),
        ),

        row(
          'Animación de imágenes',
          'Los GIF y PNG animados gastan CPU sin que lo notes.',
          select(
            [
              ['allowed', 'Permitir'],
              ['animateOnce', 'Una vez'],
              ['noAnimation', 'Congelar'],
            ],
            r.imageAnimationPolicy,
            (value) => patchAndRender({ resources: { imageAnimationPolicy: value, profile: 'custom' } }),
          ),
        ),
      ]),
    );

    mount(
      container,
      h('div.section', {}, [
        h('div.section-title', { text: 'Motor Chromium · requiere reiniciar' }),

        row(
          'Aceleración por hardware',
          'Apagarla baja el uso de GPU y VRAM, pero el desplazamiento y el vídeo van peor.',
          toggle(r.hardwareAcceleration, (value) =>
            patchAndRender({ resources: { hardwareAcceleration: value, profile: 'custom' } }),
          ),
        ),

        r.hardwareAcceleration
          ? row(
              'Rasterizar en GPU',
              'Apagado pinta en CPU: menos VRAM, más trabajo para el procesador.',
              toggle(r.gpuRasterization, (value) =>
                patchAndRender({ resources: { gpuRasterization: value, profile: 'custom' } }),
              ),
            )
          : null,

        liveRow({
          label: 'Límite de procesos de renderer',
          description:
            'Menos procesos gastan menos RAM, pero las pestañas comparten destino: si una cae, caen sus vecinas.',
          min: 0,
          max: 16,
          value: r.rendererProcessLimit,
          format: (v) => (v === 0 ? 'automático' : String(v)),
          apply: (v) => patchQuiet({ resources: { rendererProcessLimit: v, profile: 'custom' } }),
          onLocal: (v) => (r.rendererProcessLimit = v),
        }),

        liveRow({
          label: 'Tope de memoria JS por pestaña',
          description: 'Corta páginas que se descontrolan. Demasiado bajo y las aplicaciones web se rompen.',
          min: 0,
          max: 4096,
          step: 128,
          value: r.jsHeapMB,
          format: (v) => (v === 0 ? 'por defecto' : `${v} MB`),
          apply: (v) => patchQuiet({ resources: { jsHeapMB: v, profile: 'custom' } }),
          onLocal: (v) => (r.jsHeapMB = v),
        }),

        liveRow({
          label: 'Caché en disco',
          description: 'Más caché significa menos red y menos espera al volver a un sitio.',
          min: 0,
          max: 4096,
          step: 128,
          value: r.diskCacheMB,
          format: (v) => (v === 0 ? 'por defecto' : `${v} MB`),
          apply: (v) => patchQuiet({ resources: { diskCacheMB: v, profile: 'custom' } }),
          onLocal: (v) => (r.diskCacheMB = v),
        }),
      ]),
    );

    mount(
      container,
      h('div.section', {}, [
        h('div.section-title', { text: 'Medición' }),
        liveRow({
          label: 'Intervalo de muestreo',
          description: 'Solo se mide mientras este panel está abierto. Al cerrarlo, el muestreo se detiene.',
          min: 500,
          max: 10000,
          step: 500,
          value: r.metricsIntervalMs,
          format: (v) => `${(v / 1000).toFixed(1)} s`,
          apply: (v) => patchQuiet({ resources: { metricsIntervalMs: v } }),
          onLocal: (v) => (r.metricsIntervalMs = v),
        }),
      ]),
    );
  }

  function renderMetrics(note) {
    if (!metricsBox) return;
    clear(metricsBox);

    if (!sample) {
      mount(metricsBox, h('div.section-title', { text: 'Consumo' }), h('div.hint', { text: 'Midiendo…' }));
      return;
    }

    const { totals, system, byTab } = sample;
    const max = byTab[0]?.memoryMB || 1;
    const tabsById = new Map(state.tabs.tabs.map((t) => [t.id, t]));

    mount(
      metricsBox,
      h('div.section-title', { text: 'Consumo ahora' }),
      h('div.gauges', {}, [
        gauge(formatMB(totals.memoryMB), 'memoria del navegador'),
        gauge(`${totals.cpu.toFixed(1)} %`, `CPU · ${system.cores} núcleos`),
        gauge(String(totals.processes), 'procesos de Chromium'),
        gauge(`${totals.liveTabs} / ${totals.totalTabs}`, `vivas · ${totals.sleepingTabs} dormidas`),
      ]),
      note ? h('div.hint', { text: note }) : null,
      h('div.hint', {
        text: `Sistema: ${formatMB(system.totalMemoryMB - system.freeMemoryMB)} en uso de ${formatMB(system.totalMemoryMB)}.`,
      }),
    );

    if (byTab.length) {
      mount(
        metricsBox,
        h('div.section-title', { text: 'Por pestaña', style: { marginTop: '14px' } }),
        h(
          'div.proc-list',
          {},
          byTab.map((entry) => {
            const tab = tabsById.get(entry.id);
            return h('div.proc', {}, [
              h('div.proc-name', {
                text: tab?.title ?? `Pestaña ${entry.id}`,
                title: `${tab?.url ?? ''}\nPID ${entry.pid} · ${entry.cpu.toFixed(1)} % CPU`,
              }),
              h('div.proc-bar', {}, [
                h('span', { style: { width: `${Math.round((entry.memoryMB / max) * 100)}%` } }),
              ]),
              h('div.proc-mem', { text: formatMB(entry.memoryMB) }),
              h('button.proc-sleep', {
                text: 'z',
                title: 'Dormir esta pestaña',
                on: { click: () => window.orbit.tabs.sleep(entry.id) },
              }),
            ]);
          }),
        ),
      );
    }
  }

  // --- Apariencia ---

  function renderApariencia() {
    const a = state.settings.appearance;
    const supportsMaterial = state.visuals.supportsBackgroundMaterial;

    mount(
      container,
      h('div.section', {}, [
        h('div.section-title', { text: 'Tema' }),
        h(
          'div.theme-grid',
          {},
          state.themes.map((theme) =>
            h(
              'button',
              {
                class: `theme-card${theme.id === a.theme ? ' active' : ''}`,
                on: {
                  click: async () => {
                    a.theme = theme.id;
                    // El acento guardado pisa el del tema. Al elegir un tema
                    // nuevo, el acento viaja con el: si no, Neón rojo se vería
                    // con el azul del tema anterior.
                    if (theme.colors?.accent) a.accent = theme.colors.accent;
                    applyTheme(theme, a, state.visuals);
                    await patchQuiet({
                      appearance: { theme: theme.id, accent: a.accent },
                    });
                    render();
                  },
                },
              },
              [
                h('div.theme-swatch', { style: { background: themeSwatch(theme) } }),
                h('div.theme-card-name', {}, [
                  theme.name ?? theme.id,
                  theme.source === 'user' ? h('small', { text: ' propio' }) : null,
                ]),
              ],
            ),
          ),
        ),
        h('div.row', {}, [
          h('button.btn', {
            text: 'Abrir carpeta de temas',
            on: { click: () => window.orbit.themes.openFolder() },
          }),
          h('button.btn', {
            text: 'Duplicar este tema',
            on: {
              click: async () => {
                const base = currentTheme();
                const copy = {
                  ...base,
                  id: `${base.id}-copia`,
                  name: `${base.name ?? base.id} (copia)`,
                  colors: { ...base.colors, accent: a.accent },
                };
                await window.orbit.themes.save(copy);
                state.themes = await window.orbit.themes.list();
                render();
              },
            },
          }),
        ]),
        h('div.hint', {
          text: 'Los temas son archivos JSON. Edita uno, guarda y vuelve a elegirlo para ver el cambio.',
        }),
      ]),
    );

    mount(
      container,
      h('div.section', {}, [
        h('div.section-title', { text: 'Vidrio y transparencia' }),

        row(
          'Superficie',
          supportsMaterial
            ? 'Acrílico usa el desenfoque del sistema. Translúcido usa canal alfa.'
            : `Tu sistema (${state.visuals.osLabel}) no expone desenfoque del escritorio: translúcido se ve a través, sin difuminar.`,
          select(
            [
              ['translucent', 'Translúcido'],
              ['opaque', 'Opaco'],
              ...(supportsMaterial ? [['acrylic', 'Acrílico del sistema']] : []),
            ],
            a.surface,
            async (value) => {
              a.surface = value;
              applyTheme(currentTheme(), a, state.visuals);
              await patchQuiet({ appearance: { surface: value } });
              // El tipo de ventana se decide al crearla: cambiar de opaco a
              // translúcido necesita una ventana nueva.
              pendingRestart.add('surface');
              render();
            },
          ),
        ),

        a.surface !== 'opaque'
          ? liveRow({
              label: 'Opacidad del fondo',
              description: 'Cuánto se ve del escritorio detrás de la ventana.',
              min: 0.3,
              max: 1,
              step: 0.02,
              value: a.shellOpacity,
              format: (v) => `${Math.round(v * 100)} %`,
              apply: (v) => appearance('shellOpacity', v),
              onLocal: (v) => (a.shellOpacity = v),
            })
          : null,

        a.surface !== 'opaque'
          ? liveRow({
              label: 'Opacidad de las barras',
              description: 'Barra de pestañas, navegación y este panel.',
              min: 0.3,
              max: 1,
              step: 0.02,
              value: a.chromeOpacity,
              format: (v) => `${Math.round(v * 100)} %`,
              apply: (v) => appearance('chromeOpacity', v),
              onLocal: (v) => (a.chromeOpacity = v),
            })
          : null,

        a.surface !== 'opaque'
          ? liveRow({
              label: 'Desenfoque interno',
              description: 'Difumina lo que queda detrás de las barras dentro de la ventana.',
              min: 0,
              max: 40,
              value: a.chromeBlur,
              format: (v) => `${v} px`,
              apply: (v) => appearance('chromeBlur', v),
              onLocal: (v) => (a.chromeBlur = v),
            })
          : null,
      ]),
    );

    mount(
      container,
      h('div.section', {}, [
        h('div.section-title', { text: 'Forma y color' }),

        row(
          'Pestañas',
          'Arriba es la barra clásica. A un lado, arrastra el borde hasta dejar solo el icono. El hueco vacío mueve la ventana.',
          select(
            [
              ['top', 'Arriba'],
              ['left', 'Izquierda'],
              ['right', 'Derecha'],
            ],
            a.tabStrip ?? 'top',
            async (value) => {
              a.tabStrip = value;
              await patchQuiet({ appearance: { tabStrip: value } });
              onLayoutChange?.();
              render();
            },
          ),
        ),

        row(
          'Color de acento',
          'Sobrescribe el acento del tema.',
          h('input', {
            type: 'color',
            value: a.accent,
            on: { input: (event) => appearance('accent', event.target.value) },
          }),
        ),

        liveRow({
          label: 'Redondeo',
          min: 0,
          max: 28,
          value: a.radius,
          format: (v) => `${v} px`,
          apply: (v) => appearance('radius', v),
          onLocal: (v) => (a.radius = v),
        }),

        row(
          'Página flotante',
          'Deja un margen alrededor del contenido para que se vea el fondo.',
          toggle(a.floatingPage, async (value) => {
            a.floatingPage = value;
            applyTheme(currentTheme(), a, state.visuals);
            await patchQuiet({ appearance: { floatingPage: value } });
            render();
          }),
        ),

        a.floatingPage
          ? liveRow({
              label: 'Margen',
              min: 0,
              max: 40,
              value: a.pageInset,
              format: (v) => `${v} px`,
              apply: (v) => appearance('pageInset', v),
              onLocal: (v) => (a.pageInset = v),
            })
          : null,

        liveRow({
          label: 'Tamaño de la interfaz',
          description: 'Escala el texto del navegador, no el de las páginas.',
          min: 0.85,
          max: 1.35,
          step: 0.05,
          value: a.fontScale,
          format: (v) => `${Math.round(v * 100)} %`,
          apply: (v) => appearance('fontScale', v),
          onLocal: (v) => (a.fontScale = v),
        }),
      ]),
    );
  }

  // --- Navegación ---

  function renderNavegacion() {
    const b = state.settings.browsing;

    mount(
      container,
      h('div.section', {}, [
        h('div.section-title', { text: 'Inicio y búsqueda' }),

        row(
          'Página de inicio',
          null,
          h('input.text-input', {
            type: 'text',
            value: b.startPage,
            on: {
              change: (event) => {
                b.startPage = event.target.value;
                patchQuiet({ browsing: { startPage: event.target.value } });
              },
            },
          }),
        ),

        row(
          'Buscador',
          'Usa %s donde va el texto buscado.',
          h('input.text-input', {
            type: 'text',
            value: b.searchTemplate,
            on: {
              change: (event) => {
                b.searchTemplate = event.target.value;
                patchQuiet({ browsing: { searchTemplate: event.target.value } });
              },
            },
          }),
        ),
      ]),
    );

    mount(
      container,
      h('div.section', {}, [
        h('div.section-title', { text: 'Sesión' }),
        row(
          'Restaurar pestañas al abrir',
          null,
          toggle(b.restoreSession, (value) => patchAndRender({ browsing: { restoreSession: value } })),
        ),
        b.restoreSession
          ? row(
              'Restaurar dormidas',
              'Las pestañas vuelven sin proceso: abrir veinte cuesta lo mismo que abrir una.',
              toggle(b.restoreAsleep, (value) => patchAndRender({ browsing: { restoreAsleep: value } })),
            )
          : null,
        row(
          'Recordar lo escrito en formularios',
          'Sugiere usuarios y correos al volver. El resto de campos, si entras más de 3 veces y escribes lo mismo. Nunca contraseñas.',
          toggle(b.rememberForms !== false, (value) => patchAndRender({ browsing: { rememberForms: value } })),
        ),
      ]),
    );

    const stats = state.blockerStats;
    mount(
      container,
      h('div.section', {}, [
        h('div.section-title', { text: 'Privacidad' }),
        row(
          'Bloquear rastreadores',
          'Lista por dominio: cubre también subdominios. Nunca bloquea la página principal.',
          toggle(b.blockTrackers, (value) => patchAndRender({ browsing: { blockTrackers: value } })),
        ),
        stats
          ? h('div', {}, [
              h('div.kv', {}, [
                h('span', { text: 'Peticiones bloqueadas' }),
                h('span', { text: String(stats.blockedCount) }),
              ]),
              h('div.kv', {}, [h('span', { text: 'Reglas activas' }), h('span', { text: String(stats.rules) })]),
              h('div.row', {}, [
                h('button.btn', {
                  text: 'Editar mi lista',
                  on: { click: () => window.orbit.app.openPath(stats.path) },
                }),
                h('button.btn', {
                  text: 'Recargar lista',
                  on: {
                    click: async () => {
                      state.blockerStats = await window.orbit.resources.reloadBlocklist();
                      render();
                    },
                  },
                }),
              ]),
            ])
          : null,
      ]),
    );
  }

  // --- Sistema ---

  function renderSistema() {
    const v = state.versions;

    mount(
      container,
      h('div.section', {}, [
        h('div.section-title', { text: 'Versión' }),
        kv('Orbit', v.app),
        kv('Chromium', v.chrome),
        kv('Electron', v.electron),
        kv('Node', v.node),
        kv('V8', v.v8),
        kv('Sistema', state.visuals.osLabel),
        kv('Modo de ventana', state.windowMode),
      ]),
      h('div.section', {}, [
        h('div.section-title', { text: 'Motor: opciones activas' }),
        state.appliedSwitches.length
          ? h(
              'div',
              {},
              state.appliedSwitches.map((line) => h('div.kv', {}, [h('span', { text: line })])),
            )
          : h('div.hint', { text: 'Ninguna: todo por defecto.' }),
        h('div.hint', {
          text: 'Se aplican al arrancar. Si cambias algo del motor, hay que reiniciar para que Chromium lo lea.',
        }),
      ]),
      h('div.section', {}, [
        h('div.section-title', { text: 'Archivos' }),
        kv('Datos', state.paths.userData),
        kv('Temas', state.paths.themes),
        h('div.row', {}, [
          h('button.btn', {
            text: 'Abrir carpeta de datos',
            on: { click: () => window.orbit.app.openPath(state.paths.userData) },
          }),
          h('button.btn.primary', { text: 'Reiniciar Orbit', on: { click: () => window.orbit.app.restart() } }),
        ]),
      ]),
    );
  }

  // ---------------------------------------------------------------- externos

  /** Recibe una muestra de métricas sin tocar el resto del panel. */
  function setSample(next) {
    sample = next;
    if (section === 'recursos') renderMetrics();
  }

  function setTabs() {
    if (section === 'recursos' && sample) renderMetrics();
  }

  return { render, setSample, setTabs, getSection: () => section };
}

// --------------------------------------------------------------------- utils

/**
 * Añade hijos ignorando los nulos.
 *
 * `Element.append(null)` inserta literalmente el texto "null", asi que las
 * filas condicionales tienen que filtrarse antes de insertarlas.
 */
function mount(parent, ...children) {
  for (const child of children) if (child) parent.append(child);
  return parent;
}

function gauge(value, label) {
  return h('div.gauge', {}, [h('div.gauge-value', { text: value }), h('div.gauge-label', { text: label })]);
}

function kv(key, value) {
  return h('div.kv', {}, [h('span', { text: key }), h('span', { text: String(value ?? '') })]);
}

/**
 * Fila con deslizador que se actualiza en vivo.
 *
 * La clave: mientras arrastras, solo cambia la etiqueta del valor y se aplica
 * el efecto. La fila no se reconstruye, porque reconstruirla mataría el
 * arrastre en curso.
 */
function liveRow({ label, description, min, max, step = 1, value, format, apply, onLocal }) {
  const readout = h('div.row-value', { text: format(value) });
  const control = slider({
    min,
    max,
    step,
    value,
    onChange: (next) => {
      readout.textContent = format(next);
      onLocal?.(next);
      apply(next);
    },
  });

  return h('div.row.stacked', {}, [
    h('div.row-label', {}, [label, description ? h('small', { text: description }) : null]),
    readout,
    control,
  ]);
}
