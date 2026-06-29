import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import './App.css'
import { AudioCapture, SAMPLE_RATE } from './audio'
import type { Device, Language, ModelId } from './worker'
import {
  buildExport,
  clearSession,
  downloadText,
  loadSession,
  MODEL_SIZE,
  mmss,
  relativeTime,
  saveSession,
  type ExportFormat,
  type Segment,
} from './lib'
import {
  Alert,
  ArrowDown,
  CloudCheck,
  Close,
  Copy,
  Download,
  Ear,
  Mic,
  Pause,
  Play,
  Refresh,
  Search,
  Stop,
  Trash,
} from './icons'

// --- tuning -----------------------------------------------------------------
const MIN_INTERIM_S = 1.5
const MIN_COMMIT_S = 3.5
const MAX_SEGMENT_S = 20
const SILENCE_MS = 1100
const VOICE_LEVEL = 0.06
const TICK_MS = 1200
const NO_AUDIO_MS = 15000
const RENDER_CAP = 400 // keep the live DOM bounded on multi-hour meetings
const WAVE = [0.5, 0.85, 0.6, 1, 0.55, 0.9, 0.45, 0.95, 0.6, 0.8, 0.5, 0.88, 0.62, 0.78]

type Status = 'idle' | 'loading' | 'ready' | 'recording'

