/// <reference lib="webworker" />
import {
  pipeline,
  env,
  type AutomaticSpeechRecognitionPipeline,
} from '@huggingface/transformers'

// Stream model + runtime from the CDN; never look for local model files.
env.allowLocalModels = false
// Single-threaded wasm fallback works without cross-origin isolation, so the
// app stays deployable on plain static hosts (GitHub Pages, etc.).
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.numThreads = 1
}

export type ModelId =
  | 'onnx-community/whisper-tiny'
  | 'onnx-community/whisper-base'
  | 'onnx-community/whisper-small'
  | 'onnx-community/whisper-large-v3-turbo'

export type Device = 'webgpu' | 'wasm'
export type Language = 'auto' | 'en' | 'bn'

type LoadMessage = {
  type: 'load'
  model: ModelId
  device: Device
}

type TranscribeMessage = {
  type: 'transcribe'
  // Audio as 16 kHz mono float samples (transferred ArrayBuffer).
  audio: ArrayBuffer
  language: Language
  requestId: number
  // Whether this buffer should be treated as a finalized segment.
  final: boolean
}

type InMessage = LoadMessage | TranscribeMessage

let transcriber: AutomaticSpeechRecognitionPipeline | null = null
let loadingKey: string | null = null

function dtypeFor(model: ModelId, device: Device) {
  // Whisper encoders are very quantization-sensitive, so keep them high
  // precision; the fp16 *decoder* is broken in transformers.js, so use q4.
  if (device !== 'webgpu') {
    return { encoder_model: 'q8', decoder_model_merged: 'q8' }
  }
  // large-v3-turbo: its fp32 encoder is ~2.5 GB. fp16 encoder (~1.3 GB) keeps
  // accuracy while halving the download; q4 decoder keeps it ~1.6 GB total.
  if (model === 'onnx-community/whisper-large-v3-turbo') {
    return { encoder_model: 'fp16', decoder_model_merged: 'q4' }
  }
  return { encoder_model: 'fp32', decoder_model_merged: 'q4' }
}

async function createPipeline(model: ModelId, device: Device) {
  const dtype = dtypeFor(model, device)

  return (await pipeline('automatic-speech-recognition', model, {
    device,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dtype: dtype as any,
    progress_callback: (p: unknown) => {
      self.postMessage({ type: 'progress', payload: p })
    },
  })) as AutomaticSpeechRecognitionPipeline
}

async function load(model: ModelId, device: Device) {
  const key = `${model}:${device}`
  if (transcriber && loadingKey === key) return
  loadingKey = key
  transcriber = null

  try {
    transcriber = await createPipeline(model, device)
    self.postMessage({ type: 'ready', model, device })
  } catch (err) {
    // `'gpu' in navigator` is true on many machines where requestAdapter()
    // actually fails (Linux, blocklisted drivers, VMs). Fall back to CPU so
    // the user gets working-if-slower transcription instead of a hard crash.
    if (device === 'webgpu') {
      self.postMessage({
        type: 'fallback',
        message: err instanceof Error ? err.message : String(err),
      })
      loadingKey = `${model}:wasm`
      transcriber = await createPipeline(model, 'wasm')
      self.postMessage({ type: 'ready', model, device: 'wasm' })
    } else {
      throw err
    }
  }
}

async function transcribe(msg: TranscribeMessage) {
  if (!transcriber) {
    self.postMessage({
      type: 'error',
      requestId: msg.requestId,
      message: 'Model not loaded yet.',
    })
    return
  }

  const audio = new Float32Array(msg.audio)

  // Skip near-silent buffers — saves a wasted inference pass.
  if (audio.length === 0) {
    self.postMessage({
      type: 'result',
      requestId: msg.requestId,
      final: msg.final,
      text: '',
    })
    return
  }

  try {
    const output = await transcriber(audio, {
      language: msg.language === 'auto' ? undefined : msg.language,
      task: 'transcribe',
      // Let the pipeline window long buffers internally.
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: false,
    })

    const text = Array.isArray(output)
      ? output.map((o) => o.text).join(' ')
      : output.text

    self.postMessage({
      type: 'result',
      requestId: msg.requestId,
      final: msg.final,
      text: (text ?? '').trim(),
    })
  } catch (err) {
    self.postMessage({
      type: 'error',
      requestId: msg.requestId,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

self.addEventListener('message', (e: MessageEvent<InMessage>) => {
  const msg = e.data
  if (msg.type === 'load') {
    load(msg.model, msg.device).catch((err) => {
      self.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    })
  } else if (msg.type === 'transcribe') {
    transcribe(msg)
  }
})
