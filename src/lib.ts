// Shared types, persistence, time formatting, and export builders.

export type Segment = {
  id: number
  text: string
  start: number // elapsed seconds at segment start
  end: number // elapsed seconds at finalize
}

// --- persistence (survives refresh / crash / accidental close) --------------
const KEY = 'mt:session:v1'

export type SavedSession = { segments: Segment[]; savedAt: number; nextId: number }

export function loadSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const o = JSON.parse(raw)
    if (!o || !Array.isArray(o.segments) || o.segments.length === 0) return null
    return {
      segments: o.segments,
      savedAt: typeof o.savedAt === 'number' ? o.savedAt : Date.now(),
      nextId: typeof o.nextId === 'number' ? o.nextId : o.segments.length + 1,
    }
  } catch {
    return null
  }
}

export function saveSession(segments: Segment[], nextId: number) {
  try {
    if (segments.length === 0) {
      localStorage.removeItem(KEY)
      return
    }
    localStorage.setItem(KEY, JSON.stringify({ segments, nextId, savedAt: Date.now() }))
  } catch {
    /* storage full or unavailable — non-fatal */
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}

// --- time formatting --------------------------------------------------------
export function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function srtTime(sec: number): string {
  const total = Math.max(0, sec)
  const ms = Math.floor((total % 1) * 1000)
  const s = Math.floor(total)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(h)}:${p(m)}:${p(ss)},${p(ms, 3)}`
}

export function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  const min = Math.round(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr} hr ago`
  return `${Math.round(hr / 24)} d ago`
}

// --- exports ----------------------------------------------------------------
export type ExportFormat = 'txt' | 'md' | 'srt'

export function buildExport(segs: Segment[], fmt: ExportFormat): string {
  switch (fmt) {
    case 'md':
      return ['# Meeting transcript', '', ...segs.map((s) => `**[${mmss(s.start)}]** ${s.text}`)].join('\n')
    case 'srt':
      return segs
        .map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text}\n`)
        .join('\n')
    case 'txt':
    default:
      return segs.map((s) => s.text).join('\n')
  }
}

export function downloadText(content: string, fmt: ExportFormat) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `transcript-${stamp}.${fmt}`
  a.click()
  URL.revokeObjectURL(url)
}

export const MODEL_SIZE: Record<string, string> = {
  'onnx-community/whisper-tiny': '~40 MB',
  'onnx-community/whisper-base': '~80 MB',
  'onnx-community/whisper-small': '~250 MB',
}
