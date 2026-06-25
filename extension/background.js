// YT Dual Sync — service worker (Fase 2).
// Captura audio de cada pestaña (vía tabCapture + offscreen) y, cuando tiene dos
// clips de videos distintos, los cross-correlaciona para descubrir el desfase.
// La captura es SECUENCIAL: el usuario pulsa el ícono en cada pestaña (activeTab
// se concede por invocación, no se puede capturar dos pestañas a la vez).

import { estimateLag } from "./lib/xcorr.js";

const OFFSCREEN_URL = "offscreen.html";
// Clips largos: la captura es secuencial y los videos avanzan entre un clic y
// otro, así que cada clip debe ser más largo que esa separación para que las
// dos ventanas de contenido se solapen.
const CAPTURE_MS = 20000;
const TARGET_RATE = 8000; // Hz tras submuestrear (voz < 4 kHz)

// Últimos clips capturados, máximo uno por videoId.
let clips = []; // { videoId, samples, rate, pos, startMs, mode, ts }

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
 * Correlaciona dos clips ALINEÁNDOLOS antes por tiempo de evento.
 *
 * Cada clip cubre, en epoch del evento real, [E, E+dur] con E = startMs + pos.
 * Como la captura es secuencial (los videos avanzan entre un clic y otro), esas
 * ventanas pueden no coincidir; recortamos ambos a su región de evento común y
 * solo entonces cross-correlacionamos. El lag resultante es el ERROR residual de
 * la estimación por hora de inicio (debería ser pequeño, < 1-2 s).
 *
 * @returns {{ok:boolean, reason?:string, overlap?:number, residual?:number,
 *   confidence?:number, deltaCorr?:number, low?:string, high?:string}}
 */
function correlateAligned(c1, c2) {
  if (c1.pos == null || c2.pos == null || c1.startMs == null || c2.startMs == null) {
    return { ok: false, reason: "faltan posición/hora de inicio (¿VOD de directo?)" };
  }
  const rate = Math.min(c1.rate, c2.rate);
  const dur1 = c1.samples.length / c1.rate;
  const dur2 = c2.samples.length / c2.rate;
  const e1 = c1.startMs / 1000 + c1.pos; // epoch-evento (s) del inicio del clip 1
  const e2 = c2.startMs / 1000 + c2.pos;

  const commonStart = Math.max(e1, e2);
  const commonEnd = Math.min(e1 + dur1, e2 + dur2);
  const overlap = commonEnd - commonStart;
  if (overlap < 2) {
    return { ok: false, reason: "los clips no se solapan", overlap };
  }

  const off1 = Math.max(0, Math.round((commonStart - e1) * rate));
  const off2 = Math.max(0, Math.round((commonStart - e2) * rate));
  const n = Math.floor(overlap * rate);
  const seg1 = Float32Array.from(c1.samples.slice(off1, off1 + n));
  const seg2 = Float32Array.from(c2.samples.slice(off2, off2 + n));

  const r = estimateLag(seg1, seg2, rate);

  // delta entre videos (convención pos(high) − pos(low)) = inicio(low) − inicio(high)
  // (estimación por hora de inicio) MÁS la corrección residual del audio.
  const [low, high] = [c1.videoId, c2.videoId].sort();
  const startLow = low === c1.videoId ? c1.startMs : c2.startMs;
  const startHigh = high === c1.videoId ? c1.startMs : c2.startMs;
  const deltaInicio = (startLow - startHigh) / 1000;
  // r.lagSeconds: seg2 retrasado respecto a seg1. La corrección al delta se
  // CALIBRA con la prueba real (puede requerir invertir el signo).
  const sign = high === c2.videoId ? 1 : -1;
  const deltaCorr = deltaInicio + sign * r.lagSeconds;

  return {
    ok: true,
    overlap,
    residual: r.lagSeconds,
    confidence: r.confidence,
    deltaInicio,
    deltaCorr,
    low,
    high,
  };
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
      startMs: state ? state.startMs : null,
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

    // Dos clips de videos distintos → correlacionar (alineados por evento).
    const [c1, c2] = clips;
    if (c1.videoId === c2.videoId) {
      notify(tab.id, "🎧 Capturado. Falta la otra pestaña.");
      return;
    }
    const out = correlateAligned(c1, c2);
    if (!out.ok) {
      notify(tab.id, `⚠ No se pudo correlacionar: ${out.reason}` + (out.overlap != null ? ` (solape ${out.overlap.toFixed(1)}s)` : ""));
      return;
    }
    if (out.confidence < 0.15) {
      notify(
        tab.id,
        `⚠ Audio no coincide (conf ${out.confidence.toFixed(2)}, solape ${out.overlap.toFixed(1)}s). ¿Ambos sonando y casi cuadrados?`
      );
      return;
    }
    notify(
      tab.id,
      `🔊 residual ${out.residual.toFixed(2)}s · conf ${out.confidence.toFixed(2)} · solape ${out.overlap.toFixed(1)}s · Δinicio ${out.deltaInicio.toFixed(1)} → Δcorr ${out.deltaCorr.toFixed(1)}s`
    );
  } catch (e) {
    notify(tab.id, "✗ Captura falló: " + String((e && e.message) || e));
  }
});
