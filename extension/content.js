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

  // --- Sync persistente entre pestañas ---------------------------------------
  // El desfase entre dos VODs es CONSTANTE (son grabaciones fijas). Lo guardamos
  // por par de IDs de video y lo reaplicamos al reabrir el mismo par. Las dos
  // pestañas se coordinan con chrome.storage.local como pizarra compartida
  // (presencia + heartbeat), sin necesidad de service worker.

  const SESSION_ID =
    (self.crypto && crypto.randomUUID && crypto.randomUUID()) ||
    "s" + Math.floor(Math.random() * 1e9);
  const PRESENCE_PREFIX = "ytds:presence:";
  const PAIR_PREFIX = "ytds:pair:";
  const PRESENCE_TTL = 6000; // ms; una pestaña está "viva" si su heartbeat es reciente

  const sync = {
    partner: null, // presencia de la otra pestaña emparejada, o null
    appliedFor: null, // videoId de pareja para el que ya auto-sincronicé
    record: null, // desfase guardado para el par actual, o null
  };

  function storageOk() {
    return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
  }

  /** ID del video de ESTA pestaña (de la URL, o de la API de YouTube). */
  function currentVideoId() {
    try {
      const v = new URL(location.href).searchParams.get("v");
      if (v) return v;
    } catch (_) {}
    const d = ytData();
    return (d && d.video_id) || null;
  }

  function pairKey(a, b) {
    const [x, y] = [a, b].sort();
    return PAIR_PREFIX + x + "|" + y;
  }

  /** Posición estimada de la pareja AHORA (compensa el retraso del heartbeat). */
  function partnerNow(partner) {
    if (!partner) return NaN;
    return partner.paused ? partner.t : partner.t + (Date.now() - partner.updated) / 1000;
  }

  /** Publica la presencia de esta pestaña (video, posición, estado). */
  async function heartbeat() {
    if (!storageOk()) return;
    const video = getVideo();
    const vid = currentVideoId();
    if (!video || !vid) return;
    try {
      await chrome.storage.local.set({
        [PRESENCE_PREFIX + SESSION_ID]: {
          sid: SESSION_ID,
          videoId: vid,
          t: video.currentTime,
          paused: video.paused,
          mode: state.mode,
          updated: Date.now(),
        },
      });
    } catch (_) {}
  }

  /** Lee presencias vivas y limpia las caducadas. */
  async function readPresences() {
    if (!storageOk()) return [];
    let all;
    try {
      all = await chrome.storage.local.get(null);
    } catch (_) {
      return [];
    }
    const now = Date.now();
    const live = [];
    const stale = [];
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith(PRESENCE_PREFIX)) continue;
      if (v && now - v.updated < PRESENCE_TTL) live.push(v);
      else stale.push(k);
    }
    if (stale.length) {
      try {
        await chrome.storage.local.remove(stale);
      } catch (_) {}
    }
    return live;
  }

  /** Encuentra la otra pestaña abierta con un video distinto (la pareja). */
  async function refreshPartner() {
    const me = currentVideoId();
    const others = (await readPresences())
      .filter((p) => p.sid !== SESSION_ID && p.videoId && p.videoId !== me)
      .sort((a, b) => b.updated - a.updated);
    sync.partner = others[0] || null;
    return sync.partner;
  }

  async function loadPairRecord() {
    const me = currentVideoId();
    if (!me || !sync.partner || !storageOk()) return null;
    const key = pairKey(me, sync.partner.videoId);
    try {
      const got = await chrome.storage.local.get(key);
      return got[key] || null;
    } catch (_) {
      return null;
    }
  }

  /** Guarda el desfase actual del par para reusarlo en el futuro. */
  async function saveSync() {
    const me = currentVideoId();
    const video = getVideo();
    if (!me || !video || !sync.partner) return false;
    const partner = sync.partner;
    const [low, high] = [me, partner.videoId].sort();
    const posMe = video.currentTime;
    const posPartner = partnerNow(partner);
    const delta = (high === me ? posMe : posPartner) - (low === me ? posMe : posPartner);
    if (!storageOk()) return false;
    try {
      await chrome.storage.local.set({
        [pairKey(me, partner.videoId)]: { low, high, delta, savedAt: Date.now() },
      });
      toast("Sync guardado para este par ✓");
      renderSync();
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Mueve SOLO esta pestaña para cumplir el desfase guardado con la pareja. */
  async function applySync(announce) {
    const me = currentVideoId();
    const video = getVideo();
    if (!me || !video || !sync.partner) return false;
    const rec = await loadPairRecord();
    if (!rec) return false;
    const pPos = partnerNow(sync.partner);
    // Buscamos pos(high) − pos(low) = delta, ajustando únicamente esta pestaña.
    let target = me === rec.low ? pPos - rec.delta : pPos + rec.delta;
    target = clamp(target, 0, maxTime(video));
    video.currentTime = target;
    sync.appliedFor = sync.partner.videoId;
    if (announce) toast("Sincronizado automáticamente ✨");
    render();
    return true;
  }

  /** Tras emparejar, auto-sincroniza una vez si hay desfase guardado. */
  async function maybeAutoSync() {
    if (!sync.partner) return;
    if (sync.appliedFor === sync.partner.videoId) return; // ya hecho para esta pareja
    const rec = await loadPairRecord();
    if (!rec) return;
    // Solo la pestaña "seguidora" (videoId mayor) se mueve, para que no se ajusten ambas.
    if (currentVideoId() !== rec.high) {
      sync.appliedFor = sync.partner.videoId; // el ancla no se mueve, pero marca como resuelto
      renderSync();
      return;
    }
    await applySync(true);
    renderSync();
  }

  window.__ytDualSync = {
    nudge, goLive, togglePlay, getVideo, getMode: () => state.mode,
    saveSync, applySync: () => applySync(true), getPartner: () => sync.partner,
  };

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
        <div class="ytds-sync">
          <div class="ytds-sync-status" data-syncstatus>buscando segunda pestaña…</div>
          <div class="ytds-sync-btns">
            <button class="ytds-savesync" data-savesync title="Guardar el desfase actual de este par">💾 Guardar</button>
            <button class="ytds-applysync" data-applysync title="Reaplicar el desfase guardado">✨ Aplicar</button>
          </div>
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
      syncStatus: panel.querySelector("[data-syncstatus]"),
      saveSync: panel.querySelector("[data-savesync]"),
      applySync: panel.querySelector("[data-applysync]"),
    };

    els.saveSync.addEventListener("click", () => saveSync());
    els.applySync.addEventListener("click", () => applySync(true));

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

  /** Refleja el estado de emparejamiento y del sync guardado en el panel. */
  function renderSync() {
    if (!els.syncStatus) return;
    if (!sync.partner) {
      els.syncStatus.textContent = "buscando segunda pestaña…";
      els.syncStatus.className = "ytds-sync-status";
      els.saveSync.disabled = true;
      els.applySync.disabled = true;
      return;
    }
    els.saveSync.disabled = false;
    if (sync.record) {
      els.applySync.disabled = false;
      els.syncStatus.textContent = "🔗 emparejado · guardado (Δ " + sync.record.delta.toFixed(1) + "s)";
      els.syncStatus.className = "ytds-sync-status paired saved";
    } else {
      els.applySync.disabled = true;
      els.syncStatus.textContent = "🔗 emparejado · sin sync guardado";
      els.syncStatus.className = "ytds-sync-status paired";
    }
  }

  let toastEl, toastTimer;
  function toast(msg) {
    if (!panel) return;
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "ytds-toast";
      panel.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
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

  /** Latido de coordinación: publica presencia, busca pareja y auto-sincroniza. */
  async function syncTick() {
    await heartbeat();
    await refreshPartner();
    sync.record = await loadPairRecord();
    renderSync();
    await maybeAutoSync();
  }

  function start() {
    if (!document.getElementById(PANEL_ID)) buildPanel();
    resolveMode();
    renderSync();
    setInterval(render, 1000);
    syncTick();
    setInterval(syncTick, 1000);
  }

  function waitAndStart() {
    if (document.body && getVideo()) start();
    else setTimeout(waitAndStart, 500);
  }

  // YouTube es una SPA: al navegar entre videos no se recarga la página.
  // Reseteamos offset, modo y el emparejamiento, y volvemos a detectar.
  window.addEventListener("yt-navigate-finish", () => {
    state.offset = 0;
    state.mode = null;
    sync.partner = null;
    sync.appliedFor = null;
    sync.record = null;
    if (els.badge) {
      els.badge.textContent = "…";
      els.badge.className = "ytds-badge";
    }
    resolveMode();
    renderSync();
  });

  // Al cerrar/ocultar la pestaña, retiramos nuestra presencia de la pizarra.
  window.addEventListener("pagehide", () => {
    if (!storageOk()) return;
    try {
      chrome.storage.local.remove(PRESENCE_PREFIX + SESSION_ID);
    } catch (_) {}
  });

  waitAndStart();
})();
