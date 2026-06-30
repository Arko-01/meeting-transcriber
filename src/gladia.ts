// Gladia v2 real-time (live) speech-to-text over a WebSocket.
//
// Unlike Groq (batch HTTP), Gladia streams: we open a session, push raw 16-bit
// PCM frames continuously, and receive partial + final transcripts pushed back.
// Purpose-built for low-resource languages like Bangla, with code-switching.
//
// Bring-your-own-key: the init POST carries the user's own key; audio goes
// directly browser → Gladia. (Verified: the init endpoint returns permissive
// CORS, and the WebSocket itself is not subject to CORS.)
import { CloudAuthError } from './cloud'

const INIT_URL = 'https://api.gladia.io/v2/live'

export type GladiaHandlers = {
  onPartial: (text: string) => void
  onFinal: (text: string) => void
  onError: (message: string) => void
  onClosed: () => void
}

function floatToInt16(block: Float32Array): ArrayBuffer {
  const out = new Int16Array(block.length)
  for (let i = 0; i < block.length; i++) {
    const s = Math.max(-1, Math.min(1, block[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out.buffer
}

export class GladiaLive {
  private ws: WebSocket | null = null
  private handlers: GladiaHandlers | null = null
  private closedByUs = false

  async start(opts: { apiKey: string; language: string; handlers: GladiaHandlers }) {
    this.handlers = opts.handlers
    const languages = opts.language === 'auto' ? ['bn', 'en'] : [opts.language]

    const body = {
      encoding: 'wav/pcm',
      bit_depth: 16,
      sample_rate: 16000,
      channels: 1,
      language_config: { languages, code_switching: true },
      messages_config: {
        receive_partial_transcripts: true,
        receive_final_transcripts: true,
        receive_speech_events: false,
        receive_pre_processing_events: false,
        receive_realtime_processing_events: false,
        receive_post_processing_events: false,
      },
    }

    let res: Response
    try {
      res = await fetch(INIT_URL, {
        method: 'POST',
        headers: { 'x-gladia-key': opts.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch {
      throw new Error('Could not reach Gladia (network or CORS). Check your connection.')
    }
    if (res.status === 401 || res.status === 403) {
      throw new CloudAuthError('Your Gladia API key was rejected. Check it in settings.')
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(`Gladia couldn’t start the session (${res.status}): ${t.slice(0, 160)}`)
    }
    const { url } = (await res.json()) as { url: string }
    await this.connect(url)
  }

  private connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'
      this.ws = ws
      let opened = false

      ws.onopen = () => {
        opened = true
        resolve()
      }
      ws.onerror = () => {
        if (!opened) reject(new Error('Could not open the Gladia live stream.'))
        else this.handlers?.onError('Gladia stream error.')
      }
      ws.onclose = () => {
        if (!this.closedByUs) this.handlers?.onClosed()
      }
      ws.onmessage = (e) => {
        let msg: { type?: string; data?: { is_final?: boolean; utterance?: { text?: string } }; message?: string }
        try {
          msg = JSON.parse(typeof e.data === 'string' ? e.data : '')
        } catch {
          return
        }
        if (msg?.type === 'transcript') {
          const text = (msg.data?.utterance?.text ?? '').trim()
          if (!text) return
          if (msg.data?.is_final) this.handlers?.onFinal(text)
          else this.handlers?.onPartial(text)
        } else if (msg?.type === 'error') {
          this.handlers?.onError(typeof msg.message === 'string' ? msg.message : 'Gladia reported an error.')
        }
      }
    })
  }

  send(block: Float32Array) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(floatToInt16(block))
    }
  }

  async stop() {
    this.closedByUs = true
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'stop_recording' }))
      }
    } catch {
      /* ignore */
    }
    try {
      this.ws?.close(1000)
    } catch {
      /* ignore */
    }
    this.ws = null
    this.handlers = null
  }
}
