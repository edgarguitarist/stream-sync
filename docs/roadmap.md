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

## 1. Cuadre por imagen (visual sync)

Sincronizar por el **video** además del audio, útil cuando comparten POV idéntico,
hay un **timer/HUD** en pantalla, o el audio no basta (música distinta, sin voces).

Dos enfoques:

- **OCR de timer** (preciso cuando hay reloj numérico): localizar el timer en cada
  stream, leerlo con OCR (p. ej. `tesseract.js`) y restar → desfase exacto al
  centésimo. Reto: ubicar el timer (config manual de la zona, o detección).
- **Correlación de frames** (POV compartido): capturar frames y alinear por
  similitud (template matching / hash perceptual). Más costoso y menos exacto.

Reto común: el `<video>` de YouTube es cross-origin → un `<canvas>` que lo dibuje
queda *tainted* y no deja leer píxeles (mismo muro CORS que el audio). Habría que
capturar el **video** con `tabCapture` (`chromeMediaSource: 'tab'` da video+audio)
y leer los frames de ese stream.

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
