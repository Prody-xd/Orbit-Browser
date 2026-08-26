'use strict';

/**
 * Preload de las paginas web.
 *
 * Deliberadamente casi vacio: cualquier cosa que se exponga aqui la ve todo
 * sitio que visites. Existe como punto de enganche para funciones futuras
 * (modo lectura, capturas de scroll, buscar en pagina) que necesiten correr
 * dentro del documento, no para dar capacidades al sitio.
 */

// El scroll se restaura desde el proceso principal con executeJavaScript al
// despertar una pestana, asi que aqui no hace falta estado propio todavia.