const MODELS: { id: ModelId; label: string; note: string }[] = [
  { id: 'onnx-community/whisper-tiny', label: 'Tiny', note: 'fastest, lowest accuracy' },
  { id: 'onnx-community/whisper-base', label: 'Base', note: 'balanced — recommended' },
  { id: 'onnx-community/whisper-small', label: 'Small', note: 'best Bangla, needs a strong PC' },
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

function highlight(text: string, q: string): ReactNode {
  if (!q) return text
  const ql = q.toLowerCase()
  const nodes: ReactNode[] = []
  let rest = text
  let key = 0
  let idx = rest.toLowerCase().indexOf(ql)
  if (idx === -1) return text
  while (idx !== -1) {
    nodes.push(rest.slice(0, idx))
    nodes.push(<mark key={key++}>{rest.slice(idx, idx + q.length)}</mark>)
    rest = rest.slice(idx + q.length)
    idx = rest.toLowerCase().indexOf(ql)
  }
  nodes.push(rest)
  return nodes
}

export default function App() {
  const [status, setStatus] = useState<Status>('idle')
  const [paused, setPaused] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [segments, setSegments] = useState<Segment[]>([])
  const [interim, setInterim] = useState('')
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<{ message: string; retry?: 'load' | 'record' } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [showJump, setShowJump] = useState(false)
  const [newCount, setNewCount] = useState(0)
  const [noAudio, setNoAudio] = useState(false)
  const [preflight, setPreflight] = useState(false)
  const [dontRemind, setDontRemind] = useState(false)
  const [query, setQuery] = useState('')
  const [restored, setRestored] = useState<{ count: number; when: number } | null>(null)
  const [undo, setUndo] = useState<Segment[] | null>(null)

  // settings
  const webgpuAvailable = typeof navigator !== 'undefined' && 'gpu' in navigator
  const [model, setModel] = useState<ModelId>('onnx-community/whisper-base')
  const [device, setDevice] = useState<Device>(webgpuAvailable ? 'webgpu' : 'wasm')
  const [activeDevice, setActiveDevice] = useState<Device>(webgpuAvailable ? 'webgpu' : 'wasm')
  const [language, setLanguage] = useState<Language>('auto')
  const [useMic, setUseMic] = useState(true)
  const [useSystem, setUseSystem] = useState(true)

  // refs
  const workerRef = useRef<Worker | null>(null)
  const captureRef = useRef<AudioCapture | null>(null)
  const chunksRef = useRef<Float32Array[]>([])
  const lenRef = useRef(0)
  const busyRef = useRef(false)
  const lastVoiceRef = useRef(0)
  const hadSpeechRef = useRef(false)
  const reqRef = useRef(0)
  const finalReqRef = useRef<Set<number>>(new Set())
  const segIdRef = useRef(1)
  const lastSegEndRef = useRef(0)
  const accumRef = useRef(0)
  const runStartRef = useRef(0)
  const activeRef = useRef(false)
  const pausedRef = useRef(false)
  const undoTimerRef = useRef<number | null>(null)
  const wakeLockRef = useRef<WakeLockSentinel | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const atBottomRef = useRef(true)
  const exportRef = useRef<HTMLDetailsElement | null>(null)

  const statusRef = useRef<Status>(status)
  statusRef.current = status

  const elapsedNow = useCallback(
    () => accumRef.current + (activeRef.current ? (performance.now() - runStartRef.current) / 1000 : 0),
    [],
  )

  // --- restore a previous session on first load -----------------------------
  useEffect(() => {
    const saved = loadSession()
    if (saved) {
      setSegments(saved.segments)
      segIdRef.current = saved.nextId
      const lastEnd = saved.segments.reduce((m, s) => Math.max(m, s.end), 0)
      lastSegEndRef.current = lastEnd
      accumRef.current = lastEnd
      setRestored({ count: saved.segments.length, when: saved.savedAt })
    }
    if (localStorage.getItem('mt:preflightSeen') === '1') setDontRemind(true)
  }, [])

  // --- autosave (skip the mount run so it can't clobber a restored session) -
  const mountedRef = useRef(false)
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true
      return
    }
    saveSession(segments, segIdRef.current)
  }, [segments])

  // --- guard against losing a live meeting ----------------------------------
  useEffect(() => {
    if (status !== 'recording' && status !== 'loading') return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [status])

  // --- worker ---------------------------------------------------------------
  const ensureWorker = useCallback(() => {
    if (workerRef.current) return workerRef.current
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e: MessageEvent) => {
      const msg = e.data
      switch (msg.type) {
        case 'progress': {
          const p = msg.payload
          if (p?.status === 'progress' && typeof p.progress === 'number') {
            setProgress(Math.round(p.progress))
          }
          break
        }
        case 'fallback':
          setActiveDevice('wasm')
          setNotice('GPU was unavailable — running on CPU (slower, but it works).')
          break
        case 'ready':
          setProgress(null)
          setActiveDevice(msg.device)
          setStatus((s) => (s === 'loading' ? 'ready' : s))
          break
        case 'result': {
          const text: string = (msg.text ?? '').trim()
          if (finalReqRef.current.has(msg.requestId)) {
            finalReqRef.current.delete(msg.requestId)
            busyRef.current = false
            if (text) {
              const end = elapsedNow()
              const start = lastSegEndRef.current
              lastSegEndRef.current = end
              const id = segIdRef.current++
              setSegments((segs) => [...segs, { id, text, start, end }])
            }
            setInterim('')
          } else {
            busyRef.current = false
            setInterim(text)
          }
          break
        }
        case 'error': {
          busyRef.current = false
          const wasLoading = statusRef.current === 'loading'
          if (wasLoading) setStatus('idle')
          setProgress(null)
          setError({ message: msg.message ?? 'Something went wrong.', retry: wasLoading ? 'load' : 'record' })
          break
        }
      }
    }
    w.onerror = (e) => {
      busyRef.current = false
      setError({
        message:
          'The transcription engine crashed' +
          (e?.message ? ` (${e.message})` : '') +
          '. Your transcript is safe — reload the model to continue.',
        retry: 'load',
      })
      setStatus('idle')
      setProgress(null)
      workerRef.current?.terminate()
      workerRef.current = null
    }
    w.onmessageerror = () => {
      busyRef.current = false
      setError({ message: 'The transcription engine sent an unreadable message. Reload the model.', retry: 'load' })
    }
    workerRef.current = w
    return w
  }, [elapsedNow])

  useEffect(() => {
    return () => {
      workerRef.current?.terminate()
      void captureRef.current?.stop()
    }
  }, [])

  const loadModel = useCallback(() => {
    setError(null)
    setStatus('loading')
    setProgress(0)
    setActiveDevice(device)
    ensureWorker().postMessage({ type: 'load', model, device })
  }, [ensureWorker, model, device])

  // --- wake lock ------------------------------------------------------------
  const requestWake = useCallback(async () => {
    try {
      if ('wakeLock' in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request('screen')
      }
    } catch {
      /* user agent may reject — non-fatal */
    }
  }, [])
  const releaseWake = useCallback(() => {
    void wakeLockRef.current?.release()
    wakeLockRef.current = null
  }, [])

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible' && activeRef.current) void requestWake()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [requestWake])

  // --- transcription loop ---------------------------------------------------
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
      w.postMessage({ type: 'transcribe', audio: buf, language, requestId: reqId, final }, [buf])
    },
    [language],
  )

  const stopRecording = useCallback(async () => {
    flushSegment(true)
    accumRef.current = elapsedNow()
    activeRef.current = false
    pausedRef.current = false
    setPaused(false)
    releaseWake()
    await captureRef.current?.stop()
    captureRef.current = null
    setLevel(0)
    setNoAudio(false)
    setStatus('ready')
  }, [flushSegment, elapsedNow, releaseWake])

  const tick = useCallback(() => {
    if (captureRef.current && !captureRef.current.isLive()) {
      void stopRecording()
      return
    }
    if (pausedRef.current || busyRef.current) return
    const seconds = lenRef.current / SAMPLE_RATE
    const silenceFor = performance.now() - lastVoiceRef.current
    setNoAudio(elapsedNow() > 16 && silenceFor > NO_AUDIO_MS)
    if (seconds < MIN_INTERIM_S) return
    const shouldCommit =
      seconds >= MAX_SEGMENT_S ||
      (seconds >= MIN_COMMIT_S && hadSpeechRef.current && silenceFor >= SILENCE_MS)
    flushSegment(shouldCommit)
  }, [flushSegment, stopRecording, elapsedNow])

  const tickRef = useRef(tick)
  tickRef.current = tick

  const beginCapture = useCallback(async () => {
    setError(null)
    const capture = new AudioCapture()
    captureRef.current = capture
    chunksRef.current = []
    lenRef.current = 0
    hadSpeechRef.current = false
    lastVoiceRef.current = performance.now()
    pausedRef.current = false
    setPaused(false)
    try {
      await capture.start(
        { mic: useMic, system: useSystem },
        {
          onAudio: (block) => {
            if (pausedRef.current) return
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
      const name = err instanceof DOMException ? err.name : ''
      const raw = err instanceof Error ? err.message : String(err)
      const message =
        name === 'NotAllowedError' || /denied|dismissed/i.test(raw)
          ? 'Microphone or screen-share access was blocked. Click the lock icon in your address bar to allow it, then retry.'
          : raw
      setError({ message, retry: 'record' })
      return
    }
    accumRef.current = lastSegEndRef.current
    runStartRef.current = performance.now()
    activeRef.current = true
    setStatus('recording')
    void requestWake()
  }, [useMic, useSystem, requestWake])

  const handleStart = useCallback(() => {
    if (useSystem && localStorage.getItem('mt:preflightSeen') !== '1') {
      setPreflight(true)
    } else {
      void beginCapture()
    }
  }, [useSystem, beginCapture])

  const confirmPreflight = useCallback(() => {
    if (dontRemind) localStorage.setItem('mt:preflightSeen', '1')
    setPreflight(false)
    void beginCapture()
  }, [dontRemind, beginCapture])

  const pause = useCallback(() => {
    flushSegment(true)
    accumRef.current = elapsedNow()
    activeRef.current = false
    pausedRef.current = true
    setPaused(true)
    releaseWake()
  }, [flushSegment, elapsedNow, releaseWake])

  const resume = useCallback(() => {
    runStartRef.current = performance.now()
    activeRef.current = true
    pausedRef.current = false
    lastVoiceRef.current = performance.now()
    setPaused(false)
    void requestWake()
  }, [requestWake])

  // timers
  useEffect(() => {
    if (status !== 'recording') return
    const t = setInterval(() => tickRef.current(), TICK_MS)
    const e = setInterval(() => setElapsed(elapsedNow()), 500)
    return () => {
      clearInterval(t)
      clearInterval(e)
    }
  }, [status, elapsedNow])

  // --- autoscroll -----------------------------------------------------------
  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    atBottomRef.current = atBottom
    if (atBottom && showJump) {
      setShowJump(false)
      setNewCount(0)
    }
  }, [showJump])

  const jumpToLive = useCallback(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    atBottomRef.current = true
    setShowJump(false)
    setNewCount(0)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight
    } else if (segments.length > 0) {
      setNewCount((n) => n + 1)
      setShowJump(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments.length])

  useEffect(() => {
    const el = scrollRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [interim])

  // --- export / clear -------------------------------------------------------
  const hasText = segments.length > 0

  const copyAll = useCallback(() => {
    void navigator.clipboard.writeText(buildExport(segments, 'txt'))
    setNotice('Copied transcript to clipboard.')
    window.setTimeout(() => setNotice(null), 2500)
  }, [segments])

  const doExport = useCallback(
    (fmt: ExportFormat) => {
      downloadText(buildExport(segments, fmt), fmt)
      if (exportRef.current) exportRef.current.open = false
    },
    [segments],
  )

  const clearAll = useCallback(() => {
    setUndo(segments)
    setSegments([])
    setInterim('')
    clearSession()
    lastSegEndRef.current = 0
    accumRef.current = 0
    setRestored(null)
    if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current)
    undoTimerRef.current = window.setTimeout(() => setUndo(null), 8000)
  }, [segments])

  const undoClear = useCallback(() => {
    if (!undo) return
    setSegments(undo)
    const lastEnd = undo.reduce((m, s) => Math.max(m, s.end), 0)
    lastSegEndRef.current = lastEnd
    accumRef.current = lastEnd
    setUndo(null)
  }, [undo])

  const startFresh = useCallback(() => {
    setSegments([])
    clearSession()
    lastSegEndRef.current = 0
    accumRef.current = 0
    segIdRef.current = 1
    setRestored(null)
  }, [])

  // --- derived --------------------------------------------------------------
  const filtered = useMemo(() => {
    if (!query.trim()) return null
    const q = query.trim().toLowerCase()
    return segments.filter((s) => s.text.toLowerCase().includes(q))
  }, [query, segments])

  const visible = filtered ?? (segments.length > RENDER_CAP ? segments.slice(-RENDER_CAP) : segments)
  const hiddenCount = filtered ? 0 : segments.length - visible.length

  const recording = status === 'recording'
  const modelSize = MODEL_SIZE[model] ?? ''
  const barLevel = paused ? 0.12 : level

  return (
    <div className="app">
      <div className="ambient" aria-hidden="true" />

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <Mic size={17} />
          </span>
          <span className="wordmark">Meeting Transcriber</span>
        </div>
        <div className="badges">
          <span className={`badge ${activeDevice === 'webgpu' ? 'ok' : 'warn'}`}>
            {activeDevice === 'webgpu' ? 'Fast · GPU' : 'CPU mode'}
          </span>
          <span className="badge">On-device</span>
        </div>
      </header>

      {restored && (
        <div className="banner info">
          <span>
            Restored your previous transcript — {restored.count} segment{restored.count === 1 ? '' : 's'} from{' '}
            {relativeTime(restored.when)}.
          </span>
          <button className="link" onClick={startFresh}>
            Start fresh
          </button>
        </div>
      )}

      {notice && <div className="banner info subtle">{notice}</div>}

      <section className="panel">
        {!recording && !preflight && (
          <>
            <div className="settings">
              <label>
                <span className="eyebrow">Model</span>
                <select value={model} onChange={(e) => setModel(e.target.value as ModelId)} disabled={status !== 'idle'}>
                  {MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} — {m.note} ({MODEL_SIZE[m.id]})
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span className="eyebrow">Speed</span>
                <select value={device} onChange={(e) => setDevice(e.target.value as Device)} disabled={status !== 'idle'}>
                  <option value="webgpu" disabled={!webgpuAvailable}>
                    Fast (uses GPU){webgpuAvailable ? '' : ' — unavailable'}
                  </option>
                  <option value="wasm">Compatible (slower, works everywhere)</option>
                </select>
              </label>

              <label>
                <span className="eyebrow">Language</span>
                <select value={language} onChange={(e) => setLanguage(e.target.value as Language)}>
                  {LANGUAGES.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="sources">
                <span className="eyebrow">Audio source</span>
                <label className="check">
                  <input type="checkbox" checked={useMic} onChange={(e) => setUseMic(e.target.checked)} />
                  <span>Microphone (in-person)</span>
                </label>
                <label className="check">
                  <input type="checkbox" checked={useSystem} onChange={(e) => setUseSystem(e.target.checked)} />
                  <span>System / tab audio (Zoom, Meet…)</span>
                </label>
              </div>
            </div>

            <div className="actions">
              {status === 'idle' && (
                <button className="primary" onClick={loadModel}>
                  <Download size={17} /> Download model · {modelSize}, one-time
                </button>
              )}
              {status === 'loading' && (
                <button className="primary" disabled>
                  Downloading… {progress ?? 0}%
                </button>
              )}
              {status === 'ready' && (
                <button className="primary go" onClick={handleStart} disabled={!useMic && !useSystem}>
                  <Play size={16} /> Start transcribing
                </button>
              )}
              {status === 'ready' && !useMic && !useSystem && (
                <span className="hint">Pick at least one audio source above.</span>
              )}
            </div>

            {status === 'loading' && (
              <div className="progressbar">
                <div className="progressbar-fill" style={{ width: `${progress ?? 0}%` }} />
                <span className="progressbar-label">
                  Downloading speech model — one-time, then it works offline.
                </span>
              </div>
            )}
          </>
        )}

        {preflight && (
          <div className="preflight">
            <h2>One quick heads-up before we start</h2>
            <p>
              Your browser will show {useMic ? 'two pop-ups: first the microphone, then a screen-share picker' : 'a screen-share picker'}.
              In the picker, choose your meeting window or tab — and you <strong>must tick “Also share tab/system audio”</strong>{' '}
              (bottom-left of the dialog), or we won’t hear anything. Everything stays on your device.
            </p>
            <label className="check">
              <input type="checkbox" checked={dontRemind} onChange={(e) => setDontRemind(e.target.checked)} />
              <span>Don’t show this again</span>
            </label>
            <div className="preflight-actions">
              <button className="primary go" onClick={confirmPreflight}>
                Got it — continue
              </button>
              <button className="ghost" onClick={() => setPreflight(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {recording && (
          <div className={`live-hero ${paused ? 'paused' : ''}`}>
            <div className="live-row">
              <span className="rec-dot" aria-hidden="true" />
              <span className="timer">{mmss(elapsed)}</span>
              <div className="wave" aria-hidden="true">
                {WAVE.map((m, i) => (
                  <span key={i} style={{ height: `${Math.round(5 + barLevel * 30 * m)}px` }} />
                ))}
              </div>
              <span className={`status-chip ${paused ? 'paused' : ''}`}>
                {paused ? 'Paused' : (
                  <>
                    <Ear size={14} /> Listening
                  </>
                )}
              </span>
              <div className="live-buttons">
                {paused ? (
                  <button className="primary go sm" onClick={resume}>
                    <Play size={15} /> Resume
                  </button>
                ) : (
                  <button className="ghost sm" onClick={pause}>
                    <Pause size={15} /> Pause
                  </button>
                )}
                <button className="primary stop sm" onClick={() => void stopRecording()}>
                  <Stop size={15} /> Stop
                </button>
              </div>
            </div>
            {noAudio && (
              <div className="no-audio">
                <Alert size={15} /> No audio detected for a while — is the right tab shared, or your mic muted?
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="banner error" role="alert">
            <Alert size={16} />
            <span className="err-msg">{error.message}</span>
            {error.retry && (
              <button className="link" onClick={() => (error.retry === 'load' ? loadModel() : handleStart())}>
                <Refresh size={14} /> Retry
              </button>
            )}
            {device === 'webgpu' && error.retry === 'load' && (
              <button
                className="link"
                onClick={() => {
                  setDevice('wasm')
                  setError(null)
                  setStatus('idle')
                }}
              >
                Switch to CPU
              </button>
            )}
            <button className="icon-btn" aria-label="Dismiss" onClick={() => setError(null)}>
              <Close size={14} />
            </button>
          </div>
        )}
      </section>

      <section className="transcript-wrap">
        {hasText && (
          <div className="search">
            <Search size={15} />
            <input
              type="search"
              placeholder="Search transcript"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query.trim() && (
              <span className="match-count">
                {filtered?.length ?? 0} match{(filtered?.length ?? 0) === 1 ? '' : 'es'}
              </span>
            )}
          </div>
        )}

        <div className="transcript" ref={scrollRef} onScroll={onScroll}>
          {!hasText && !interim && (
            <ol className="firstrun">
              {status === 'idle' && (
                <>
                  <li>Pick your language (or leave it on Auto-detect).</li>
                  <li>Download the model — one-time, {modelSize}, then it works offline.</li>
                  <li>Press Start — we’ll guide you through the prompts.</li>
                </>
              )}
              {status === 'loading' && <li>Downloading the speech model… this happens only once.</li>}
              {status === 'ready' && (
                <>
                  <li>Press “Start transcribing”.</li>
                  <li>Pick your meeting window or tab in the share picker.</li>
                  <li>
                    Tick “Share audio” — <strong>the step most people miss.</strong>
                  </li>
                </>
              )}
            </ol>
          )}

          {hiddenCount > 0 && <p className="hidden-note">{hiddenCount} earlier segments hidden — included in exports.</p>}

          {visible.map((s) => (
            <p key={s.id} className="seg">
              <span className="ts">[{mmss(s.start)}]</span>
              <span className="seg-text">{query.trim() ? highlight(s.text, query.trim()) : s.text}</span>
            </p>
          ))}

          {!filtered && interim && (
            <p className="seg interim" aria-hidden="true">
              <span className="ts">[{mmss(elapsed)}]</span>
              <span className="seg-text">
                {interim}
                <span className="caret" />
              </span>
            </p>
          )}

          {filtered && filtered.length === 0 && <p className="empty-search">No matches for “{query.trim()}”.</p>}
        </div>

        {/* aria-live mirror so screen readers hear new finalized text without the flicker */}
        <div className="sr-only" role="log" aria-live="polite" aria-relevant="additions">
          {visible.slice(-1).map((s) => (
            <p key={s.id}>{s.text}</p>
          ))}
        </div>

        {showJump && (
          <button className="jump" onClick={jumpToLive}>
            Jump to live <ArrowDown size={14} /> {newCount} new
          </button>
        )}
      </section>

      <footer className="toolbar">
        <button onClick={copyAll} disabled={!hasText}>
          <Copy size={15} /> Copy
        </button>
        <details className="export" ref={exportRef}>
          <summary aria-disabled={!hasText}>
            <Download size={15} /> Export
          </summary>
          <div className="export-menu">
            <button onClick={() => doExport('txt')}>Plain text (.txt)</button>
            <button onClick={() => doExport('md')}>Markdown, timestamped (.md)</button>
            <button onClick={() => doExport('srt')}>Subtitles (.srt)</button>
          </div>
        </details>
        <button onClick={clearAll} disabled={!hasText} className="danger-hover">
          <Trash size={15} /> Clear
        </button>
        <span className="saved">
          {hasText && (
            <>
              <CloudCheck size={15} /> Saved · {segments.length} segment{segments.length === 1 ? '' : 's'}
            </>
          )}
        </span>
      </footer>

      {undo && (
        <div className="undo-toast">
          <span>Transcript cleared.</span>
          <button className="link" onClick={undoClear}>
            Undo
          </button>
        </div>
      )}
    </div>
  )
}
