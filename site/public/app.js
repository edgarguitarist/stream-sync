// YT Dual Sync — cliente. El backend calcula el desfase (delta) por audio; aquí
// embebemos ambos videos con la IFrame Player API y los mantenemos sincronizados:
// A es el "maestro", B sigue con un offset = delta (cuando A está en t, B en t−delta).

let apiReady = false;
let playerA = null;
let playerB = null;
let delta = 0; // segundos: cuánto va A por delante de B
let driftTimer = null;
let durationA = 0;

// Carga de la IFrame Player API.
window.onYouTubeIframeAPIReady = () => { apiReady = true; };
(function loadApi() {
  const s = document.createElement("script");
  s.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(s);
})();

const $ = (id) => document.getElementById(id);
function setStatus(msg, cls) {
  const el = $("status");
  el.textContent = msg;
  el.className = "status" + (cls ? " " + cls : "");
}
function fmt(t) {
  if (!isFinite(t)) return "0:00";
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// --- Sincronizar (llamar al backend) ---------------------------------------

async function doSync() {
  const urlA = $("urlA").value.trim();
  const urlB = $("urlB").value.trim();
  const pos = Number($("pos").value) || 600;
  if (!urlA || !urlB) return setStatus("Pega las dos URLs de YouTube.", "err");

  $("sync").disabled = true;
  setStatus("Calculando el desfase por audio… (descarga ~30 s de cada video, puede tardar)");
  try {
    const r = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urlA, urlB, pos }),
    });
    const res = await r.json();
    if (res.error) return setStatus("Error: " + res.error, "err");
    delta = res.delta;
    const verdict = res.confidence >= 0.25 ? "audio coincide" : res.confidence >= 0.12 ? "audio dudoso" : "audio NO coincide";
    setStatus(`Δ ${delta.toFixed(2)} s · ${verdict} (conf ${res.confidence.toFixed(2)}) — cargando videos…`, res.confidence >= 0.25 ? "ok" : "");
    buildPlayers(res.idA, res.idB, pos);
  } catch (e) {
    setStatus("Error de red: " + e, "err");
  } finally {
    $("sync").disabled = false;
  }
}

// --- Construir los reproductores -------------------------------------------

function buildPlayers(idA, idB, pos) {
  const start = () => {
    if (!apiReady || !window.YT || !YT.Player) return setTimeout(start, 100);
    $("stage").hidden = false;
    $("controls").hidden = false;
    if (playerA) { try { playerA.destroy(); } catch {} }
    if (playerB) { try { playerB.destroy(); } catch {} }

    const common = {
      rel: 0, modestbranding: 1, playsinline: 1,
      enablejsapi: 1, origin: location.origin,
    };
    const onError = (e) => setStatus("YouTube no permite incrustar uno de los videos (código " + e.data + ").", "err");

    playerA = new YT.Player("playerA", {
      videoId: idA,
      playerVars: { ...common, controls: 1 },
      events: {
        onError,
        onReady: (e) => {
          durationA = e.target.getDuration() || 0;
          $("seek").max = durationA || 100;
          e.target.seekTo(pos, true);
        },
      },
    });
    playerB = new YT.Player("playerB", {
      videoId: idB,
      playerVars: { ...common, controls: 0 },
      events: {
        onError,
        onReady: (e) => e.target.seekTo(pos - delta, true),
      },
    });
    window.__ytds = { get a() { return playerA; }, get b() { return playerB; }, get delta() { return delta; } };
    startDriftLoop();
    updateDeltaLabel();
    setStatus("Listo. Pulsa ▶ Reproducir (o el play de un video). El otro lo sigue.", "ok");
  };
  start();
}

// --- Bucle de sincronía (corrige deriva y refleja play/pausa) ---------------

function startDriftLoop() {
  clearInterval(driftTimer);
  driftTimer = setInterval(() => {
    if (!ready()) return;
    const tA = playerA.getCurrentTime();
    const targetB = tA - delta;
    if (Math.abs(playerB.getCurrentTime() - targetB) > 0.3) playerB.seekTo(targetB, true);

    const sA = playerA.getPlayerState();
    const sB = playerB.getPlayerState();
    if (sA === YT.PlayerState.PLAYING && sB !== YT.PlayerState.PLAYING) playerB.playVideo();
    if (sA === YT.PlayerState.PAUSED && sB === YT.PlayerState.PLAYING) playerB.pauseVideo();

    // refrescar UI
    $("seek").value = tA;
    $("time").textContent = `${fmt(tA)} / ${fmt(durationA)}`;
    $("playpause").textContent = sA === YT.PlayerState.PLAYING ? "⏸ Pausar" : "▶ Reproducir";
  }, 400);
}

function ready() {
  return playerA && playerB && playerA.getCurrentTime && playerB.getCurrentTime;
}

// --- Controles unificados ---------------------------------------------------

function togglePlay() {
  if (!ready()) return;
  const playing = playerA.getPlayerState() === YT.PlayerState.PLAYING;
  if (playing) { playerA.pauseVideo(); playerB.pauseVideo(); }
  else { playerA.playVideo(); playerB.playVideo(); }
}

function seekTo(t) {
  if (!ready()) return;
  playerA.seekTo(t, true);
  playerB.seekTo(t - delta, true);
}

function updateDeltaLabel() {
  $("deltaVal").textContent = delta.toFixed(1);
}

function nudge(d) {
  delta += d;
  updateDeltaLabel();
  if (ready()) playerB.seekTo(playerA.getCurrentTime() - delta, true);
}

function toggleMute(which) {
  const p = which === "A" ? playerA : playerB;
  if (!p || !p.isMuted) return;
  const btn = document.querySelector(`.mute[data-mute="${which}"]`);
  if (p.isMuted()) { p.unMute(); btn.textContent = "🔊"; btn.classList.remove("on"); }
  else { p.mute(); btn.textContent = "🔇"; btn.classList.add("on"); }
}

// Recalcular el desfase por audio en la posición actual (más preciso).
async function resyncHere() {
  if (!ready()) return;
  const pos = Math.round(playerA.getCurrentTime());
  const urlA = $("urlA").value.trim();
  const urlB = $("urlB").value.trim();
  setStatus("Recalculando por audio en la posición actual…");
  try {
    const r = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urlA, urlB, pos }),
    });
    const res = await r.json();
    if (res.error) return setStatus("Error: " + res.error, "err");
    delta = res.delta;
    updateDeltaLabel();
    playerB.seekTo(playerA.getCurrentTime() - delta, true);
    setStatus(`Δ ${delta.toFixed(2)} s · conf ${res.confidence.toFixed(2)}`, res.confidence >= 0.25 ? "ok" : "");
  } catch (e) {
    setStatus("Error de red: " + e, "err");
  }
}

// --- Eventos ----------------------------------------------------------------

$("sync").addEventListener("click", doSync);
$("playpause").addEventListener("click", togglePlay);
$("seek").addEventListener("input", (e) => seekTo(Number(e.target.value)));
$("resync").addEventListener("click", resyncHere);
document.querySelectorAll(".nudge").forEach((b) =>
  b.addEventListener("click", () => nudge(Number(b.dataset.nudge)))
);
document.querySelectorAll(".mute").forEach((b) =>
  b.addEventListener("click", () => toggleMute(b.dataset.mute))
);
