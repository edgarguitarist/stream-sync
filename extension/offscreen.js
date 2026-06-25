// YT Dual Sync — offscreen document (Fase 2).
// Aloja el AudioContext: recibe un streamId de captura de pestaña, graba PCM y
// devuelve métricas (paso 1) o, más adelante, las muestras para correlacionar.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return;

  if (msg.type === "capture") {
    capturePcm(msg.streamId, msg.ms || 3000, msg.targetRate || 8000)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String((e && e.message) || e) }));
    return true; // respuesta asíncrona
  }
});

/** Concatena los chunks en un solo Float32Array. */
function concat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Submuestrea por promediado de bloques (anti-alias básico) a `toRate`. */
function downsample(full, fromRate, toRate) {
  if (toRate >= fromRate) return full;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(full.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.floor((i + 1) * ratio);
    let s = 0, n = 0;
    for (let j = start; j < end && j < full.length; j++) {
      s += full[j];
      n++;
    }
    out[i] = n ? s / n : 0;
  }
  return out;
}

/**
 * Captura `ms` ms de audio de la pestaña, lo submuestrea a `targetRate` y
 * devuelve las muestras (como Array para poder serializarlas por mensaje).
 * @returns {Promise<{samples:number[], sampleRate:number, rms:number, count:number, durationMs:number}>}
 */
async function capturePcm(streamId, ms, targetRate) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
  });

  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);

  // tabCapture silencia la pestaña para el usuario mientras se captura; al
  // reconectar el stream a la salida, el usuario sigue oyendo normalmente.
  src.connect(ctx.destination);

  // AudioWorklet para leer las muestras crudas (sin bloquear el hilo principal).
  await ctx.audioWorklet.addModule(chrome.runtime.getURL("capture-worklet.js"));
  const node = new AudioWorkletNode(ctx, "ytds-capture");
  const chunks = [];
  let wallStart = null; // reloj de pared del PRIMER bloque de audio real
  node.port.onmessage = (e) => {
    if (e.data === "started") {
      if (wallStart === null) wallStart = Date.now();
      return;
    }
    chunks.push(e.data); // Float32Array (transferida)
  };
  src.connect(node);
  node.connect(ctx.destination);

  await new Promise((r) => setTimeout(r, ms));
  node.port.postMessage("flush"); // vaciar lo último acumulado
  await new Promise((r) => setTimeout(r, 60));

  node.disconnect();
  src.disconnect();
  stream.getTracks().forEach((t) => t.stop());
  const fromRate = ctx.sampleRate;
  await ctx.close();

  const full = concat(chunks);
  let sumSq = 0;
  for (let i = 0; i < full.length; i++) sumSq += full[i] * full[i];
  const rms = full.length ? Math.sqrt(sumSq / full.length) : 0;

  const ds = downsample(full, fromRate, targetRate);
  return {
    samples: Array.from(ds),
    sampleRate: Math.min(targetRate, fromRate),
    rms,
    count: full.length,
    durationMs: ms,
    wallStart, // reloj de pared del inicio real del audio capturado
  };
}
