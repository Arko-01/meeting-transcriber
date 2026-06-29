import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import { AudioCapture, SAMPLE_RATE } from './audio'
import type { Device, Language, ModelId } from './worker'

// --- tuning -----------------------------------------------------------------
const MIN_INTERIM_S = 1.5 // don't transcribe until we have this much audio
const MIN_COMMIT_S = 3.5 // shortest segment we'll finalize on a pause
const MAX_SEGMENT_S = 20 // force-finalize a segment this long even without a pause
const SILENCE_MS = 1100 // a pause this long finalizes the current segment
const VOICE_LEVEL = 0.06 // RMS level (0..1) above which we consider it speech
const TICK_MS = 1200 // how often we re-evaluate the buffer

type Status = 'idle' | 'loading' | 'ready' | 'recording'

type Segment = { id: number; text: string }

const MODELS: { id: ModelId; label: string; note: string }[] = [
  { id: 'onnx-community/whisper-tiny', label: 'Tiny', note: 'fastest · ~40 MB · lowest accuracy' },
  { id: 'onnx-community/whisper-base', label: 'Base', note: 'balanced · ~80 MB · recommended' },
  { id: 'onnx-community/whisper-small', label: 'Small', note: 'best Bangla · ~250 MB · needs a strong PC' },
]

const LANGUAGES: { id: Language; label: string }[] = [
  { id: 'auto', label: 'Auto-detect' },
  { id: 'en', label: 'English' },
  { id: 'bn', label: 'বাংলা / Bangla' },
]

