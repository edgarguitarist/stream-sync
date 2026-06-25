// YT Dual Sync — service worker (Fase 2).
// Orquesta la captura de audio: obtiene un stream de la pestaña con tabCapture
// y delega el procesamiento al offscreen document (los service workers no tienen
// AudioContext). Paso 1: prueba de captura (validar que llega PCM legible).

const OFFSCREEN_URL = "offscreen.html";

/** Crea el offscreen document si aún no existe. */
async function ensureOffscreen() {
  if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) return;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["USER_MEDIA"],
      justification: "Capturar el audio de la pestaña para sincronizar dos videos por cross-correlación.",
    });
  } catch (e) {
    // Si ya existe (carrera), ignoramos el error de duplicado.
    if (!String(e).includes("Only a single offscreen")) throw e;
  }
}

/** Captura `ms` milisegundos de audio de la pestaña `tabId` vía el offscreen. */
async function captureTab(tabId, ms) {
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: "offscreen", type: "capture", streamId, ms });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === "offscreen") return; // mensajes para el offscreen no son nuestros

  if (msg.type === "ytds-capture-test") {
    (async () => {
      try {
        const tabId = sender.tab && sender.tab.id;
        if (tabId == null) throw new Error("sin tabId del emisor");
        const res = await captureTab(tabId, msg.ms || 3000);
        sendResponse({ ok: true, ...res });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true; // respuesta asíncrona
  }
});
