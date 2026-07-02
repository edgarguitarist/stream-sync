# CLAUDE.md

Guía para Claude Code (claude.ai/code) al trabajar en este repositorio.

**YT Dual Sync** sincroniza dos o más videos de YouTube (directos/live o VOD) para ver
varios POV alineados en el tiempo. El desfase entre POV se descubre por
**cross-correlación del audio compartido** (los streamers están en llamada y se
escuchan), con dos señales alternativas: la **hora de inicio** del directo y la
**correlación visual de la franja del timer** del juego. Todo comparte el mismo núcleo
de FFT (`extension/lib/xcorr.js`).

El repo tiene tres vías que resuelven el mismo problema:

- **`extension/`** — extensión de Chrome (Manifest V3) con panel flotante por pestaña.
- **`tools/`** — banco de pruebas en Node (descarga audio/video real, sin navegador).
- **`site/`** — página propia que carga N videos en una pestaña y los cuadra server-side.

## Comandos principales

Requisitos para `tools/` y `site/`: **Node 18+**, **ffmpeg** en el PATH y **yt-dlp**
como módulo de Python (`pip install yt-dlp`; se invoca con `python -m yt_dlp`). No hay
paso de build ni de instalación de dependencias (el proyecto no tiene dependencias npm;
`package.json` solo define scripts).

```bash
# Sitio (servidor HTTP + UI) → http://localhost:5178  (PORT para cambiarlo)
npm run site                # = node site/server.mjs

# Banco de pruebas por AUDIO (imprime JSON con delta/confidence/lag)
npm run sync-probe -- <urlA> <urlB> [--pos 600] [--win 30] [--rate 8000] [--no-align]

# Banco de pruebas por IMAGEN (actividad de frames)
npm run visual-probe -- <urlA> <urlB> [--pos 800] [--win 60]

# Banco de pruebas por TIMER del juego (correlación visual de la franja, N videos)
npm run timer-probe -- <url1> <url2> [url3...] [--win 42] [--pos 600]

# Test unitario del núcleo de cross-correlación (sin dependencias externas)
node extension/lib/xcorr.test.mjs
```

La extensión no se compila: en `chrome://extensions` activar **Modo de desarrollador**
y **Cargar descomprimida** apuntando a la carpeta `extension/`.

## Arquitectura

### Núcleo compartido
- `extension/lib/xcorr.js` — `estimateLag(a, b, sampleRate)`: FFT radix-2 propia +
  producto cruzado + IFFT para hallar el pico de correlación. Convención:
  `lagSeconds > 0` = `b` va retrasada respecto a `a`. `confidence` = coef. de
  correlación normalizado ∈ [0,1] (alto = audio compartido claro). Corre igual en
  navegador y en Node. Su test es `extension/lib/xcorr.test.mjs`.

### Extensión (`extension/`)
- `manifest.json` — MV3. Permisos: `storage`, `tabCapture`, `offscreen`, `activeTab`.
  Dos content scripts sobre `youtube.com/watch*` y `/live/*`: `bridge.js` (MAIN world)
  y `content.js` (mundo aislado). Service worker `background.js`.
- `bridge.js` — corre en el MAIN world; lee la API del reproductor de YouTube
  (`getPlayerResponse`, `getVideoData`, `getDuration`, `liveBroadcastDetails`) y la
  publica como atributos `data-*` en `<html>` (`data-ytds-islive`, `data-ytds-start`,
  `data-ytds-duration`) para que `content.js` la lea sin saltar el aislamiento de mundos.
- `content.js` — inyecta el panel flotante arrastrable, detecta **live vs VOD**,
  controla el `<video>` (seek/play/pausa/mute) y coordina las dos pestañas vía
  `chrome.storage.local` (presencia + comandos, sin depender del service worker).
  Persiste el desfase por par de videos y lo reaplica. Puntos de enganche expuestos en
  `window.__ytDualSync`: `nudge(delta)`, `goLive()`.
- Fase 2 (sync automático por audio): `background.js` captura audio con `tabCapture`
  (secuencial, una pestaña por clic del ícono) → `offscreen.html` + `offscreen.js`
  (AudioContext) → `capture-worklet.js` (AudioWorklet que lee PCM crudo). Los dos clips
  se alinean por reloj de evento y se cross-correlacionan; el desfase validado se guarda
  en `chrome.storage.local` bajo `ytds:pair:<low>|<high>`.

