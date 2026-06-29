import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Set BASE_PATH to '/<repo-name>/' when deploying to a GitHub Pages project
// site. Defaults to '/' which works for Vercel / Netlify / custom domain / local.
const base = process.env.BASE_PATH ?? '/'

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icon.svg'],
      workbox: {
        // App shell only. Whisper model weights + ONNX runtime are streamed
        // from a CDN and cached by the browser's HTTP cache — never precache
        // them here (they are tens to hundreds of MB).
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      manifest: {
        name: 'Meeting Transcriber',
        short_name: 'Transcriber',
        description:
          'Private, on-device live transcription for meetings — English & Bangla.',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // transformers.js ships its own wasm/onnx assets; let Vite leave it alone.
    exclude: ['@huggingface/transformers'],
  },
})
