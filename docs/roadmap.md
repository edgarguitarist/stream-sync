# Roadmap / ideas futuras

Ideas de Edgar para llevar YT Dual Sync más allá. Pendientes de implementar; aquí
quedan con su diseño y sus retos técnicos para retomarlas cuando toque.

## Observación que motiva varias ideas: la latencia de la llamada

En juegos con timer visible (p. ej. *Try to Drive*) se ve el desfase residual
entre los dos POV: medido **~0.35–0.40 s constante** entre Vegetta y FaRgAnx.
Es la **latencia de la llamada** entre streamers y es **irreducible por audio**
(cada uno oye al otro con ese retraso → solo un audio puede cuadrar perfecto con
la acción). De ahí:

- Mutear el stream desfasado es la solución práctica (ya implementado).
- El **timer/HUD del juego** es una señal de sincronía más precisa que el audio
  cuando está visible → motiva el "cuadre por imagen".

---

## 1. Cuadre por imagen (visual sync) — ✅ prototipo en Node

Implementado en `tools/visual.mjs` + `visual-probe.mjs`: descarga video de baja
resolución con `yt-dlp`, extrae una señal de **actividad** (diferencia entre frames)
con `ffmpeg` y la cross-correlaciona con el mismo `estimateLag`.

Verificado: funciona cuando los POV **comparten contenido visual** (bici → Δ46,
conf 0.36, correcto) pero NO con POV independientes (casino → Δ35.2, conf 0.28,
incorrecto). La confianza visual sola no distingue → combinar con audio y fiarse de
donde coincidan.

Pendiente de precisión: **OCR de timer** para juegos con reloj numérico (exacto al
centésimo); requiere ubicar el timer + lib de OCR (`tesseract.js`). En el navegador,
capturar frames necesitaría `tabCapture` de video (el `<canvas>` del `<video>` de
YouTube queda *tainted* por CORS).

## 1b. Soporte de directos EN VIVO (pendiente de probar)

El algoritmo y la alineación por hora de inicio son los mismos para live y VOD; lo
que cambia son las restricciones físicas del directo:

- Solo se puede **retrasar** al que va adelante (no pasar del *live edge*).
- Ambos necesitan **DVR** con ventana suficiente para el offset.
- **Drift** en directos largos → re-sincronizar periódicamente (botón ♺ audio).
- yt-dlp sobre un live en curso: el contenido crece; `pos` es relativo a la ventana
  de DVR. Probar `--live-from-start` o targetear el live edge. Un modo "live" en el
  banco/sitio queda pendiente. No probado aún (no había directos disponibles).

## 2. Migrar a AudioWorklet (limpieza) — ✅ hecho

`offscreen.js` usa `ScriptProcessorNode` (deprecado → warning en `chrome://extensions`).
Migrar a `AudioWorkletNode`: archivo worklet aparte, `audioWorklet.addModule`, y
postear los buffers por `port`. Beneficio: sin warning y sin bloquear el hilo
principal. No urge (la captura funciona), es pulido.

## 3. Sitio / vista propia con ambos videos en una pestaña — ✅ hecho (N videos)

En vez de dos pestañas + captura secuencial + congelamiento, una **página propia**
que cargue ambos directos juntos y tome el audio de cada uno automáticamente.

- **Ventaja**: elimina la fricción del flujo actual (activeTab, dos clics, pausar
  la pareja). Captura "simultánea" conceptual.
- **Reto CORS**: si se embeben con iframe de YouTube, el audio sigue siendo
  cross-origin y `tabCapture` capturaría la **mezcla** de ambos, no separados.
- **Vía robusta = backend**: un servicio (p. ej. con `yt-dlp`) que extraiga el
  audio de cada URL y lo sirva *same-origin*; entonces sí se puede leer PCM y
  correlacionar (cliente o servidor). Es un proyecto mayor (servidor, dependencias,
  consideraciones legales/ToS), pero habilita la idea siguiente.

## 4. Banco de pruebas automatizado (para acelerar el desarrollo) — ✅ hecho

Que Claude pueda **probar con muchos pares de directos sin navegador**, para
afinar el algoritmo y hacer pruebas masivas.

