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

## 2. Migrar a AudioWorklet (limpieza)

`offscreen.js` usa `ScriptProcessorNode` (deprecado → warning en `chrome://extensions`).
Migrar a `AudioWorkletNode`: archivo worklet aparte, `audioWorklet.addModule`, y
postear los buffers por `port`. Beneficio: sin warning y sin bloquear el hilo
principal. No urge (la captura funciona), es pulido.

## 3. Sitio / vista propia con ambos videos en una pestaña

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

## 4. Banco de pruebas automatizado (para acelerar el desarrollo)

Que Claude pueda **probar con muchos pares de directos sin navegador**, para
afinar el algoritmo y hacer pruebas masivas.

- Reutiliza `extension/lib/xcorr.js` (`estimateLag`) — ya corre en Node.
- Script/servicio Node con `yt-dlp`: descarga ~20–30 s de audio de dos URLs
  alrededor de un punto, submuestrea, corre `estimateLag`, reporta `offset` y
  `confidence`. Permite barrer decenas de pares y medir aciertos.
- Sirve también para validar el "cuadre por imagen" con clips de video.

---

## Estado actual (para contexto)

Fase 1 (manual + persistencia + estimación por hora de inicio) y Fase 2 (auto-sync
por audio: cross-correlación FFT, congelamiento de la pareja, anclaje por reloj de
pared) **funcionando**. Extras: play/pausa enlazados, no mezclar VOD/directo,
silenciar el stream desfasado. Detalle de implementación de Fase 2 en
[`fase-2-plan.md`](fase-2-plan.md).
