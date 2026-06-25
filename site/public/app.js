// YT Dual Sync — cliente para N videos. El backend calcula, para cada video, su
// desfase respecto al PRIMERO (la referencia). Embebemos todos con la IFrame
// Player API: la referencia es el maestro y el resto la siguen, cada uno con su
// delta (cuando el maestro está en t, el video i está en t − delta[i]).

let apiReady = false;
let apiFailed = false;
let players = []; // YT.Player[]; players[0] es el maestro
let deltas = []; // segundos que el maestro va por delante de cada video (deltas[0] = 0)
let driftTimer = null;
let durationMaster = 0;
let seeking = false; // el usuario está arrastrando el slider
let lastUrls = []; // para el botón "♺ audio"

window.onYouTubeIframeAPIReady = () => { apiReady = true; };
(function loadApi() {
  const s = document.createElement("script");
  s.src = "https://www.youtube.com/iframe_api";
  s.onerror = () => { apiFailed = true; };
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
function readUrls() {
  return $("urls").value.split(/\r?\n/).map((u) => u.trim()).filter(Boolean);
}

// --- Sincronizar (llamar al backend) ---------------------------------------

async function doSync() {
  const urls = readUrls();
  const rawPos = Number($("pos").value);
  const pos = Number.isFinite(rawPos) && rawPos >= 0 ? rawPos : 600;
  if (urls.length < 2) return setStatus("Pega al menos 2 URLs (una por línea).", "err");

  lastUrls = urls;
  $("sync").disabled = true;
  setStatus(`Calculando el desfase por audio de ${urls.length} videos… (descarga ~30 s de cada uno, puede tardar)`);
  try {
    const r = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls, pos }),
    });
    const res = await r.json();
    if (res.error) return setStatus("Error: " + res.error, "err");

    const ids = [res.master, ...res.items.map((it) => it.id)];
    deltas = [0, ...res.items.map((it) => it.delta)];
    const confs = res.items.map((it) => it.confidence.toFixed(2)).join(", ");
    setStatus(`Referencia + ${res.items.length} video(s) · conf [${confs}] — cargando…`,
      res.items.every((it) => it.confidence >= 0.25) ? "ok" : "");
    buildPlayers(ids, pos);
  } catch (e) {
    setStatus("Error de red: " + e, "err");
  } finally {
    $("sync").disabled = false;
  }
}

// --- Construir los reproductores -------------------------------------------

function buildPlayers(ids, pos) {
  let tries = 0;
  const start = () => {
    if (apiFailed) return setStatus("No se pudo cargar el reproductor de YouTube (¿bloqueado por una extensión o la red?).", "err");
    if (!apiReady || !window.YT || !YT.Player) {
      if (++tries > 100) return setStatus("El reproductor de YouTube tardó demasiado en cargar.", "err");
      return setTimeout(start, 100);
    }

    // Limpiar reproductores y celdas anteriores.
    players.forEach((p) => { try { p.destroy(); } catch {} });
    players = [];
    const stage = $("stage");
    stage.innerHTML = "";
    stage.hidden = false;
    $("controls").hidden = false;
    stage.style.setProperty("--cols", ids.length <= 1 ? 1 : ids.length <= 4 ? 2 : 3);

    const common = { rel: 0, modestbranding: 1, playsinline: 1, enablejsapi: 1, origin: location.origin };
    const onError = (e) => setStatus("YouTube no permite incrustar uno de los videos (código " + e.data + ").", "err");

    ids.forEach((id, i) => {
      const cell = document.createElement("section");
      cell.className = "cell";
      const tag = i === 0 ? "referencia" : `Δ ${deltas[i].toFixed(1)}s`;
      cell.innerHTML =
        `<div class="vidwrap"><div id="player${i}"></div></div>` +
        `<div class="vidlabel"><span class="tag">${tag}</span>` +
        `<button class="mute" data-idx="${i}" title="Silenciar este video">🔊</button></div>`;
      stage.appendChild(cell);

      const isMaster = i === 0;
      players[i] = new YT.Player(`player${i}`, {
        videoId: id,
        playerVars: { ...common, controls: isMaster ? 1 : 0 },
        events: {
          onError,
          onReady: (e) => {
            if (isMaster) {
              durationMaster = e.target.getDuration() || 0;
              $("seek").max = durationMaster || 100;
            }
            e.target.seekTo(Math.max(0, pos - deltas[i]), true);
          },
        },
      });
    });

    stage.querySelectorAll(".mute").forEach((b) =>
      b.addEventListener("click", () => toggleMute(Number(b.dataset.idx)))
    );

    window.__ytds = { players, deltas };
    startDriftLoop();
    setStatus("Listo. Pulsa ▶ Reproducir (o el play de la referencia). Los demás la siguen.", "ok");
  };
  start();
}

