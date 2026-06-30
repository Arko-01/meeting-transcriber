// Optional "cloud boost" — bring-your-own-key transcription.
//
// The user pastes their OWN free API key; audio goes directly from the browser
// to the provider and the key is stored only in this browser's localStorage.
// There is no server in between (so nothing for us to host or to leak the key).
// Trade-off vs on-device: audio leaves the device — surfaced clearly in the UI.

export type CloudProvider = 'groq' | 'gladia'

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
// large-v3 (not turbo) is the more accurate choice for low-resource languages
// like Bangla; Groq is fast enough that the speed difference is irrelevant.
const GROQ_MODEL = 'whisper-large-v3'

const KEY_STORES: Record<CloudProvider, string> = {
  groq: 'mt:cloud:groqKey:v1',
  gladia: 'mt:cloud:gladiaKey:v1',
}

export function loadKey(provider: CloudProvider): string {
  try {
    return localStorage.getItem(KEY_STORES[provider]) ?? ''
  } catch {
    return ''
  }
}

export function saveKey(provider: CloudProvider, key: string) {
  try {
    if (key) localStorage.setItem(KEY_STORES[provider], key)
    else localStorage.removeItem(KEY_STORES[provider])
  } catch {
    /* ignore */
  }
}

// 16 kHz mono Float32 → 16-bit PCM WAV blob (what the API expects).
export function encodeWav(samples: Float32Array, sampleRate = 16000): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const writeString = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeString(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  let off = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    off += 2
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

export class CloudAuthError extends Error {}

export async function transcribeCloud(opts: {
  audio: Float32Array
  apiKey: string
  language: string
  signal?: AbortSignal
}): Promise<string> {
  const form = new FormData()
  form.append('file', encodeWav(opts.audio), 'audio.wav')
  form.append('model', GROQ_MODEL)
  if (opts.language !== 'auto') form.append('language', opts.language)
  form.append('response_format', 'json')
  form.append('temperature', '0')

  let res: Response
  try {
    res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      body: form,
      signal: opts.signal,
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    // A TypeError here is almost always a CORS/network failure.
    throw new Error(
      'Could not reach the cloud service (network or CORS). Check your connection, or switch back to on-device mode.',
    )
  }

  if (res.status === 401 || res.status === 403) {
    throw new CloudAuthError('Your Groq API key was rejected. Check it in settings.')
  }
  if (res.status === 429) {
    throw new Error('Cloud rate limit reached — waiting a moment. (Free tier: ~20 requests/min.)')
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Cloud error ${res.status}: ${body.slice(0, 160)}`)
  }

  const json = (await res.json()) as { text?: string }
  return (json.text ?? '').trim()
}
