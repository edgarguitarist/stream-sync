# Fase 2 — Sync automático por audio

Objetivo: calcular el desfase entre dos videos **automáticamente**, para cualquier
par nuevo, sin que el usuario cuadre a mano. Funciona porque ambos POV comparten
señal de audio (están en call / mismo juego); la **cross-correlación** de ese audio
común da el desfase relativo en milisegundos.

> La Fase 1 ya cubre el caso de pares repetidos vía persistencia del desfase
> (`chrome.storage`, ver `content.js` → "Sync persistente entre pestañas").
> La Fase 2 resuelve el caso de pares **nuevos**.

## Restricción técnica que define la arquitectura

El `<video>` de YouTube es **cross-origin**. Si se engancha con Web Audio API
(`createMediaElementSource` + `AnalyserNode`), el grafo queda *tainted* y **no se
pueden leer las muestras PCM** (devuelve ceros / `SecurityError`). Por eso NO se
puede analizar el audio desde el content script directamente.

**Solución:** `chrome.tabCapture`, que captura la salida de audio de la pestaña a
nivel del navegador (sin restricción CORS). En MV3 esto obliga a:

- Un **offscreen document** (los service workers no tienen Web Audio / AudioContext).
- Iniciar la captura con `chrome.tabCapture.getMediaStreamId({ targetTabId })`
  desde el service worker, y consumir el stream en el offscreen con
  `getUserMedia({ audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId } } })`.
- Un **gesto del usuario** que dispare la captura (un botón "Auto-sync" en el panel).

## Componentes nuevos

```
extension/
  manifest.json        # + permisos: "tabCapture", "offscreen"; service_worker
  background.js        # service worker: orquesta captura de ambas pestañas y el cálculo
  offscreen.html/js    # AudioContext: graba ~10 s de cada pestaña, hace FFT + correlación
  content.js           # + botón "Auto-sync" y aplicación del offset recibido
```

## Flujo

1. Usuario abre los dos videos y pulsa **Auto-sync** en una pestaña (gesto).
2. `content.js` → mensaje al **service worker** con los `tabId` del par
   (la pareja ya se conoce vía la pizarra de presencia de la Fase 1).
3. Service worker crea el **offscreen document** y, con
   `getMediaStreamId({ targetTabId })` para CADA pestaña, le pasa ambos ids.
4. Offscreen graba **~10 s simultáneos** de ambas (mono, p. ej. 16 kHz), en una
   ventana donde el audio compartido sea claro (voces).
5. **Cross-correlación por FFT**: `corr = IFFT(FFT(a) · conj(FFT(b)))`; el índice
   del pico → lag en muestras → **offset en ms**. Validar con la altura del pico
   (relación pico/ruido) para descartar correlaciones espurias.
6. Resultado → service worker → `content.js` de la pestaña seguidora, que ajusta
   `video.currentTime` con `nudge()` / seek y **guarda el par** (reutiliza la
   persistencia de la Fase 1).

## Detalles y riesgos

- **Live edge**: en directo solo se puede *retrasar*; si el offset pide adelantar,
  avisar (limitación ya conocida). En VOD no aplica.
- **Drift** en directos largos: re-muestrear cada N minutos y re-correlacionar.
- **Sin audio compartido** (música distinta, uno silenciado): el pico será débil →
  reportar "no se pudo sincronizar" en vez de aplicar basura.
- **Captura de pestaña en segundo plano**: confirmar que `tabCapture` funciona sin
  foco; si no, capturar de a una.
- **Resampleo**: ambas capturas a la misma tasa antes de correlacionar.
- **Coste**: 10 s de mono a 16 kHz = 160k muestras; FFT de ~256k es instantánea.

## Reutilización desde la Fase 1

- Hooks ya expuestos en `window.__ytDualSync`: `nudge(delta)`, `goLive()`,
  `getVideo()`, `saveSync()`, `applySync()`.
- Emparejamiento de pestañas: pizarra de presencia en `chrome.storage.local`.
- Persistencia del par: `saveSync()` ya guarda `{ low, high, delta }`.
- Detección live/VOD: `detectMode()` vía `getVideoData().isLive`.

## Orden sugerido de implementación

1. Service worker + offscreen + permisos; probar capturar y graficar el nivel de
   audio de UNA pestaña (validar que `tabCapture` entrega PCM legible).
2. Capturar las DOS pestañas a la vez y guardar buffers.
3. ✅ **Cross-correlación FFT** sobre dos clips con offset conocido — hecho y
   probado en `extension/lib/xcorr.js` (+ `xcorr.test.mjs`). `estimateLag(a, b, sr)`
   devuelve `{ lagSamples, lagSeconds, confidence }`; confianza = coef. de
   correlación normalizado (≈0.9 audio compartido, ≈0.03 sin relación).
4. Cablear el botón "Auto-sync" → captura → `estimateLag` → seek + `saveSync()`.
5. Umbral de confianza para aceptar/rechazar el sync ("no sincronizable").
6. Recalcular periódico para drift (opcional).

### Hecho hasta ahora

- `extension/lib/xcorr.js` — FFT radix-2 + `estimateLag` (corre en navegador y Node).
- `extension/lib/xcorr.test.mjs` — `node extension/lib/xcorr.test.mjs` (todo OK).

### Paso 1 — andamiaje de captura ⏳ (a probar en el navegador)

- `background.js` (service worker) + `offscreen.html/js` + permisos `tabCapture`/`offscreen`.
- La captura se dispara desde el **ícono de la extensión** (`chrome.action.onClicked`):
  eso "invoca" la extensión y concede `activeTab`, que `tabCapture` exige. Un click
  dentro de la página NO basta (error: *"Extension has not been invoked… see activeTab"*).
- Reporta `samples / sampleRate / rms` en un toast. Valida que `tabCapture` entrega PCM.
- **Implicación para el flujo de 2 pestañas**: `activeTab` se concede por invocación y
  por pestaña → para VOD, capturar SECUENCIAL (invocar el ícono en cada pestaña), no
  simultáneo. El SW acumula ambos clips y correlaciona cuando tiene los dos.

### Pendiente

- Identificar el `tabId` de la pareja (buscar por `videoId` con `chrome.tabs.query`).
- Captura de AMBAS pestañas (secuencial para VOD: posicionar, reproducir, capturar
  ~8 s de cada una). Resampleo a 16 kHz.
- `estimateLag` sobre los dos clips → `{ lagSeconds, confidence }`.
- Umbral de confianza: aplicar y `saveSync()` si supera; si no, avisar "no coincide".
