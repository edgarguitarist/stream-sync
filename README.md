# YT Dual Sync

Extensión de Chrome (Manifest V3) para sincronizar dos videos de YouTube —**directos (live)** o **grabaciones (VOD)**— y ver ambos POV alineados en el tiempo.

## Estado

**Fase 1 — sync manual** ✅ (actual)
Panel flotante en cada pestaña para empujar el `currentTime` a mano y cuadrar dos videos. Detecta automáticamente si la pestaña es un **directo** o un **VOD** y adapta controles y lecturas.

**Fase 2 — sync automático** 🔜
Captura de audio con `chrome.tabCapture` + offscreen document, cross-correlación por FFT entre ambos directos para calcular el offset y corregirlo solo.

## Cómo funciona la sincronización

Ambos directos deben compartir señal de audio (están en call, mismo juego, se escuchan). La cross-correlación de ese audio común da el desfase relativo en milisegundos, mucho más fiable que el timestamp de inicio (latencia, buffer y OBS de cada quien lo arruinan).

## Live vs VOD

La extensión distingue el tipo de pestaña combinando señales (`video.duration` infinito, clase `.ytp-live` del cronómetro, badge "EN DIRECTO") y cambia el comportamiento:

| | **Directo (live)** | **VOD** |
|---|---|---|
| Badge | `EN DIRECTO` (rojo) | `VOD` (azul) |
| Seek | solo **retrasar** (no se pasa del live edge) | **adelantar y retrasar** dentro de `[0, duración]` |
| Lectura | `tras el live` (segundos detrás del borde) | `posición` (`mm:ss / mm:ss`) |
| Botón | `Ir al live` | `▶/⏸` play-pausa para cuadrar a mano |

## Limitaciones conocidas

- En **live** solo se puede **retrasar** al directo que va adelante (el de atrás ya está en el live edge). En **VOD** no hay esa restricción.
- El offset puede driftear en directos largos → recalcular periódicamente.
- Twitch low-latency tiene ventana de DVR corta; por ahora el foco es YouTube.

## Instalación (dev)

1. `chrome://extensions`
2. Activar **Modo de desarrollador**.
3. **Cargar descomprimida** → seleccionar la carpeta `extension/`.
4. Abrir cada live en su pestaña; aparece el panel arrastrable.

## Uso (Fase 1)

- En cada pestaña aparece el panel **YT Dual Sync**.
- Identifica cuál directo va **adelante** y retrásalo con los botones `-5s … -0.5s` hasta que ambos muestren el mismo momento.
- **offset**: desfase manual acumulado en esa pestaña.
- **behind live**: qué tan atrás del borde en vivo estás.
- **Ir al live**: vuelve al borde en vivo y resetea el offset.
- El panel es arrastrable (recuerda su posición) y minimizable.

## Estructura

```
extension/
  manifest.json   # MV3
  content.js      # inyecta el panel y controla el <video>
  panel.css       # estilos del panel
```

Los puntos de enganche para la Fase 2 son `nudge(delta)` y `goLive()` en `content.js`,
expuestos también en `window.__ytDualSync` para depuración.

## Licencia

MIT