// --- Bucle de sincronía (corrige deriva y refleja play/pausa) ---------------

function ready() {
  return players.length >= 2 && players.every((p) => p && p.getCurrentTime && p.getPlayerState);
}

function startDriftLoop() {
  clearInterval(driftTimer);
  driftTimer = setInterval(() => {
    if (!ready()) return;
    const master = players[0];
    const tM = master.getCurrentTime();
    const sM = master.getPlayerState();

    for (let i = 1; i < players.length; i++) {
      const p = players[i];
      const target = Math.max(0, tM - deltas[i]);
      if (Math.abs(p.getCurrentTime() - target) > 0.3) p.seekTo(target, true);
      const sP = p.getPlayerState();
      if (sM === YT.PlayerState.PLAYING && sP !== YT.PlayerState.PLAYING) p.playVideo();
      // ENDED del maestro cuenta como pausa para los seguidores.
      if ((sM === YT.PlayerState.PAUSED || sM === YT.PlayerState.ENDED) && sP === YT.PlayerState.PLAYING) p.pauseVideo();
    }

    if (!seeking) $("seek").value = tM;
    $("time").textContent = `${fmt(tM)} / ${fmt(durationMaster)}`;
    $("playpause").textContent = sM === YT.PlayerState.PLAYING ? "⏸ Pausar" : "▶ Reproducir";
  }, 400);
}

// --- Controles unificados ---------------------------------------------------

function togglePlay() {
  if (!ready()) return;
  const playing = players[0].getPlayerState() === YT.PlayerState.PLAYING;
  players.forEach((p) => (playing ? p.pauseVideo() : p.playVideo()));
}

function seekTo(t) {
  if (!ready()) return;
  players[0].seekTo(t, true);
  for (let i = 1; i < players.length; i++) players[i].seekTo(Math.max(0, t - deltas[i]), true);
}

function toggleMute(i) {
  const p = players[i];
  if (!p || !p.isMuted) return;
  const btn = document.querySelector(`.mute[data-idx="${i}"]`);
  if (p.isMuted()) { p.unMute(); btn.textContent = "🔊"; btn.classList.remove("on"); }
  else { p.mute(); btn.textContent = "🔇"; btn.classList.add("on"); }
}

// Recalcular los desfases por audio en la posición actual (más preciso).
async function resyncHere() {
  if (!ready() || !lastUrls.length) return;
  const pos = Math.round(players[0].getCurrentTime());
  setStatus("Recalculando por audio en la posición actual…");
  try {
    const r = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls: lastUrls, pos }),
    });
    const res = await r.json();
    if (res.error) return setStatus("Error: " + res.error, "err");
    deltas = [0, ...res.items.map((it) => it.delta)];
    // reposicionar seguidores y refrescar etiquetas
    const tags = document.querySelectorAll(".cell .tag");
    for (let i = 1; i < players.length; i++) {
      players[i].seekTo(Math.max(0, players[0].getCurrentTime() - deltas[i]), true);
      if (tags[i]) tags[i].textContent = `Δ ${deltas[i].toFixed(1)}s`;
    }
    const confs = res.items.map((it) => it.confidence.toFixed(2)).join(", ");
    setStatus(`Re-sincronizado · conf [${confs}]`, res.items.every((it) => it.confidence >= 0.25) ? "ok" : "");
  } catch (e) {
    setStatus("Error de red: " + e, "err");
  }
}

// --- Eventos ----------------------------------------------------------------

$("sync").addEventListener("click", doSync);
$("playpause").addEventListener("click", togglePlay);
$("seek").addEventListener("pointerdown", () => { seeking = true; });
$("seek").addEventListener("pointerup", () => { seeking = false; });
$("seek").addEventListener("input", (e) => seekTo(Number(e.target.value)));
$("seek").addEventListener("change", () => { seeking = false; });
$("resync").addEventListener("click", resyncHere);
