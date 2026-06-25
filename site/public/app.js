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
let wantPlay = false; // intención del usuario (reproducir / pausar) — la barrera la respeta
let principalIdx = -1; // video "principal": si ≥0, solo ese se escucha
let lastUrls = []; // para el botón "♺ audio"

/** Columnas y filas del grid para que N videos quepan sin scroll. */
function gridDims(n) {
  if (n <= 1) return [1, 1];
  if (n === 2) return [2, 1];
  if (n <= 4) return [2, 2];
  if (n <= 6) return [3, 2];
  if (n <= 9) return [3, 3];
  const cols = Math.ceil(Math.sqrt(n));
  return [cols, Math.ceil(n / cols)];
}

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

// --- Persistencia (localStorage): URLs, desfases y posición ----------------

let currentKey = null; // clave del conjunto de videos actual
function ls(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
function ytId(u) {
  const s = String(u).trim();
  const m = s.match(/(?:v=|youtu\.be\/|\/live\/|\/shorts\/|\/embed\/)([\w-]{11})/);
  return m ? m[1] : s;
}
function keyFor(urls) { return urls.map(ytId).join("|"); }
function loadCache(key) { try { const r = ls("ytds:sync:" + key); return r ? JSON.parse(r) : null; } catch { return null; } }
function saveCache(key, res) { lsSet("ytds:sync:" + key, JSON.stringify({ master: res.master, items: res.items })); }
function savedPos(key) { const v = ls("ytds:pos:" + key); return v == null ? null : Number(v); }

// --- Sincronizar -----------------------------------------------------------

async function doSync(restore = false) {
  const urls = readUrls();
  if (urls.length < 2) { if (!restore) setStatus("Pega al menos 2 URLs (una por línea).", "err"); return; }
  const rawPos = Number($("pos").value);
  const posInput = Number.isFinite(rawPos) && rawPos >= 0 ? rawPos : 600;

  lastUrls = urls;
  lsSet("ytds:lastUrls", urls.join("\n"));
  const key = keyFor(urls);
  currentKey = key;

  let res = loadCache(key); // ¿ya calculamos estos videos antes?
  if (res) {
    setStatus(restore ? "Restaurado (desfases y posición guardados)." : "Usando desfases guardados · ♺ audio para refinar.", "ok");
  } else {
    $("sync").disabled = true;
    setStatus(`Calculando el desfase por audio de ${urls.length} videos… (puede tardar)`);
    try {
      const r = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls, pos: posInput }),
      });
      res = await r.json();
      if (res.error) { setStatus("Error: " + res.error, "err"); return; }
      saveCache(key, res);
      const confs = res.items.map((it) => it.confidence.toFixed(2)).join(", ");
      setStatus(`Referencia + ${res.items.length} video(s) · conf [${confs}] — cargando…`,
        res.items.every((it) => it.confidence >= 0.25) ? "ok" : "");
    } catch (e) {
      setStatus("Error de red: " + e, "err");
      return;
    } finally {
      $("sync").disabled = false;
    }
  }

  deltas = [0, ...res.items.map((it) => it.delta)];
  const ids = [res.master, ...res.items.map((it) => it.id)];
  // Al restaurar, retoma donde se quedó; en un Sincronizar explícito usa el campo pos.
  const sp = savedPos(key);
  const startPos = restore && sp != null ? sp : posInput;
  buildPlayers(ids, startPos);
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
    wantPlay = false;
    principalIdx = -1;
    const stage = $("stage");
    stage.innerHTML = "";
    stage.hidden = false;
    $("controls").hidden = false;
    const [cols, rows] = gridDims(ids.length);
    stage.style.setProperty("--cols", cols);
    stage.style.setProperty("--rows", rows);

    const common = { rel: 0, modestbranding: 1, playsinline: 1, enablejsapi: 1, origin: location.origin };
    const onError = (e) => setStatus("YouTube no permite incrustar uno de los videos (código " + e.data + ").", "err");

    ids.forEach((id, i) => {
      const cell = document.createElement("section");
      cell.className = "cell";
      const tag = i === 0 ? `<span class="tag ref">referencia</span>` : `<span class="tag">Δ ${deltas[i].toFixed(1)}s</span>`;
      cell.innerHTML =
        `<div id="player${i}"></div>` +
        `<div class="vidlabel">${tag}` +
        `<button class="star" data-idx="${i}" title="Principal: escuchar solo este">★</button>` +
        `<button class="mute" data-idx="${i}" title="Silenciar este video">🔊</button></div>`;
      stage.appendChild(cell);

      const isMaster = i === 0;
      players[i] = new YT.Player(`player${i}`, {
        videoId: id,
        playerVars: { ...common, controls: 0 }, // control unificado abajo
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
    stage.querySelectorAll(".star").forEach((b) =>
      b.addEventListener("click", () => togglePrincipal(Number(b.dataset.idx)))
    );

    window.__ytds = { players, deltas };
    startDriftLoop();
    setStatus("Listo. ▶ Reproducir — los demás siguen a la referencia.", "ok");
    enterImmersive();
  };
  start();
}

// --- Modo inmersivo (barras flotantes que aparecen al acercar el mouse) -----

let revealTimer = null;
function enterImmersive() {
  document.body.classList.add("immersive");
  // Revela las barras un momento para que se vea dónde están, luego se ocultan.
  $("bar").classList.add("show");
  $("controls").classList.add("show");
  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => {
    $("bar").classList.remove("show");
    $("controls").classList.remove("show");
  }, 2500);
}

document.addEventListener("mousemove", (e) => {
  if (!document.body.classList.contains("immersive")) return;
  const h = window.innerHeight;
  $("bar").classList.toggle("show", e.clientY < 80);
  $("controls").classList.toggle("show", e.clientY > h - 80);
});

// --- Bucle de sincronía (corrige deriva y refleja play/pausa) ---------------

function ready() {
  return players.length >= 2 && players.every((p) => p && p.getCurrentTime && p.getPlayerState);
}

function startDriftLoop() {
  clearInterval(driftTimer);
  const BUF = YT.PlayerState.BUFFERING, PLAY = YT.PlayerState.PLAYING, END = YT.PlayerState.ENDED;
  driftTimer = setInterval(() => {
    if (!ready()) return;
    const states = players.map((p) => p.getPlayerState());
    const tM = players[0].getCurrentTime();
    // Alguien cargando (buffering) o aún sin arrancar mientras queremos reproducir.
    const anyStalled = states.some((s, i) => s === BUF || (wantPlay && i > 0 && s !== PLAY && s !== END && Math.abs(players[i].getCurrentTime() - Math.max(0, tM - deltas[i])) > 1.5));

    // Corregir deriva solo en los que NO están cargando (re-seekear uno que
    // carga lo empeora).
    for (let i = 1; i < players.length; i++) {
      if (states[i] === BUF) continue;
      const target = Math.max(0, tM - deltas[i]);
      if (Math.abs(players[i].getCurrentTime() - target) > 0.4) players[i].seekTo(target, true);
    }

    // Barrera: si queremos reproducir pero alguien está cargando, ESPERAMOS
    // (pausamos a los que van) hasta que todos estén listos; entonces, todos.
    if (wantPlay && anyStalled) {
      players.forEach((p, i) => { if (states[i] === PLAY) p.pauseVideo(); });
    } else if (wantPlay) {
      players.forEach((p, i) => { if (states[i] !== PLAY && states[i] !== END) p.playVideo(); });
    } else {
      players.forEach((p, i) => { if (states[i] === PLAY) p.pauseVideo(); });
    }

    if (!seeking) $("seek").value = tM;
    const waiting = wantPlay && anyStalled ? " · esperando…" : "";
    $("time").textContent = `${fmt(tM)} / ${fmt(durationMaster)}${waiting}`;
    $("playpause").textContent = wantPlay ? "⏸ Pausar" : "▶ Reproducir";
  }, 300);
}

// --- Controles unificados ---------------------------------------------------

function togglePlay() {
  if (!ready()) return;
  wantPlay = !wantPlay; // intención; la barrera del bucle la hace cumplir
  players.forEach((p) => (wantPlay ? p.playVideo() : p.pauseVideo()));
}

function seekTo(t) {
  if (!ready()) return;
  players[0].seekTo(t, true);
  for (let i = 1; i < players.length; i++) players[i].seekTo(Math.max(0, t - deltas[i]), true);
}

function setMuteUI(i, muted) {
  const btn = document.querySelector(`.mute[data-idx="${i}"]`);
  if (btn) { btn.textContent = muted ? "🔇" : "🔊"; btn.classList.toggle("on", muted); }
}

function toggleMute(i) {
  const p = players[i];
  if (!p || !p.isMuted) return;
  if (p.isMuted()) { p.unMute(); setMuteUI(i, false); }
  else { p.mute(); setMuteUI(i, true); }
}

/** Marca un video como "principal": solo ese se escucha (mutea los demás).
 *  Volver a pulsarlo quita el modo principal y reactiva el audio de todos. */
function togglePrincipal(i) {
  principalIdx = principalIdx === i ? -1 : i;
  players.forEach((p, j) => {
    if (!p || !p.mute) return;
    const muted = principalIdx !== -1 && j !== principalIdx;
    muted ? p.mute() : p.unMute();
    setMuteUI(j, muted);
    const sb = document.querySelector(`.star[data-idx="${j}"]`);
    if (sb) sb.classList.toggle("on", principalIdx === j);
  });
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
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
    if (currentKey) saveCache(currentKey, res); // guardar los desfases refinados
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

$("sync").addEventListener("click", () => doSync(false));
$("playpause").addEventListener("click", togglePlay);
$("seek").addEventListener("pointerdown", () => { seeking = true; });
$("seek").addEventListener("pointerup", () => { seeking = false; });
$("seek").addEventListener("input", (e) => seekTo(Number(e.target.value)));
$("seek").addEventListener("change", () => { seeking = false; });
$("resync").addEventListener("click", resyncHere);
$("fs").addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", () => {
  $("fs").textContent = document.fullscreenElement ? "🗗" : "⛶";
  $("fs").title = document.fullscreenElement ? "Salir de pantalla completa" : "Pantalla completa";
});

// Guarda la posición actual cada 3 s para retomarla al recargar.
setInterval(() => {
  if (currentKey && players[0] && players[0].getCurrentTime) {
    lsSet("ytds:pos:" + currentKey, String(Math.round(players[0].getCurrentTime())));
  }
}, 3000);

// Al cargar la página: repuebla las URLs y, si ya tenemos los desfases en caché,
// restaura todo automáticamente (sin recalcular) en la última posición.
(function restoreOnLoad() {
  const saved = ls("ytds:lastUrls");
  if (!saved) return;
  $("urls").value = saved;
  const urls = saved.split(/\r?\n/).map((u) => u.trim()).filter(Boolean);
  if (urls.length >= 2 && loadCache(keyFor(urls))) doSync(true);
})();