- Reutiliza `extension/lib/xcorr.js` (`estimateLag`) — ya corre en Node.
- Script/servicio Node con `yt-dlp`: descarga ~20–30 s de audio de dos URLs
  alrededor de un punto, submuestrea, corre `estimateLag`, reporta `offset` y
  `confidence`. Permite barrer decenas de pares y medir aciertos.
- Sirve también para validar el "cuadre por imagen" con clips de video.

---

## Ideas pendientes (brainstorm)

Mejoras propuestas, agrupadas. ⭐ = mejor relación valor/esfuerzo.
Esfuerzo aproximado entre paréntesis: (bajo) / (medio) / (alto).

### Para ver mejor (UX del sitio)
- ⭐ **Modo spotlight/foco** *(medio)*: clic en un video → se hace grande y los demás
  quedan en una tira lateral (estilo multistream de Twitch). Para seguir un POV sin
  perder los otros.
- ⭐ **Atajos de teclado** *(bajo)*: espacio = play/pausa, ←/→ = seek, F = fullscreen,
  M = mutear el principal, 1/2/3 = elegir principal.
- **Clic para cambiar la referencia / reordenar** *(bajo)*: hoy la referencia es
  siempre la primera URL; poder elegirla en caliente.
- **Volumen por video (mezclador)** *(bajo)*: en vez de solo mute, oír dos a la vez
  balanceados con un slider por video.

### Para sincronizar mejor (precisión y robustez)
- ⭐ **Fusión audio + imagen** *(medio)*: correr `sync-probe` y `visual-probe` y
  fiarse de donde **coincidan** → resuelve de raíz el "¿es el video correcto?" y sube
  la confianza.
- **Precisión sub-muestra** *(bajo)*: interpolación parabólica del pico de la
  correlación para clavar el desfase por debajo de un frame.
- **OCR del timer** *(alto, frágil)*: exacto al centésimo en juegos con reloj. Requiere
  ubicar el timer + `tesseract.js` (ver §1).
- **Auto-elegir la mejor referencia** *(bajo)*: usar el video cuyo audio correlaciona
  mejor con el resto.
- **Re-sync automático contra drift** *(medio)*: en reproducciones largas, mini-chequeo
  periódico por audio que reajusta solo.

### Para compartir / escalar
- ⭐ **Link compartible** *(medio)*: codificar las URLs + desfases en el enlace (hash),
  para mandar un multiview **ya sincronizado** que el otro abre y le da play.
- **Caché de audio en el servidor** *(bajo)*: re-sincronizar un grupo conocido sería
  instantáneo incluso en otra máquina/navegador.
- **Sesiones guardadas con nombre** *(bajo)*: una lista de grupos para elegir, en vez
  de pegar URLs cada vez.
- **Soporte de directos en vivo** *(alto)*: DVR + sync al live edge + re-sync periódico
  (ver §1b).

### Distribución
- **Lanzador 1-clic** *(bajo)*: arranca el servidor y abre el navegador (encaja con los
  scripts/Pinokio de Edgar).
- **Publicar la extensión / empaquetar el sitio** *(medio)*: Chrome Web Store o un
  paquete listo para correr.

**Recomendación de arranque**: spotlight + atajos de teclado (UX con poco esfuerzo) y
link compartible (lo hace algo mostrable).

---

## Estado actual (para contexto)

- **Extensión** (Fase 1 + Fase 2): manual + persistencia + estimación por hora de
  inicio + auto-sync por audio (cross-correlación FFT, congelamiento de la pareja,
  anclaje por reloj de pared, AudioWorklet). Extras: play/pausa enlazados, no mezclar
  VOD/directo, silenciar el stream desfasado. Detalle en [`fase-2-plan.md`](fase-2-plan.md).
- **Banco de pruebas** (`tools/`): sync por audio y por imagen sin navegador; descargas
  en paralelo.
- **Sitio** (`site/`): N videos sincronizados (referencia + seguidores), modo inmersivo
  (barras flotantes), grid sin scroll, barrera de buffering, persistencia (URLs +
  desfases en caché + posición), botón principal/mute por video, pantalla completa.