### Tools (`tools/`)
- `sync.mjs` — `computeSync` (2 videos) y `computeMulti` (N contra el primero) por audio.
  `delta = posA − posB − lagAudio` ("cuánto va A por delante de B").
- `timersync.mjs` — `computeTimerSync`: aísla la franja superior-central (ROI),
  binariza, resta la media por píxel (background subtraction) y correla la actividad del
  timer entre POV con ffmpeg. `confidence` = pico/media (≫1 = señal clara).
- `fusion.mjs` — `computeFused`: orquesta las fuentes por preferencia
  **timer > audio > hora de inicio**, con umbrales `TIMER_OK=6` / `AUDIO_OK=0.25`; corre
  audio y timer secuencialmente (evita saturar la red del live) con timeouts.
- `ytaudio.mjs` — descarga secciones de audio y metadatos vía `yt-dlp` (con reintentos),
  `ytId(url)`, `fetchMetaAsync`. `wav.mjs` — lee WAV → Float32Array mono.
- `visual.mjs` / `visual-probe.mjs` — prototipo de sync por actividad visual de frames.
- Los `*-probe.mjs` son las CLIs sobre estos módulos.

### Site (`site/`)
- `server.mjs` — servidor HTTP nativo. Sirve `public/` y expone `POST /api/sync`
  (`{urls:[...], pos}` o `{urlA,urlB}`). El cálculo pesado corre en un proceso hijo
  (`spawn`) para no bloquear el event loop; mata al hijo si el cliente se desconecta.
- `syncjob.mjs` — proceso hijo: llama a `computeFused` e imprime JSON.
- `public/app.js` — embebe los videos con la IFrame Player API de YouTube; video[0] es
  el maestro y cada video[i] sigue en `t − delta[i]`, con un bucle que corrige la deriva
  (>0.3 s) y refleja play/pausa. `index.html`, `style.css` — UI.

## Flujo de datos (server-side, la vía más completa)

`POST /api/sync` → `syncjob.mjs` → `computeFused` (fusion.mjs) → en paralelo por fuente:
`computeMulti` (audio, sync.mjs) y `computeTimerSync` (timer, timersync.mjs), ambos
apoyándose en `estimateLag`/correlación y en `yt-dlp` (ytaudio.mjs) → devuelve por video
seguidor su `delta`, `source`, `confidence` → `app.js` posiciona cada iframe.

## Estructura del repo

```
extension/            # Extensión Chrome MV3
  manifest.json
  bridge.js           # MAIN world: publica data-* del reproductor
  content.js          # panel flotante, live/VOD, control del <video>, sync entre pestañas
  panel.css
  background.js       # service worker: captura de audio (Fase 2)
  offscreen.html
  offscreen.js        # AudioContext para tabCapture
  capture-worklet.js  # AudioWorklet: PCM crudo
  lib/
    xcorr.js          # núcleo FFT de cross-correlación (compartido)
    xcorr.test.mjs    # test del núcleo
tools/                # Banco de pruebas en Node (requiere ffmpeg + yt-dlp)
  sync.mjs            # computeSync / computeMulti (audio)
  timersync.mjs       # computeTimerSync (timer del juego)
  fusion.mjs          # computeFused (timer > audio > inicio)
  visual.mjs          # sync por actividad visual (prototipo)
  ytaudio.mjs         # descarga + metadatos (yt-dlp)
  wav.mjs             # lector WAV → Float32Array
  sync-probe.mjs / visual-probe.mjs / timer-probe.mjs   # CLIs
site/                 # Página propia con N videos sincronizados
  server.mjs          # HTTP + POST /api/sync (no bloqueante)
  syncjob.mjs         # proceso hijo del cálculo
  public/             # index.html, app.js, style.css
docs/                 # roadmap.md, fase-2-plan.md
eng.traineddata       # datos Tesseract (OCR del timer; aún no cableado en el código)
package.json          # solo scripts, sin dependencias
README.md             # descripción de usuario (no duplicar aquí)
```

## Convenciones

- Todo en **español** (comentarios, mensajes de UI y de commit).
- JavaScript ES modules (`"type": "module"`), sin dependencias npm ni bundler; código
  de navegador y de Node comparten `xcorr.js` a propósito (mantenerlo agnóstico).
- Signo del desfase: `delta` = "cuánto va la referencia por delante del seguidor";
  cuando la referencia está en `t`, el seguidor debe estar en `t − delta`.
- Solo sincronizar videos del mismo tipo (nunca VOD con directo).
