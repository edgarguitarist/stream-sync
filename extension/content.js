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

  /** Lee un atributo data-* publicado por el puente (bridge.js, MAIN world). */
  function bridgeAttr(name) {
    return document.documentElement.getAttribute(name);
  }

  /** Duración del contenido (s): prefiere el <video>, cae al dato del puente. */
  function getDuration(video) {
    if (video && Number.isFinite(video.duration) && video.duration > 0) return video.duration;
    const d = parseFloat(bridgeAttr("data-ytds-duration"));
    return Number.isFinite(d) && d > 0 ? d : NaN;
  }

  /** Hora de inicio del directo (epoch ms) publicada por el puente, o null. */
  function getStartMs() {
    const t = parseInt(bridgeAttr("data-ytds-start"), 10);
    return Number.isFinite(t) ? t : null;
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
   * Señal primaria: `data-ytds-islive` que publica el puente leyendo
   * `getVideoData().isLive` de la API de YouTube. Es autoritativa, inmediata y
   * no se deja engañar por el badge/clase ".ytp-live", que YouTube DEJA en el
   * DOM de las grabaciones de directos ya terminados (que en realidad son VOD).
   *
   * Respaldo: la duración del <video> (Infinity = live, finita = VOD), por si
   * el puente aún no publicó el dato.
   *
   * Devuelve 'live', 'vod', o null si aún no hay suficiente información.
   */
  function detectMode() {
    const live = bridgeAttr("data-ytds-islive");
    if (live === "true") return "live";
    if (live === "false") return "vod";

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
  const CMD_KEY = "ytds:cmd"; // canal de comandos play/pausa hacia la pareja
  const PRESENCE_TTL = 6000; // ms; una pestaña está "viva" si su heartbeat es reciente

  const sync = {
    partner: null, // presencia de la otra pestaña emparejada, o null
    appliedFor: null, // videoId de pareja para el que ya auto-sincronicé
    best: null, // mejor desfase disponible { low, high, delta, source }, o null
    mismatch: false, // hay otra pestaña pero de tipo distinto (VOD vs directo)
    suppressUntil: 0, // ignora 'seeked' propios (de applyDelta) hasta este instante
    suppressPlayUntil: 0, // ignora 'play'/'pause' propios (de la sync) hasta este instante
  };

  let autosaveTimer = null;
  /** Programa un guardado automático del desfase tras un breve reposo. */
  function scheduleAutosave() {
    if (!sync.partner) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => saveSync(true), 1200);
  }

  function storageOk() {
    return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
  }

  /** ID del video de ESTA pestaña (de la URL: ?v= o /live/ID). */
  function currentVideoId() {
    try {
      const u = new URL(location.href);
      const v = u.searchParams.get("v");
      if (v) return v;
      const m = u.pathname.match(/^\/live\/([^/?#]+)/);
      if (m) return m[1];
    } catch (_) {}
    return null;
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
          startMs: getStartMs(),
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

  /**
   * Encuentra la pareja: otra pestaña abierta con un video distinto Y DEL MISMO
   * TIPO (ambos VOD o ambos directo, nunca mezclados). Si solo hay una de tipo
   * distinto, no empareja y marca `mismatch` para avisar.
   */
  async function refreshPartner() {
    const me = currentVideoId();
    const others = (await readPresences()).filter(
      (p) => p.sid !== SESSION_ID && p.videoId && p.videoId !== me
    );
    const sameType = others
      .filter((p) => p.mode && state.mode && p.mode === state.mode)
      .sort((a, b) => b.updated - a.updated);
    if (sameType[0]) {
      sync.partner = sameType[0];
      sync.mismatch = false;
    } else {
      sync.partner = null;
      sync.mismatch = others.some((p) => p.mode && state.mode && p.mode !== state.mode);
    }
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
  async function saveSync(auto) {
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
      sync.best = { low, high, delta, savedAt: Date.now(), source: "guardado" };
      toast(auto ? "Sync guardado automáticamente ✓" : "Sync guardado ✓");
      renderSync();
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Mejor desfase disponible para el par actual, con su origen:
   *  - 'guardado': el que el usuario cuadró (manual/autosave) — máxima prioridad.
   *  - 'inicio': estimado por la diferencia de horas de inicio de cada directo.
   * Devuelve { low, high, delta, source } o null si no hay forma de estimarlo.
   */
  async function bestDelta() {
    const me = currentVideoId();
    if (!me || !sync.partner) return null;

    const rec = await loadPairRecord();
    if (rec) return { ...rec, source: "guardado" };

    const myStart = getStartMs();
    const pStart = sync.partner.startMs;
    if (myStart && pStart) {
      const [low, high] = [me, sync.partner.videoId].sort();
      const startLow = low === me ? myStart : pStart;
      const startHigh = high === me ? myStart : pStart;
      // delta = pos(high) − pos(low) = inicio(low) − inicio(high).
      return { low, high, delta: (startLow - startHigh) / 1000, source: "inicio" };
    }
    return null;
  }

  /** Mueve SOLO esta pestaña para cumplir `rec` (desfase) respecto a la pareja. */
  function applyDelta(rec, message) {
    const me = currentVideoId();
    const video = getVideo();
    if (!me || !video || !sync.partner) return false;
    const pPos = partnerNow(sync.partner);
    // Buscamos pos(high) − pos(low) = delta, ajustando únicamente esta pestaña.
    let target = me === rec.low ? pPos - rec.delta : pPos + rec.delta;
    target = clamp(target, 0, maxTime(video));
    sync.suppressUntil = Date.now() + 1500; // no auto-guardar este seek propio
    video.currentTime = target;
    if (message) toast(message);
    render();
    return true;
  }

  /**
   * Diagnóstico Fase 2: la captura debe dispararse desde el ÍCONO de la extensión
   * en la barra (eso concede activeTab; un click dentro de la página no basta).
   * Aquí solo instruimos; el resultado llega por mensaje desde el service worker.
   */
  function captureTest() {
    toast(
      "Auto-sync por audio: pulsa el ícono de YT Dual Sync ↗ en la barra en ESTA pestaña y luego en la OTRA, con ambos videos sonando.",
      7000
    );
  }

  // Mensajería con el service worker (Fase 2): muestra avisos y entrega el estado
  // (posición/modo) que el SW necesita para correlacionar el audio.
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg) return;
      if (msg.type === "ytds-msg") {
        toast(msg.text, 6000);
        return;
      }
      if (msg.type === "ytds-get-state") {
        const v = getVideo();
        sendResponse({
          videoId: currentVideoId(),
          currentTime: v ? v.currentTime : null,
          mode: state.mode,
          startMs: getStartMs(),
        });
        return true; // respuesta (posible) asíncrona
      }
      // Antes de capturar ESTA pestaña: congelamos a la pareja (no debe avanzar)
      // y nos reproducimos para emitir audio, sin propagar el play a la pareja.
      if (msg.type === "ytds-prepare-capture") {
        const v = getVideo();
        sync.suppressPlayUntil = Date.now() + 40000; // toda la captura
        sendCommand("pause"); // congela a la pareja
        if (v) {
          const p = v.play();
          if (p && p.catch) p.catch(() => {});
        }
        sendResponse({
          videoId: currentVideoId(),
          currentTime: v ? v.currentTime : null,
          startMs: getStartMs(),
          mode: state.mode,
        });
        return true;
      }
      // Tras capturar: volvemos a la posición de inicio y pausamos.
      if (msg.type === "ytds-restore") {
        const v = getVideo();
        if (v) {
          sync.suppressUntil = Date.now() + 2000;
          sync.suppressPlayUntil = Date.now() + 2000;
          if (typeof msg.pos === "number") v.currentTime = msg.pos;
          v.pause();
        }
        sendResponse({ ok: true });
        return true;
      }
    });
  }

  /** Reaplica manualmente el mejor desfase disponible (botón Re-sincronizar). */
  async function applySync() {
    const d = await bestDelta();
    if (!d) return false;
    return applyDelta(d, d.source === "inicio" ? "Estimado por hora de inicio ✨" : "Re-sincronizado ✨");
  }

  /**
   * Borra el desfase guardado de este par (p. ej. uno malo) y vuelve a la
   * estimación por hora de inicio, que se reaplica de inmediato.
   */
  async function forgetSync() {
    const me = currentVideoId();
    if (!me || !sync.partner || !storageOk()) return;
    try {
      await chrome.storage.local.remove(pairKey(me, sync.partner.videoId));
    } catch (_) {}
    sync.best = null;
    sync.appliedFor = null; // permite re-aplicar la nueva estimación
    toast("Sync guardado borrado · usando estimación por inicio", 4000);
    syncTick(); // recalcula (será 'inicio') y reaplica
  }

  /** Tras emparejar, auto-sincroniza una vez con el mejor desfase disponible. */
  async function maybeAutoSync() {
    if (!sync.partner) return;
    if (sync.appliedFor === sync.partner.videoId) return; // ya hecho para esta pareja
    const d = await bestDelta();
    if (!d) return;
    sync.appliedFor = sync.partner.videoId;
    // Solo la pestaña "seguidora" (videoId mayor) se mueve; el ancla se queda.
    if (currentVideoId() !== d.high) {
      renderSync();
      return;
    }
    applyDelta(
      d,
      d.source === "inicio"
        ? `Estimado por hora de inicio (Δ ${d.delta.toFixed(0)}s)`
        : "Sincronizado automáticamente ✨"
    );
    renderSync();
  }

  window.__ytDualSync = {
    nudge, goLive, togglePlay, getVideo, getMode: () => state.mode,
    saveSync, applySync, bestDelta, getPartner: () => sync.partner,
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
          <button class="ytds-applysync" data-applysync title="Reaplicar el desfase guardado de este par">✨ Re-sincronizar</button>
          <button class="ytds-forget" data-forget title="Borrar el desfase guardado de este par y volver a la estimación por hora de inicio">🗑 Olvidar sync guardado</button>
          <button class="ytds-captest" data-captest title="Auto-sync por audio: se dispara desde el ícono de la extensión en cada pestaña">🎧 Auto-sync por audio</button>
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
      applySync: panel.querySelector("[data-applysync]"),
      forget: panel.querySelector("[data-forget]"),
      capTest: panel.querySelector("[data-captest]"),
    };

    els.applySync.addEventListener("click", () => applySync());
    els.forget.addEventListener("click", () => forgetSync());
    els.capTest.addEventListener("click", captureTest);

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

  /** Refleja el estado de emparejamiento y del desfase disponible en el panel. */
  function renderSync() {
    if (!els.syncStatus) return;
    if (!sync.partner) {
      if (sync.mismatch) {
        els.syncStatus.textContent = "⚠ la otra pestaña es de otro tipo (VOD ≠ directo)";
        els.syncStatus.className = "ytds-sync-status mismatch";
      } else {
        els.syncStatus.textContent = "buscando segunda pestaña…";
        els.syncStatus.className = "ytds-sync-status";
      }
      els.applySync.disabled = true;
      els.forget.style.display = "none";
      return;
    }
    const best = sync.best;
    if (best && best.source === "guardado") {
      els.applySync.disabled = false;
      els.forget.style.display = "block";
      els.syncStatus.textContent = "🔗 guardado (Δ " + best.delta.toFixed(1) + "s)";
      els.syncStatus.className = "ytds-sync-status paired saved";
    } else if (best && best.source === "inicio") {
      els.applySync.disabled = false;
      els.forget.style.display = "none";
      els.syncStatus.textContent = "🔗 estimado por inicio (Δ " + best.delta.toFixed(0) + "s)";
      els.syncStatus.className = "ytds-sync-status paired saved";
    } else {
      els.applySync.disabled = true;
      els.forget.style.display = "none";
      els.syncStatus.textContent = "🔗 emparejado · cuadra y se guarda solo";
      els.syncStatus.className = "ytds-sync-status paired";
    }
  }

  let toastEl, toastTimer;
  function toast(msg, ms) {
    if (!panel) return;
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "ytds-toast";
      panel.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms || 2200);
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

  /** Engancha el evento 'seeked' del video para autosave (una sola vez por elemento). */
  function hookSeek() {
    const video = getVideo();
    if (!video || video.__ytdsSeekHooked) return;
    video.__ytdsSeekHooked = true;
    video.addEventListener("seeked", () => {
      if (Date.now() < sync.suppressUntil) return; // seek causado por applySync
      scheduleAutosave();
    });
  }

  /** Engancha 'play'/'pause' para replicarlos en la pareja (una vez por elemento). */
  function hookPlayPause() {
    const video = getVideo();
    if (!video || video.__ytdsPlayHooked) return;
    video.__ytdsPlayHooked = true;
    const relay = (action) => () => {
      if (Date.now() < sync.suppressPlayUntil) return; // cambio causado por la sync
      if (!sync.partner) return;
      sendCommand(action);
    };
    video.addEventListener("play", relay("play"));
    video.addEventListener("pause", relay("pause"));
  }

  /** Envía a la pareja un comando de reproducción ('play' | 'pause'). */
  async function sendCommand(action) {
    if (!storageOk() || !sync.partner) return;
    try {
      await chrome.storage.local.set({
        [CMD_KEY]: { to: sync.partner.sid, from: SESSION_ID, action, ts: Date.now() },
      });
    } catch (_) {}
  }

  /** Aplica un comando de reproducción recibido de la pareja, sin rebotar. */
  function applyCommand(cmd) {
    const video = getVideo();
    if (!video) return;
    sync.suppressPlayUntil = Date.now() + 1000;
    if (cmd.action === "pause") {
      video.pause();
    } else if (cmd.action === "play") {
      const p = video.play();
      if (p && p.catch) p.catch(() => {});
    }
  }

  /** Latido de coordinación: publica presencia, busca pareja y auto-sincroniza. */
  async function syncTick() {
    hookSeek();
    hookPlayPause();
    await heartbeat();
    await refreshPartner();
    sync.best = sync.partner ? await bestDelta() : null;
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
    sync.best = null;
    sync.mismatch = false;
    if (els.badge) {
      els.badge.textContent = "…";
      els.badge.className = "ytds-badge";
    }
    resolveMode();
    renderSync();
  });

  // Comandos play/pausa de la pareja: aplicamos en cuanto cambian en la pizarra.
  if (storageOk() && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[CMD_KEY]) return;
      const cmd = changes[CMD_KEY].newValue;
      if (cmd && cmd.to === SESSION_ID) applyCommand(cmd);
    });
  }

  // Al cerrar/ocultar la pestaña, retiramos nuestra presencia de la pizarra.
  window.addEventListener("pagehide", () => {
    if (!storageOk()) return;
    try {
      chrome.storage.local.remove(PRESENCE_PREFIX + SESSION_ID);
    } catch (_) {}
  });

  waitAndStart();
})();
