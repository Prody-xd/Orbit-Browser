# Orbit Browser

Navegador personal basado en Chromium. En la interfaz se llama **Orbit**;
el repositorio y el paquete son `orbit-browser`.

Dos obsesiones:

1. **Controlar los recursos sin volverse lento por controlarlos.** Puedes decidir
   cuánta memoria y CPU gasta el navegador, y las herramientas para medirlo solo
   se encienden cuando las estás mirando.
2. **Ser personalizable de verdad en el aspecto**, incluyendo ventanas
   translúcidas.

No pretende competir con Chrome. Pretende ser *tu* navegador.

## Arrancar

```bash
npm install
npm start
```

Verificación automática (abre la app, navega, duerme pestañas, mide y guarda
capturas en `out/smoke/`):

```bash
npm run smoke
```

## Qué hace hoy

**Navegación**

- Pestañas, barra de direcciones con búsqueda, historial de navegación
- Menús contextuales nativos en páginas y pestañas
- Restauración de sesión al abrir
- Página de inicio interna (`orbit://start`) con reloj, buscador y accesos
- Bloqueo de rastreadores por dominio, con lista propia editable

**Recursos**

- **Dormir pestañas**: destruye el proceso del renderer y conserva la pestaña
  (url, título, favicon y posición de scroll). Es de donde sale el ahorro real:
  en la prueba automatizada, dormir una sola pestaña baja el consumo de ~496 MB
  a ~411 MB.
- Tope de pestañas vivas: al pasarlo, se duerme la menos usada
- Suspensión por inactividad configurable
- Perfiles **Ahorro / Equilibrado / Rendimiento**
- Panel de consumo con memoria y CPU por pestaña
- Ajustes del motor: aceleración por hardware, rasterización en GPU, límite de
  procesos de renderer, tope de memoria JS, tamaño de caché

**Apariencia**

- Temas en JSON, recargables sin recompilar
- Opacidad separada para el fondo y para las barras
- Redondeo, margen de página flotante, color de acento, escala de la interfaz
- Ventana sin marco nativo, con barra de pestañas y controles propios

## Cómo está hecho

```
src/main/        proceso principal (Node)
  main.js        arranque y orquestación
  window.js      ventana sin marco, transparencia, redimensionado manual
  tabs.js        gestor de pestañas, suspensión, límites
  settings.js    esquema de ajustes y perfiles de recursos
  switches.js    ajustes -> flags de línea de comandos de Chromium
  metrics.js     muestreo de memoria y CPU por proceso
  blocker.js     filtro de rastreadores por dominio
  themes.js      carga de temas
  protocol.js    esquema interno orbit://
  menus.js       menús contextuales nativos
  ipc.js         única puerta entre la UI y el sistema
  smoke.js       recorrido de verificación automatizado
src/preload/     puentes con contextIsolation
src/renderer/    interfaz del navegador (HTML/CSS/JS, sin framework)
themes/          temas incluidos
```

### Decisiones que explican el resto

**Electron sobre un fork de Chromium.** Un fork propio significa recompilar
Chromium y fusionar cambios cada cuatro semanas, para siempre. Electron trae
Blink y V8 ya construidos y actualizarse es cambiar un número de versión. Para
un proyecto personal es la diferencia entre mantenerlo y abandonarlo.

**Cada pestaña es un `WebContentsView`**, no un `<webview>`. Es una vista nativa
compuesta por Chromium: no paga el coste de reenviar eventos por IPC ni de
anidar renderers.

**La página no es un elemento del DOM.** La interfaz mide un hueco vacío
(`#page-slot`) y le manda su rectángulo al proceso principal, que coloca ahí la
vista nativa. Así el CSS sigue siendo la única fuente de verdad del diseño:
mover un div mueve la página.

**El panel de ajustes se acopla en vez de flotar.** Las vistas nativas se
componen por encima del HTML, así que un panel superpuesto quedaría tapado por
la propia página. Al acoplarse, el hueco se encoge y el panel siempre se ve.

