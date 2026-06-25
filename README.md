# YT Dual Sync

Extensión de Chrome (Manifest V3) para sincronizar dos directos de YouTube y ver ambos POV alineados en el tiempo.

## Estado

**Fase 1 — sync manual** ✅ (actual)
Panel flotante en cada pestaña para empujar el `currentTime` del live a mano y cuadrar dos directos.

**Fase 2 — sync automático** 🔜
Captura de audio con `chrome.tabCapture` + offscreen document, cross-correlación por FFT entre ambos directos para calcular el offset y corregirlo solo.

## Cómo funciona la sincronización

Ambos directos deben compartir señal de audio (están en call, mismo juego, se escuchan). La cross-correlación de ese audio común da el desfase relativo en milisegundos, mucho más fiable que el timestamp de inicio (latencia, buffer y OBS de cada quien lo arruinan).

## Limitaciones conocidas

- Solo se puede **retrasar** al directo que va adelante (el de atrás ya está en el live edge).
- El offset puede driftear en directos largos → recalcular periódicamente.
- Twitch low-latency tiene ventana de DVR corta; por ahora el foco es YT+YT.

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
