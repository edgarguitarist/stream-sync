# tools — banco de pruebas

Validación del algoritmo de sincronización por audio **sin navegador**: descarga
audio real de YouTube (`yt-dlp` + `ffmpeg`), reutiliza el mismo `estimateLag` de la
extensión (`../extension/lib/xcorr.js`) y reporta el desfase y la confianza.

Permite probar muchos pares de directos/videos de forma automática.

## Requisitos

- Node 18+
- `ffmpeg` en el PATH
- `yt-dlp` (como módulo de Python: `pip install yt-dlp`; se invoca con `python -m yt_dlp`)

## Uso

```bash
# Por defecto pre-alinea por la hora de inicio del directo (rápido, ventana corta)
node tools/sync-probe.mjs <urlA> <urlB> --pos 700 --win 25

# Sin alinear (búsqueda a ciegas; usa ventana larga para que haya solape)
node tools/sync-probe.mjs <urlA> <urlB> --pos 600 --win 120 --no-align

# Posiciones distintas por video
node tools/sync-probe.mjs <urlA> <urlB> --posA 700 --posB 659 --win 25
```

Salida: JSON con `delta` (cuánto va A por delante de B, en segundos), `confidence`
(coef. de correlación normalizado, ≈0.2–0.5 con audio de llamada compartido) y
`lagSeconds` (residual respecto a la alineación por inicio).

`delta = posA − posB − lagAudio`.

## Resultados de referencia (verificados)

| Par | Δ medido | conf | Ground truth |
|---|---|---|---|
| Casino (Yh5… / Vq8…) | 39.6 s | 0.20 | 39.9 s (manual) |
| Bici (1EC… / a3Z…) | 45.6 s | 0.26 | 45.5 s (manual) |

## Sync por imagen (`visual-probe.mjs`)

Prototipo que correlaciona **actividad visual** (diferencia media entre frames,
con `ffmpeg`) en vez de audio — reutiliza el mismo `estimateLag`.

```bash
node tools/visual-probe.mjs <urlA> <urlB> --pos 800 --win 60
```

**Cuándo funciona** (verificado):

| Par | Δ visual | conf | ¿Correcto? |
|---|---|---|---|
| Bici (POV del mismo juego/eventos) | 46.0 s | 0.36 | ✓ (audio 45.6) |
| Casino (cada uno en su sala) | 35.2 s | 0.28 | ✗ (verdad 39.6) |

Conclusión: el sync por imagen **solo sirve si los dos POV comparten contenido
visual** (misma vista, o eventos sincronizados tipo co-op). Con POV independientes
da un pico espurio con confianza parecida, así que **la confianza visual sola no es
fiable** para decidir. Estrategia robusta: combinar audio + imagen y **fiarse de
donde coincidan** (o de la mayor confianza). Para juegos con **timer numérico**
visible, lo preciso sería OCR del timer (pendiente; requiere ubicar el timer + lib
de OCR).

## Archivos

- `sync-probe.mjs` — CLI de sync por audio.
- `visual-probe.mjs` / `visual.mjs` — sync por imagen (actividad de frames).
- `sync.mjs` — `computeSync` (audio), reutilizado por CLI y backend del sitio.
- `ytaudio.mjs` — descarga de secciones de audio + metadatos (`yt-dlp`), con reintentos.
- `wav.mjs` — lector de WAV → Float32Array mono.
