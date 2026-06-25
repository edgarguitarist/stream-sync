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
# Ventana larga, búsqueda a ciegas (lento: descarga ~win s de cada uno)
node tools/sync-probe.mjs <urlA> <urlB> --pos 600 --win 120

# Pre-alineado por hora de inicio del directo (rápido: ventana corta basta)
node tools/sync-probe.mjs <urlA> <urlB> --pos 700 --win 25 --align

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

## Archivos

- `sync-probe.mjs` — CLI principal.
- `ytaudio.mjs` — descarga de secciones de audio + metadatos (`yt-dlp`), con reintentos.
- `wav.mjs` — lector de WAV → Float32Array mono.
