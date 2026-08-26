# Hoja de ruta

Orden pensado para que cada paso deje la app usable, no para tenerlo todo a
medias.

## Ya funciona (v0.1)

- Pestañas con `WebContentsView`, suspensión y despertar con scroll restaurado
- Tope de pestañas vivas y suspensión por inactividad
- Perfiles de recursos y ajustes del motor Chromium
- Panel de consumo por pestaña, con muestreo solo mientras se mira
- Temas JSON, opacidad, redondeo, acento, página flotante
- Ventana sin marco con transparencia y redimensionado propio
- Bloqueo de rastreadores por dominio
- Menús contextuales nativos, atajos que funcionan sobre las páginas
- Página de inicio interna y protocolo `orbit://`
- Restauración de sesión, con opción de restaurar dormidas
- Verificación automatizada (`npm run smoke`)

## Siguiente: lo que más se echa en falta al usarlo a diario

1. **Historial y marcadores**
   Almacén JSON con índice en memoria; búsqueda desde la barra de direcciones.
   Es lo primero que se nota que falta.

2. **Sugerencias en la barra de direcciones**
   Autocompletado con historial y marcadores, sin llamadas a la red.

3. **Descargas**
   Interceptar `will-download`, panel con progreso, pausar y reanudar.

4. **Buscar en la página** (`Ctrl`+`F`)
   `webContents.findInPage`. La superposición tiene que ser nativa o vivir en el
   chrome, porque el HTML no puede taparse sobre la vista de la página.

5. **Zoom por sitio**
   Guardar el nivel por dominio y aplicarlo al cargar.

## Después

6. **Perfiles / contenedores**
   Una partición de sesión por perfil (`persist:trabajo`, `persist:personal`).
   La arquitectura ya lo permite: `PARTITION` está en un solo sitio.

7. **Permisos con pregunta**
   Ahora se deniega casi todo en silencio. Falta el diálogo por sitio y la lista
   de excepciones.

8. **Temas para páginas internas y para el editor**
   El protocolo ya sirve `orbit://theme/theme.css`. Falta un editor de temas
   dentro del panel, en vez de editar JSON a mano.

9. **Presupuesto de recursos por sitio**
   Reglas como «este dominio nunca duerme» o «este siempre con imágenes
   congeladas». Es la extensión natural del panel de recursos.

10. **Grupos de pestañas y barra lateral vertical**
    Con muchas pestañas, la barra horizontal se queda corta.

## Más adelante

- **Empaquetado** con `electron-builder`: instalador, firma, acceso directo
- **Actualizador**: comprobar versión nueva y avisar
- **Historial de recursos**: gráfico de memoria en el tiempo, para detectar qué
  sitio se descontrola
- **Modo lectura**: extraer el contenido con el preload de página, que existe
  justo para esto
- **Filtros estilo EasyList**: el bloqueador actual solo mira dominios; soportar
  reglas por ruta exige un motor que siga siendo O(1) en el camino caliente

## Deudas técnicas conocidas

- `backgroundThrottling` y la política de animación de imágenes se fijan al
  crear la vista, así que solo afectan a pestañas nuevas. Se podría recrear la
  vista al cambiarlos, a costa de recargar la página.
- Cambiar entre opaco y translúcido necesita reiniciar: el tipo de ventana se
  decide al crearla.
- El scroll se restaura con `executeJavaScript` tras cargar, así que en páginas
  con contenido diferido puede quedarse corto.
- No hay pruebas unitarias, solo el recorrido de humo. La lógica pura
  (`_resolveInput`, `deepMerge`, coincidencia de dominios) merece pruebas
  propias.
- El límite de pestañas vivas usa el orden de último uso, sin tener en cuenta
  cuánta memoria gasta cada una. Con las métricas ya disponibles se podría
  dormir primero a la más pesada.