**Los menús contextuales son nativos**, por el mismo motivo.

**Nada se re-renderiza mientras arrastras un deslizador.** Los cambios continuos
solo reescriben variables CSS. Personalizar tiene que sentirse instantáneo.

**Medir no consume.** El muestreo de `getAppMetrics()` arranca al abrir el panel
de recursos y se detiene al cerrarlo.

**Ajustes agrupados por cuándo surten efecto:** ahora, en la próxima pestaña, o
al reiniciar. Chromium lee algunos parámetros una sola vez al arrancar; la UI lo
dice en vez de fingir lo contrario.

**Sin dependencias más allá de Electron.** Ni framework de UI ni SQLite. La
persistencia es JSON con escritura atómica y diferida: suficiente para uso
personal, y sin módulos nativos que recompilar en cada actualización.

## Transparencia: qué se puede y qué no

Depende del sistema, y la app lo detecta al arrancar:

| Sistema | Efecto | Cómo |
|---|---|---|
| Windows 11 (build ≥ 22000) | Desenfoque real del escritorio | `backgroundMaterial: 'acrylic'` |
| Windows 10 | Translucidez limpia, sin difuminar | ventana con canal alfa |
| macOS | Desenfoque del sistema | materiales nativos |

En Windows 10 —el caso de esta máquina— `transparent: true` da translucidez de
verdad, pero el escritorio detrás no se difumina: Windows 10 no expone ese
efecto sin trucos nativos inestables. El deslizador «desenfoque interno» sí
funciona, pero difumina lo que hay *dentro* de la ventana, no el escritorio.

Como las ventanas transparentes en Windows pierden los bordes de redimensión
nativos, la app los dibuja y el proceso principal sigue el cursor durante el
arrastre.

## Atajos

| Atajo | Acción |
|---|---|
| `Ctrl`+`T` | Pestaña nueva |
| `Ctrl`+`W` | Cerrar pestaña |
| `Ctrl`+`L` | Ir a la barra de direcciones |
| `Ctrl`+`R` / `F5` | Recargar |
| `Ctrl`+`Shift`+`R` | Recargar sin caché |
| `Alt`+`←` / `→` | Atrás / adelante |
| `Ctrl`+`Tab` | Siguiente pestaña |
| `Ctrl`+`1…9` | Ir a una pestaña |
| `Ctrl`+`,` | Ajustes |
| `F6` | Dormir las demás pestañas |

Los atajos funcionan también con el foco dentro de una página: se interceptan
antes de que la página los reciba.

## Crear un tema

Ajustes → Apariencia → «Duplicar este tema», y luego «Abrir carpeta de temas».
Cada tema es un JSON:

```json
{
  "id": "mi-tema",
  "name": "Mi tema",
  "dark": true,
  "colors": {
    "base": "#0f1017",
    "chrome": "#171826",
    "elevated": "#1f2133",
    "text": "#c9d1e6",
    "muted": "#79839e",
    "accent": "#7aa2f7",
    "border": "#2b2e42",
    "danger": "#f7768e",
    "ok": "#9ece6a",
    "warn": "#e0af68",
    "page": "#16161e"
  }
}
```

Los temas de la carpeta del usuario tienen prioridad sobre los incluidos, así
que puedes sobrescribir uno reutilizando su `id`.

## Lo que falta

Ver `docs/ROADMAP.md`.

## Límites conocidos

- **Sin extensiones.** No hay soporte de la Chrome Web Store.
- **Sin DRM.** Netflix y similares no funcionarán: Widevine requiere licencia.
- **Actualizaciones del motor a mano.** Subir la versión de Electron es la forma
  de recibir parches de seguridad de Chromium. Conviene hacerlo con regularidad.
- **Sin sincronización.** Todo es local, a propósito.
