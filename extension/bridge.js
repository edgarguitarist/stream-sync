// YT Dual Sync — puente al MAIN world.
// El content script corre en un "mundo aislado" y NO puede ver las variables de
// la página (window.ytInitialPlayerResponse) ni los métodos que YouTube añade al
// reproductor (getVideoData, getPlayerResponse, getDuration). Este script sí corre
// en el contexto de la página y publica los datos que necesitamos como atributos
// data-* en <html>, que ambos mundos comparten (es el mismo nodo del DOM).

(() => {
  "use strict";

  const ATTR_LIVE = "data-ytds-islive"; // "true" si está EN VIVO ahora
  const ATTR_START = "data-ytds-start"; // epoch ms del inicio del directo (si aplica)
  const ATTR_DUR = "data-ytds-duration"; // duración real del contenido (s)

  function player() {
    return document.querySelector("#movie_player");
  }

  function playerResponse() {
    const p = player();
    if (p && typeof p.getPlayerResponse === "function") {
      try {
        return p.getPlayerResponse();
      } catch (_) {}
    }
    return window.ytInitialPlayerResponse || null;
  }

  /** Hora de inicio del directo en epoch ms, o null si no es un directo/grabación de directo. */
  function startMs() {
    const pr = playerResponse();
    const lbd =
      pr &&
      pr.microformat &&
      pr.microformat.playerMicroformatRenderer &&
      pr.microformat.playerMicroformatRenderer.liveBroadcastDetails;
    if (lbd && lbd.startTimestamp) {
      const t = Date.parse(lbd.startTimestamp);
      if (!Number.isNaN(t)) return t;
    }
    return null;
  }

  function publish() {
    const root = document.documentElement;
    const p = player();

    // ¿En vivo ahora? (VOD de directo => false, aunque tenga startTimestamp)
    if (p && typeof p.getVideoData === "function") {
      try {
        const d = p.getVideoData();
        if (typeof d.isLive === "boolean") root.setAttribute(ATTR_LIVE, String(d.isLive));
      } catch (_) {}
    }

    // Hora de inicio (para estimar el desfase base entre dos POV).
    const s = startMs();
    if (s) root.setAttribute(ATTR_START, String(s));
    else root.removeAttribute(ATTR_START);

    // Duración real (respaldo cuando <video>.duration aún no está poblado).
    if (p && typeof p.getDuration === "function") {
      try {
        const d = p.getDuration();
        if (Number.isFinite(d) && d > 0) root.setAttribute(ATTR_DUR, String(d));
      } catch (_) {}
    }
  }

  publish();
  setInterval(publish, 1000);

  // Al navegar (SPA) los datos cambian: limpiamos y re-publicamos.
  window.addEventListener("yt-navigate-finish", () => {
    const root = document.documentElement;
    root.removeAttribute(ATTR_LIVE);
    root.removeAttribute(ATTR_START);
    root.removeAttribute(ATTR_DUR);
    setTimeout(publish, 300);
  });
})();
