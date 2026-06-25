# site — vista propia con ambos videos sincronizados

Alternativa a la extensión: una página que carga **ambos videos en una sola
pestaña** y los sincroniza automáticamente. El desfase se calcula **en el servidor**
(con `yt-dlp`, sin el muro CORS del navegador) y los videos se embeben con la
**IFrame Player API** de YouTube, ya alineados.

## Por qué bypassa la extensión

- No hay captura de audio en el navegador → sin `tabCapture`, `activeTab`, ni el
  flujo de congelar/capturar de a una pestaña.
- El audio se descarga server-side a calidad completa y se correlaciona con el mismo
  `estimateLag` que usa la extensión.

## Arquitectura

```
site/
  server.mjs        # HTTP: sirve la página y POST /api/sync (no bloqueante)
  syncjob.mjs       # proceso hijo: computeSync → JSON (aísla la descarga + FFT)
  public/
    index.html      # UI: 2 URLs, controles unificados, mute por video
    app.js          # IFrame Player API + sincronía maestro/seguidor + deriva
    style.css
```

- `POST /api/sync {urlA, urlB, pos}` → `{ delta, confidence, startMs..., duration... }`.
  El cálculo corre en un proceso hijo (`spawn`), así el servidor no se bloquea
  durante la descarga (~30–60 s) ni muere si `yt-dlp` falla.
- `app.js`: A es el **maestro**, B el **seguidor** en `t − delta`. Un bucle corrige
  la deriva (>0.3 s) y refleja play/pausa. Botones de mute por video y nudge ±0.5 s.

## Uso

```bash
node site/server.mjs            # → http://localhost:5178
# (requiere ffmpeg + yt-dlp, igual que tools/)
```

Abre la página, pega dos URLs del mismo evento (dos POV), pulsa **Sincronizar**,
y luego **▶ Reproducir**. Mutea el stream desfasado (latencia de la llamada) para
que se sienta natural.

## Estado / verificado

- Backend `/api/sync`: ✓ (Δ casino 39.6, Δ bici 45.6, no bloqueante).
- UI + posicionamiento sincronizado: ✓ (A y B quedan exactamente a `delta`).
- Reproducción en vivo: probar en navegador real (el sandbox de automatización
  bloquea el autoplay; el posicionamiento sí se verificó exacto).