function flatten(chunks: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

export default function App() {
  const [status, setStatus] = useState<Status>('idle')
  const [progress, setProgress] = useState<{ file: string; pct: number } | null>(null)
  const [segments, setSegments] = useState<Segment[]>([])
  const [interim, setInterim] = useState('')
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)

  // settings
  const webgpuAvailable = typeof navigator !== 'undefined' && 'gpu' in navigator
  const [model, setModel] = useState<ModelId>('onnx-community/whisper-base')
  const [device, setDevice] = useState<Device>(webgpuAvailable ? 'webgpu' : 'wasm')
  const [language, setLanguage] = useState<Language>('auto')
  const [useMic, setUseMic] = useState(true)
  const [useSystem, setUseSystem] = useState(true)

  // refs (mutable, don't trigger re-render)
  const workerRef = useRef<Worker | null>(null)
  const captureRef = useRef<AudioCapture | null>(null)
  const chunksRef = useRef<Float32Array[]>([])
  const lenRef = useRef(0)
  const busyRef = useRef(false)
  const lastVoiceRef = useRef(0)
  const hadSpeechRef = useRef(false)
  const reqRef = useRef(0)
  const finalReqRef = useRef<Set<number>>(new Set())
  const startedAtRef = useRef(0)
  const segIdRef = useRef(0)
  const transcriptEndRef = useRef<HTMLDivElement | null>(null)

  // --- worker lifecycle -----------------------------------------------------
  const ensureWorker = useCallback(() => {
    if (workerRef.current) return workerRef.current
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e: MessageEvent) => {
      const msg = e.data
      switch (msg.type) {
        case 'progress': {
          const p = msg.payload
          if (p?.status === 'progress' && typeof p.progress === 'number') {
            setProgress({ file: p.file ?? '', pct: Math.round(p.progress) })
          } else if (p?.status === 'done') {
            setProgress((cur) => (cur ? { ...cur, pct: 100 } : null))
          }
          break
        }
        case 'ready':
          setProgress(null)
          setStatus((s) => (s === 'loading' ? 'ready' : s))
          break
        case 'result': {
          const text: string = msg.text ?? ''
          if (finalReqRef.current.has(msg.requestId)) {
            finalReqRef.current.delete(msg.requestId)
            busyRef.current = false
            if (text) {
              segIdRef.current += 1
              const id = segIdRef.current
              setSegments((segs) => [...segs, { id, text }])
            }
            setInterim('')
          } else {
            busyRef.current = false
            setInterim(text)
          }
          break
        }
        case 'error':
          busyRef.current = false
          setError(msg.message ?? 'Unknown worker error')
          break
      }
    }
    workerRef.current = w
    return w
  }, [])

  useEffect(() => {
    return () => {
      workerRef.current?.terminate()
      void captureRef.current?.stop()
    }
  }, [])

  const loadModel = useCallback(() => {
    setError(null)
    setStatus('loading')
    setProgress({ file: 'Connecting…', pct: 0 })
    const w = ensureWorker()
    w.postMessage({ type: 'load', model, device })
  }, [ensureWorker, model, device])

  // --- recording ------------------------------------------------------------
  const flushSegment = useCallback(
    (final: boolean) => {
      const w = workerRef.current
      if (!w || lenRef.current === 0) return
      const audio = flatten(chunksRef.current, lenRef.current)
      const reqId = ++reqRef.current
      if (final) {
        finalReqRef.current.add(reqId)
        chunksRef.current = []
        lenRef.current = 0
        hadSpeechRef.current = false
      }
      busyRef.current = true
      const buf = audio.buffer as ArrayBuffer
      w.postMessage(
        { type: 'transcribe', audio: buf, language, requestId: reqId, final },
        [buf],
      )
    },
    [language],
  )

  const stopRecording = useCallback(async () => {
    flushSegment(true) // finalize whatever is buffered
    await captureRef.current?.stop()
    captureRef.current = null
    setLevel(0)
    setStatus('ready')
  }, [flushSegment])

  const tick = useCallback(() => {
    if (captureRef.current && !captureRef.current.isLive()) {
      // User ended the screen-share from the browser's own control bar.
      void stopRecording()
      return
    }
    if (busyRef.current) return
    const seconds = lenRef.current / SAMPLE_RATE
    if (seconds < MIN_INTERIM_S) return

    const silenceFor = performance.now() - lastVoiceRef.current
    const shouldCommit =
      seconds >= MAX_SEGMENT_S ||
      (seconds >= MIN_COMMIT_S && hadSpeechRef.current && silenceFor >= SILENCE_MS)

    flushSegment(shouldCommit)
  }, [flushSegment, stopRecording])

  const tickRef = useRef(tick)
  tickRef.current = tick

  const startRecording = useCallback(async () => {
    setError(null)
    const capture = new AudioCapture()
    captureRef.current = capture
    chunksRef.current = []
    lenRef.current = 0
    hadSpeechRef.current = false
    lastVoiceRef.current = performance.now()
    try {
      await capture.start(
        { mic: useMic, system: useSystem },
        {
          onAudio: (block) => {
            chunksRef.current.push(block)
            lenRef.current += block.length
          },
          onLevel: (lvl) => {
            setLevel(lvl)
            if (lvl >= VOICE_LEVEL) {
              lastVoiceRef.current = performance.now()
              hadSpeechRef.current = true
            }
          },
        },
      )
    } catch (err) {
      captureRef.current = null
      setError(err instanceof Error ? err.message : String(err))
      return
    }
    startedAtRef.current = performance.now()
    setStatus('recording')
  }, [useMic, useSystem])

  // tick + elapsed timers while recording
  useEffect(() => {
    if (status !== 'recording') return
    const t = setInterval(() => tickRef.current(), TICK_MS)
    const e = setInterval(
      () => setElapsed(Math.floor((performance.now() - startedAtRef.current) / 1000)),
      1000,
    )
    return () => {
      clearInterval(t)
      clearInterval(e)
    }
  }, [status])

  // autoscroll
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [segments, interim])

  // --- export ---------------------------------------------------------------
  const fullText = segments.map((s) => s.text).join('\n')

  const copyAll = useCallback(() => {
    void navigator.clipboard.writeText(fullText)
  }, [fullText])

  const download = useCallback(() => {
    const blob = new Blob([fullText], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `transcript-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }, [fullText])

  const clearAll = useCallback(() => {
    setSegments([])
    setInterim('')
  }, [])

  const mins = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const secs = String(elapsed % 60).padStart(2, '0')
  const recording = status === 'recording'

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" /> Meeting Transcriber
        </div>
        <div className="badges">
          <span className={`badge ${device === 'webgpu' ? 'ok' : 'warn'}`}>
            {device === 'webgpu' ? 'WebGPU' : 'CPU (wasm)'}
          </span>
          <span className="badge">100% on-device</span>
        </div>
      </header>

      <section className="panel">
        <div className="settings">
          <label>
            Model
            <select value={model} onChange={(e) => setModel(e.target.value as ModelId)} disabled={status !== 'idle'}>
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — {m.note}
                </option>
              ))}
            </select>
          </label>

          <label>
            Compute
            <select
              value={device}
              onChange={(e) => setDevice(e.target.value as Device)}
              disabled={status !== 'idle'}
            >
              <option value="webgpu" disabled={!webgpuAvailable}>
                WebGPU (GPU){webgpuAvailable ? '' : ' — not available'}
              </option>
              <option value="wasm">CPU (works everywhere, slower)</option>
            </select>
          </label>

          <label>
            Language
            <select value={language} onChange={(e) => setLanguage(e.target.value as Language)}>
              {LANGUAGES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>

          <div className="sources">
            <span className="sources-label">Audio source</span>
            <label className="check">
              <input type="checkbox" checked={useMic} disabled={recording} onChange={(e) => setUseMic(e.target.checked)} />
              Microphone (in-person)
            </label>
            <label className="check">
              <input type="checkbox" checked={useSystem} disabled={recording} onChange={(e) => setUseSystem(e.target.checked)} />
              System / tab audio (Zoom, Meet…)
            </label>
          </div>
        </div>

        <div className="actions">
          {status === 'idle' && (
            <button className="primary" onClick={loadModel}>
              Load model
            </button>
          )}
          {status === 'loading' && (
            <button className="primary" disabled>
              {progress ? `Loading… ${progress.pct}%` : 'Loading…'}
            </button>
          )}
          {status === 'ready' && (
            <button className="primary rec" onClick={startRecording} disabled={!useMic && !useSystem}>
              ● Start transcribing
            </button>
          )}
          {recording && (
            <button className="primary stop" onClick={stopRecording}>
              ■ Stop
            </button>
          )}

          {recording && (
            <div className="live">
              <span className="rec-dot" />
              <span className="timer">
                {mins}:{secs}
              </span>
              <div className="vu">
                <div className="vu-fill" style={{ width: `${Math.round(level * 100)}%` }} />
              </div>
            </div>
          )}
        </div>

        {progress && status === 'loading' && (
          <div className="progressbar">
            <div className="progressbar-fill" style={{ width: `${progress.pct}%` }} />
            <span className="progressbar-label">{progress.file}</span>
          </div>
        )}

        {error && <div className="error">⚠ {error}</div>}
      </section>

      <section className="transcript">
        {segments.length === 0 && !interim && (
          <p className="empty">
            {status === 'idle'
              ? 'Choose your settings and load the model to begin. The first load downloads the model once, then it works offline.'
              : status === 'ready'
                ? 'Press “Start transcribing”. For Zoom, share the Zoom window/tab and tick “Share audio” in the picker.'
                : 'Listening…'}
          </p>
        )}
        {segments.map((s) => (
          <p key={s.id} className="seg">
            {s.text}
          </p>
        ))}
        {interim && <p className="seg interim">{interim}</p>}
        <div ref={transcriptEndRef} />
      </section>

      <footer className="toolbar">
        <button onClick={copyAll} disabled={!fullText}>
          Copy
        </button>
        <button onClick={download} disabled={!fullText}>
          Download .txt
        </button>
        <button onClick={clearAll} disabled={!fullText}>
          Clear
        </button>
        <span className="count">{segments.length} segments</span>
      </footer>
    </div>
  )
}
