// YT Dual Sync — content script (Fase 1: sync manual)
// Inyecta un panel flotante arrastrable que controla el <video>.
// Detecta si la pestaña es un DIRECTO (live) o un VIDEO guardado (VOD) y
// adapta controles y lecturas. Puntos de enganche Fase 2: nudge(delta), goLive().

(() => {
  "use strict";

  if (window.__ytDualSync) return;
  window.__ytDualSync = true;

  const PANEL_ID = "yt-dual-sync-panel";
  const STORAGE_POS = "ytds:pos";

  // --- Acceso al <video> -----------------------------------------------------

  function getVideo() {
    return (
      document.querySelector("video.html5-main-video") ||
      document.querySelector("#movie_player video") ||
      document.querySelector("video")
    );
  }

  /** Reproductor de YouTube (#movie_player), expone su API: getVideoData, etc. */
  function ytPlayer() {
    return document.querySelector("#movie_player");
  }

  /** Datos del video según la API de YouTube (incluye isLive), o null. */
  function ytData() {
    const p = ytPlayer();
    return p && typeof p.getVideoData === "function" ? p.getVideoData() : null;
  }

  /** Duración del contenido (s): prefiere el <video>, cae a la API de YouTube. */
  function getDuration(video) {
    if (video && Number.isFinite(video.duration) && video.duration > 0) return video.duration;
    const p = ytPlayer();
    if (p && typeof p.getDuration === "function") {
      const d = p.getDuration();
      if (Number.isFinite(d) && d > 0) return d;
    }
    return NaN;
  }

  /** Extremo "en vivo" del buffer reproducible (segundos), o NaN si no hay. */
  function liveEdge(video) {
    const r = video.seekable;
    if (!r || r.length === 0) return NaN;
    return r.end(r.length - 1);
  }

  // --- Detección de modo: 'live' | 'vod' -------------------------------------

  /**
   * Distingue directo de VOD.
   *
   * Señal primaria y autoritativa: la API del reproductor de YouTube,
   * `player.getVideoData().isLive` (booleano). Está disponible de inmediato,
   * sin esperar a que el buffer pueble la metadata, y no se deja engañar por
   * el badge/clase ".ytp-live", que YouTube DEJA en el DOM de las grabaciones
   * de directos ya terminados (que en realidad son VOD).
   *
   * Respaldo: la duración del <video> (Infinity = live, finita = VOD), por si
   * la API aún no está lista.
   *
   * Devuelve 'live', 'vod', o null si aún no hay suficiente información.
   */
  function detectMode() {
    const data = ytData();
    if (data && typeof data.isLive === "boolean") {
      return data.isLive ? "live" : "vod";
    }

    const v = getVideo();
    if (v && v.readyState >= 1) {
      if (Number.isFinite(v.duration)) return v.duration > 0 ? "vod" : null;
      return "live"; // duration === Infinity
    }
    return null; // sin información suficiente todavía
  }

  /** Límite superior de seek según el modo: live edge en directo, duración en VOD. */
  function maxTime(video) {
    if (state.mode === "live") {
      const e = liveEdge(video);
      return Number.isNaN(e) ? Infinity : e;
    }
    const d = getDuration(video);
    return Number.isNaN(d) ? Infinity : d;
  }

  // --- Hooks de sincronización (también usados por la Fase 2) ----------------

  /**
   * Empuja el currentTime en `delta` segundos.
   * - Live: solo es útil retrasar (el de atrás ya está en el live edge).
   * - VOD: se puede adelantar y retrasar libremente dentro de [0, duración].
   * @param {number} delta segundos a sumar al currentTime
   * @returns {number|undefined} nuevo currentTime, o undefined si no hay video
   */
  function nudge(delta) {
    const video = getVideo();
    if (!video) return undefined;
    let t = clamp(video.currentTime + delta, 0, maxTime(video));
    video.currentTime = t;
    state.offset += delta;
    render();
    return t;
  }

  /** Solo live: salta al borde en vivo y resetea el desfase manual. */
  function goLive() {
    const video = getVideo();
    if (!video) return;
    const edge = liveEdge(video);
    if (!Number.isNaN(edge)) video.currentTime = edge;
    state.offset = 0;
    render();
  }

  /** Solo VOD: pausa/reproduce el video (útil para cuadrar dos VODs a mano). */
  function togglePlay() {
    const video = getVideo();
    if (!video) return;
    if (video.paused) video.play();
    else video.pause();
    render();
  }

  window.__ytDualSync = { nudge, goLive, togglePlay, getVideo, getMode: () => state.mode };

  // --- Estado ----------------------------------------------------------------

  const state = {
    offset: 0, // desfase manual acumulado (s) en esta pestaña
    mode: null, // 'live' | 'vod' | null
  };

  // --- Panel UI --------------------------------------------------------------

  const STEPS = [-5, -1, -0.5, 0.5, 1, 5];

  let panel, els = {};

  function buildPanel() {
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="ytds-header" data-drag>
        <span class="ytds-title">YT Dual Sync</span>
        <span class="ytds-badge" data-badge>…</span>
        <button class="ytds-min" title="Minimizar">–</button>
      </div>
      <div class="ytds-body">
        <div class="ytds-readout">
          <div class="ytds-left"><span data-leftlabel>posición</span><b data-leftval>–</b></div>
          <div class="ytds-right">offset<b data-offset>0.0s</b></div>
        </div>
        <div class="ytds-steps"></div>
        <div class="ytds-actions">
          <button class="ytds-sec" data-sec>…</button>
        </div>
        <p class="ytds-hint" data-hint></p>
      </div>
    `;

    const steps = panel.querySelector(".ytds-steps");
    for (const s of STEPS) {
      const b = document.createElement("button");
      b.className = "ytds-step" + (s < 0 ? " neg" : " pos");
      b.textContent = (s > 0 ? "+" : "") + s + "s";
      b.addEventListener("click", () => nudge(s));
      steps.appendChild(b);
    }

    panel.querySelector(".ytds-min").addEventListener("click", () => {
      panel.classList.toggle("ytds-collapsed");
    });

    els = {
      badge: panel.querySelector("[data-badge]"),
      leftLabel: panel.querySelector("[data-leftlabel]"),
      leftVal: panel.querySelector("[data-leftval]"),
      offset: panel.querySelector("[data-offset]"),
      sec: panel.querySelector("[data-sec]"),
      hint: panel.querySelector("[data-hint]"),
    };

    document.body.appendChild(panel);
    restorePosition();
    makeDraggable(panel, panel.querySelector("[data-drag]"));
  }

  /** Ajusta badge, etiqueta de lectura, botón secundario y pista al modo actual. */
  function applyMode(mode) {
    state.mode = mode;
    const isLive = mode === "live";

    els.badge.textContent = isLive ? "EN DIRECTO" : mode === "vod" ? "VOD" : "…";
    els.badge.className = "ytds-badge " + (isLive ? "live" : mode === "vod" ? "vod" : "");

    els.leftLabel.textContent = isLive ? "tras el live" : "posición";

    els.sec.className = "ytds-sec " + (isLive ? "live" : "vod");
    els.sec.onclick = isLive ? goLive : togglePlay;

    els.hint.innerHTML = isLive
      ? "Retrasa al directo que va <b>adelante</b> hasta cuadrarlo."
      : "Cuadra ambos videos por el <b>audio compartido</b>; en VOD puedes adelantar y retrasar.";
  }

  function fmt(t) {
    if (!Number.isFinite(t)) return "–";
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const ss = String(s).padStart(2, "0");
    if (h > 0) return h + ":" + String(m).padStart(2, "0") + ":" + ss;
    return m + ":" + ss;
  }

  function render() {
    if (!els.offset) return;

    const sign = state.offset > 0 ? "+" : "";
    els.offset.textContent = sign + state.offset.toFixed(1) + "s";

    const video = getVideo();
    if (!video) return;

    if (state.mode === "live") {
      const edge = liveEdge(video);
      if (!Number.isNaN(edge)) {
        els.leftVal.textContent = Math.max(0, edge - video.currentTime).toFixed(1) + "s";
      }
    } else if (state.mode === "vod") {
      els.leftVal.textContent = fmt(video.currentTime) + " / " + fmt(getDuration(video));
      els.sec.textContent = video.paused ? "▶ Reproducir" : "⏸ Pausar";
    }
  }

  // --- Arrastre del panel ----------------------------------------------------

  function makeDraggable(el, handle) {
    let startX, startY, baseLeft, baseTop, dragging = false;

    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = el.getBoundingClientRect();
      baseLeft = rect.left;
      baseTop = rect.top;
      el.classList.add("ytds-dragging");
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const x = clamp(baseLeft + (e.clientX - startX), 0, window.innerWidth - el.offsetWidth);
      const y = clamp(baseTop + (e.clientY - startY), 0, window.innerHeight - el.offsetHeight);
      el.style.left = x + "px";
      el.style.top = y + "px";
      el.style.right = "auto";
    });

    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove("ytds-dragging");
      savePosition(el);
    });
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function savePosition(el) {
    try {
      localStorage.setItem(STORAGE_POS, JSON.stringify({ left: el.style.left, top: el.style.top }));
    } catch (_) {}
  }

  function restorePosition() {
    try {
      const raw = localStorage.getItem(STORAGE_POS);
      if (!raw) return;
      const { left, top } = JSON.parse(raw);
      if (left && top) {
        panel.style.left = left;
        panel.style.top = top;
        panel.style.right = "auto";
      }
    } catch (_) {}
  }

  // --- Arranque y re-detección de modo ---------------------------------------

  let modeTimer = null;

  /** Sondea hasta determinar el modo (la metadata puede tardar en cargar). */
  function resolveMode() {
    clearInterval(modeTimer);
    const tryDetect = () => {
      const m = detectMode();
      if (m) {
        applyMode(m);
        render();
        clearInterval(modeTimer);
      }
    };
    tryDetect();
    if (!state.mode) modeTimer = setInterval(tryDetect, 500);
  }

  function start() {
    if (!document.getElementById(PANEL_ID)) buildPanel();
    resolveMode();
    setInterval(render, 1000);
  }

  function waitAndStart() {
    if (document.body && getVideo()) start();
    else setTimeout(waitAndStart, 500);
  }

  // YouTube es una SPA: al navegar entre videos no se recarga la página.
  // Reseteamos el offset y volvemos a detectar el modo.
  window.addEventListener("yt-navigate-finish", () => {
    state.offset = 0;
    state.mode = null;
    if (els.badge) {
      els.badge.textContent = "…";
      els.badge.className = "ytds-badge";
    }
    resolveMode();
  });

  waitAndStart();
})();
