# Meeting Transcriber

A free, **100% on-device** PWA that listens to a meeting and transcribes it live —
in **English and Bangla**. Works with in-person meetings (microphone) and online
meetings like **Zoom, Google Meet, and Teams** (system / tab audio).

Nothing is uploaded. Speech recognition runs entirely in your browser using
[Whisper](https://github.com/openai/whisper) via
[🤗 Transformers.js](https://github.com/huggingface/transformers.js) with WebGPU
(falling back to CPU/WASM). The only network request is a **one-time model
download**; after that it works offline.

## How it works

- **Microphone** → captures in-person speech via `getUserMedia`.
- **System / tab audio** → captures Zoom/Meet/Teams via `getDisplayMedia`. The
  browser asks you to share a tab/window/screen — **tick “Share audio”** in that
  picker. You can use both sources at once (your mic + the remote speakers are
  mixed together).
- Audio is resampled to 16 kHz mono and fed to a Whisper model running in a Web
  Worker. Segments are finalized on natural pauses (or every ~20 s) and shown in
  a live, scrolling transcript you can copy or download as `.txt`.

## Using it with Zoom

1. Start your Zoom meeting (browser or desktop app — both work).
2. In this app, keep **System / tab audio** checked and press **Start transcribing**.
3. In the share picker:
   - Zoom **in a browser tab** → pick that tab and enable **Share tab audio**.
   - Zoom **desktop app** → pick **Entire Screen** and enable **Share system audio**
     (Chrome on Windows). This is what lets the app “hear” the desktop app.
4. To also capture your own voice, keep **Microphone** checked.

> Tip: Bangla accuracy is best with the **Small** model on a machine with WebGPU.
> On a low-end PC, use **Base** or **Tiny**, or switch Compute to **CPU**.

## Develop

```bash
npm install
npm run dev      # http://localhost:5173 — must be http://localhost or HTTPS for mic/screen capture
npm run build    # production build into dist/
npm run preview  # serve the production build locally
```

WebGPU requires a recent Chrome/Edge. Microphone and screen capture require a
**secure context** — `localhost` or HTTPS.

## Deploy (free)

The app is a static bundle — host it for free anywhere:

- **GitHub Pages** (project site): build with the repo path as base —
  `BASE_PATH=/<repo-name>/ npm run build` — then publish `dist/`.
- **Vercel / Netlify / Cloudflare Pages**: import the repo, framework “Vite”,
  build `npm run build`, output `dist/`. No env vars needed; `BASE_PATH` defaults
  to `/`.

No server, no API keys, no per-minute costs — ever.

## Models (on-device)

| Model | Size | Notes |
|-------|------|-------|
| Tiny  | ~40 MB  | Fastest, lowest accuracy |
| Base  | ~80 MB  | Fast, basic accuracy |
| Small | ~250 MB | **Default** — good balance |
| Large v3 Turbo | ~1.6 GB | Highest accuracy, needs a strong GPU (WebGPU) |

Model weights are streamed from the Hugging Face CDN on first use and cached by
the browser. They are **not** bundled or precached by the service worker.

## Cloud boost (optional)

Bangla is genuinely hard for Whisper at any size, so there's an optional
**bring-your-own-key cloud mode** for higher accuracy. Pick **Cloud boost** in the
Engine toggle and paste a free [Groq](https://console.groq.com/keys) API key — audio
is sent directly from your browser to Groq's Whisper `large-v3` (the key never
leaves your browser; there is no server in between).

Trade-offs, surfaced in the UI: **audio leaves your device** (don't use for
confidential meetings unless your policy allows it), the free tier is rate-limited
(~20 requests/min), and it's batch (finalized segments only — no per-word interim).
On-device remains the private default.
