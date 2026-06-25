// YT Dual Sync — offscreen document (Fase 2).
// Aloja el AudioContext: recibe un streamId de captura de pestaña, graba PCM y
// devuelve métricas (paso 1) o, más adelante, las muestras para correlacionar.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return;

  if (msg.type === "capture") {
    capturePcm(msg.streamId, msg.ms || 3000)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String((e && e.message) || e) }));
    return true; // respuesta asíncrona
  }
});

/**
 * Captura `ms` ms de audio del stream de pestaña y devuelve métricas del PCM.
 * @returns {Promise<{samples:number, sampleRate:number, rms:number, peak:number, durationMs:number}>}
 */
async function capturePcm(streamId, ms) {
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

  // ScriptProcessor (deprecado pero universal) para leer las muestras crudas.
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  proc.onaudioprocess = (e) => {
    chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  src.connect(proc);
  proc.connect(ctx.destination);

  await new Promise((r) => setTimeout(r, ms));

  proc.disconnect();
  src.disconnect();
  stream.getTracks().forEach((t) => t.stop());
  const sampleRate = ctx.sampleRate;
  await ctx.close();

  let count = 0, sumSq = 0, peak = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      const v = c[i];
      sumSq += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      count++;
    }
  }
  const rms = count ? Math.sqrt(sumSq / count) : 0;
  return { samples: count, sampleRate, rms, peak, durationMs: ms };
}
