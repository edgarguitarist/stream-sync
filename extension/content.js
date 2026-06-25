// YT Dual Sync — content script (Fase 1: sync manual)
// Inyecta un panel flotante arrastrable que controla el <video> del live.
// Puntos de enganche para la Fase 2 (sync automático): nudge(delta) y goLive().

(() => {
  "use strict";

  // Evita doble inyección si YouTube re-navega (SPA) sobre la misma pestaña.
  if (window.__ytDualSync) return;
  window.__ytDualSync = true;

  const PANEL_ID = "yt-dual-sync-panel";
  const STORAGE_POS = "ytds:pos";

  // --- Acceso al <video> -----------------------------------------------------

  /** Devuelve el <video> principal del reproductor, o null si aún no existe. */
  function getVideo() {
    return (
      document.querySelector("video.html5-main-video") ||
      document.querySelector("#movie_player video") ||
      document.querySelector("video")
    );
  }

  /** Extremo "en vivo" del buffer reproducible (segundos), o NaN si no hay. */
  function liveEdge(video) {
    const r = video.seekable;
    if (!r || r.length === 0) return NaN;
    return r.end(r.length - 1);
  }

  // --- Hooks de sincronización (también usados por la Fase 2) ----------------

  /**
   * Empuja el currentTime del live en `delta` segundos (negativo = retrasar).
   * Recuerda: en un live solo tiene sentido retrasar al que va adelante.
   * @param {number} delta segundos a sumar al currentTime
   * @returns {number|undefined} el nuevo currentTime, o undefined si no hay video
   */
  function nudge(delta) {
    const video = getVideo();
    if (!video) return undefined;
    const edge = liveEdge(video);
    let t = video.currentTime + delta;
    // No dejar pasar el live edge (no se puede ir al futuro).
    if (!Number.isNaN(edge)) t = Math.min(t, edge);
    if (t < 0) t = 0;
    video.currentTime = t;
    bumpOffset(delta);
    render();
    return t;
  }

  /** Salta al borde en vivo (resetea el desfase manual acumulado). */
  function goLive() {
    const video = getVideo();
    if (!video) return;
    const edge = liveEdge(video);
    if (!Number.isNaN(edge)) video.currentTime = edge;
    state.offset = 0;
    render();
  }

  // Exponer hooks para depuración y para la Fase 2.
  window.__ytDualSync = { nudge, goLive, getVideo };

  // --- Estado ----------------------------------------------------------------

  const state = {
    // Desfase manual acumulado (segundos) que el usuario aplicó en esta pestaña.
    offset: 0,
  };

  function bumpOffset(delta) {
    state.offset += delta;
  }

  // --- Panel UI --------------------------------------------------------------

  const STEPS = [-5, -1, -0.5, 0.5, 1, 5];

  let panel, offsetEl, liveEl;

  function buildPanel() {
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="ytds-header" data-drag>
        <span class="ytds-title">YT Dual Sync</span>
        <button class="ytds-min" title="Minimizar">–</button>
      </div>
      <div class="ytds-body">
        <div class="ytds-readout">
          <div class="ytds-offset">offset <b data-offset>0.0s</b></div>
          <div class="ytds-live">behind live <b data-live>–</b></div>
        </div>
        <div class="ytds-steps"></div>
        <div class="ytds-actions">
          <button class="ytds-golive" data-golive>Ir al live</button>
        </div>
        <p class="ytds-hint">Retrasa al directo que va <b>adelante</b> hasta cuadrarlo.</p>
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

    panel.querySelector("[data-golive]").addEventListener("click", goLive);
    panel.querySelector(".ytds-min").addEventListener("click", () => {
      panel.classList.toggle("ytds-collapsed");
    });

    offsetEl = panel.querySelector("[data-offset]");
    liveEl = panel.querySelector("[data-live]");

    document.body.appendChild(panel);
    restorePosition();
    makeDraggable(panel, panel.querySelector("[data-drag]"));
  }

  function render() {
    if (!offsetEl) return;
    const sign = state.offset > 0 ? "+" : "";
    offsetEl.textContent = sign + state.offset.toFixed(1) + "s";

    const video = getVideo();
    if (video) {
      const edge = liveEdge(video);
      if (!Number.isNaN(edge)) {
        const behind = Math.max(0, edge - video.currentTime);
        liveEl.textContent = behind.toFixed(1) + "s";
      }
    }
  }

  // --- Arrastre del panel ----------------------------------------------------

  function makeDraggable(el, handle) {
    let startX, startY, baseLeft, baseTop, dragging = false;

    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return; // no arrastrar desde botones
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

  // --- Arranque --------------------------------------------------------------

  function start() {
    if (document.getElementById(PANEL_ID)) return;
    buildPanel();
    render();
    // Refresca el "behind live" mientras corre el directo.
    setInterval(render, 1000);
  }

  // El reproductor puede tardar en montar; espera a tener <body> y <video>.
  function waitAndStart() {
    if (document.body && getVideo()) {
      start();
    } else {
      setTimeout(waitAndStart, 500);
    }
  }

  waitAndStart();
})();
