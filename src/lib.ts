// Shared types, persistence, time formatting, and export builders.

export type Segment = {
  id: number
  text: string
  start: number // elapsed seconds at segment start
  end: number // elapsed seconds at segment end
}

// --- current session persistence (survives refresh / crash / close) ---------
const KEY = 'mt:session:v1'

export type SavedSession = { segments: Segment[]; savedAt: number; nextId: number; title: string }

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
      title: typeof o.title === 'string' ? o.title : '',
    }
  } catch {
    return null
  }
}

export function saveSession(segments: Segment[], nextId: number, title: string) {
  try {
    if (segments.length === 0) {
      localStorage.removeItem(KEY)
      return
    }
    localStorage.setItem(KEY, JSON.stringify({ segments, nextId, title, savedAt: Date.now() }))
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

// --- meeting history (so a new meeting doesn't vaporize the last one) --------
const HISTORY_KEY = 'mt:history:v1'
const HISTORY_CAP = 30

export type Meeting = { id: string; title: string; segments: Segment[]; savedAt: number }

export function loadHistory(): Meeting[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

// Archive the current transcript before it's cleared. Returns the new history.
export function archiveMeeting(title: string, segments: Segment[]): Meeting[] {
  if (segments.length === 0) return loadHistory()
  const meeting: Meeting = {
    id: `${Date.now()}-${segments.length}`,
    title: title.trim() || defaultTitle(segments),
    segments,
    savedAt: Date.now(),
  }
  const next = [meeting, ...loadHistory()].slice(0, HISTORY_CAP)
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
  return next
}

export function deleteMeeting(id: string): Meeting[] {
  const next = loadHistory().filter((m) => m.id !== id)
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
  return next
}

// A friendly fallback title: first few words of the first segment.
export function defaultTitle(segments: Segment[]): string {
  const first = segments.find((s) => s.text.trim())?.text.trim() ?? ''
  const words = first.split(/\s+/).slice(0, 6).join(' ')
  return words ? (words.length < first.length ? words + '…' : words) : 'Untitled meeting'
}

// --- time formatting --------------------------------------------------------
export function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

function clock(sec: number, msSep: string): string {
  const total = Math.max(0, sec)
  const ms = Math.floor((total % 1) * 1000)
  const s = Math.floor(total)
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}${msSep}${pad(ms, 3)}`
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

// Force subtitle cues to be monotonic and non-overlapping with a minimum
// duration — Whisper segment times can otherwise overlap or be zero-length,
// which makes .srt/.vtt players misbehave.
function cues(segs: Segment[]): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = []
  let prevEnd = 0
  for (const s of segs) {
    const start = Math.max(s.start, prevEnd)
    const end = Math.max(s.end, start + 0.5)
    out.push({ start, end, text: s.text })
    prevEnd = end
  }
  return out
}

// --- text exports -----------------------------------------------------------
export type TextFormat = 'txt' | 'md' | 'srt' | 'vtt'

export function buildExport(segs: Segment[], fmt: TextFormat, title = ''): string {
  const heading = title.trim() || 'Meeting transcript'
  switch (fmt) {
    case 'md':
      return [`# ${heading}`, '', ...segs.map((s) => `**[${mmss(s.start)}]** ${s.text}`)].join('\n')
    case 'srt':
      return cues(segs)
        .map((c, i) => `${i + 1}\n${clock(c.start, ',')} --> ${clock(c.end, ',')}\n${c.text}\n`)
        .join('\n')
    case 'vtt':
      return [
        'WEBVTT',
        '',
        ...cues(segs).map((c, i) => `${i + 1}\n${clock(c.start, '.')} --> ${clock(c.end, '.')}\n${c.text}\n`),
      ].join('\n')
    case 'txt':
    default:
      return segs.map((s) => s.text).join('\n')
  }
}

function slug(title: string): string {
  const s = title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
  return s || 'transcript'
}

function triggerDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

export function downloadText(content: string, fmt: TextFormat, title = '') {
  triggerDownload(new Blob([content], { type: 'text/plain;charset=utf-8' }), `${slug(title)}.${fmt}`)
}

// .docx is binary; the `docx` library is dynamically imported so it only loads
// (and only enters the bundle) when someone actually exports Word.
export async function downloadDocx(segs: Segment[], title = '') {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import('docx')
  const heading = title.trim() || 'Meeting transcript'
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(heading)] }),
          new Paragraph({
            spacing: { after: 240 },
            children: [new TextRun({ text: `Generated ${new Date().toLocaleString()}`, italics: true, color: '888888', size: 18 })],
          }),
          ...segs.map(
            (s) =>
              new Paragraph({
                spacing: { after: 120 },
                children: [
                  new TextRun({ text: `[${mmss(s.start)}]  `, bold: true, color: '2F6FE0' }),
                  new TextRun(s.text),
                ],
              }),
          ),
        ],
      },
    ],
  })
  triggerDownload(await Packer.toBlob(doc), `${slug(title)}.docx`)
}

export const MODEL_SIZE: Record<string, string> = {
  'onnx-community/whisper-tiny': '~40 MB',
  'onnx-community/whisper-base': '~80 MB',
  'onnx-community/whisper-small': '~250 MB',
  'onnx-community/whisper-large-v3-turbo': '~1.6 GB',
}
