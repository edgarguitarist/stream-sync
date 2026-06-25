// YT Dual Sync — service worker (Fase 2).
// Captura audio de cada pestaña (vía tabCapture + offscreen) y, cuando tiene dos
// clips de videos distintos, los cross-correlaciona para descubrir el desfase.
// La captura es SECUENCIAL: el usuario pulsa el ícono en cada pestaña (activeTab
// se concede por invocación, no se puede capturar dos pestañas a la vez).

import { estimateLag } from "./lib/xcorr.js";

const OFFSCREEN_URL = "offscreen.html";
const CAPTURE_MS = 8000; // duración de cada clip
const TARGET_RATE = 8000; // Hz tras submuestrear (voz < 4 kHz)

// Últimos clips capturados, máximo uno por videoId.
let clips = []; // { videoId, samples, rate, pos, mode, ts }

async function ensureOffscreen() {
  if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) return;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["USER_MEDIA"],
      justification: "Capturar el audio de la pestaña para sincronizar dos videos por cross-correlación.",
    });
  } catch (e) {
    if (!String(e).includes("Only a single offscreen")) throw e;
  }
}

async function captureTab(tabId) {
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await ensureOffscreen();
  return chrome.runtime.sendMessage({
    target: "offscreen",
    type: "capture",
    streamId,
    ms: CAPTURE_MS,
    targetRate: TARGET_RATE,
  });
}

function notify(tabId, text) {
  chrome.tabs.sendMessage(tabId, { type: "ytds-msg", text }).catch(() => {});
}

/**
 * Desfase entre los dos videos a partir del lag de audio y las posiciones de
 * captura. Si v_a estaba en pos_a y v_b en pos_b, y la cross-correlación da L
 * (v_b retrasado L respecto a v_a), el mismo instante del evento cumple
 * pos_a(v_a) ≡ (pos_b + L)(v_b). Entonces, en la convención pos(high) − pos(low):
 *   delta = (high === a ? (pos_a − pos_b) − L : (pos_b − pos_a) + L)
 */
function computeDelta(a, b, lagSeconds) {
  const [low, high] = [a.videoId, b.videoId].sort();
  if (high === a.videoId) {
    return { low, high, delta: a.pos - b.pos - lagSeconds };
  }
  return { low, high, delta: b.pos - a.pos + lagSeconds };
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id == null) return;
  let videoId = null;
  try {
    videoId = new URL(tab.url).searchParams.get("v");
  } catch (_) {}
  if (!videoId) {
    notify(tab.id, "✗ Abre un video de YouTube (no se reconoció el id).");
    return;
  }

  try {
    const state = await chrome.tabs.sendMessage(tab.id, { type: "ytds-get-state" }).catch(() => null);
    const res = await captureTab(tab.id);
    if (res && res.error) throw new Error(res.error);

    const clip = {
      videoId,
      samples: res.samples,
      rate: res.sampleRate,
      pos: state ? state.currentTime : null,
      mode: state ? state.mode : null,
      ts: Date.now(),
    };
    clips = clips.filter((c) => c.videoId !== videoId);
    clips.push(clip);
    if (clips.length > 2) clips = clips.slice(-2);

    const heard = res.rms > 0.0005;
    if (clips.length < 2) {
      notify(tab.id, `🎧 Capturado (${heard ? "audio ok" : "⚠ silencio"}). Ahora pulsa el ícono en la OTRA pestaña.`);
      return;
    }

    // Dos clips de videos distintos → correlacionar.
    const [c1, c2] = clips;
    if (c1.videoId === c2.videoId) {
      notify(tab.id, "🎧 Capturado. Falta la otra pestaña.");
      return;
    }
    const r = estimateLag(Float32Array.from(c1.samples), Float32Array.from(c2.samples), c1.rate);
    const { low, high, delta } = computeDelta(c1, c2, r.lagSeconds);

    if (r.confidence < 0.15) {
      notify(
        tab.id,
        `⚠ Audio no coincide (conf ${r.confidence.toFixed(2)}). ¿Son el mismo momento y ambos sonando?`
      );
      return;
    }
    notify(
      tab.id,
      `🔊 lagAudio ${r.lagSeconds.toFixed(2)}s · conf ${r.confidence.toFixed(2)} · Δ calculado ${delta.toFixed(1)}s ` +
        `(pos ${c1.videoId.slice(0, 4)}=${c1.pos != null ? c1.pos.toFixed(1) : "?"}, ${c2.videoId.slice(0, 4)}=${c2.pos != null ? c2.pos.toFixed(1) : "?"})`
    );
  } catch (e) {
    notify(tab.id, "✗ Captura falló: " + String((e && e.message) || e));
  }
});
