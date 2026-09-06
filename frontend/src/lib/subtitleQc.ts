export const SUBTITLE_FPS = 30
export const SUBTITLE_FRAME = 1 / SUBTITLE_FPS

export type CaptionPosition = 'top' | 'center' | 'bottom'

export type TranscriptWord = {
  id: string
  text: string
  start: number
  end: number
  timelineStart: number
  timelineEnd: number
  speaker?: string | null
  deleted?: boolean
}

export type CaptionCue = {
  id: string
  start: number
  end: number
  text: string
  speaker?: string | null
  wordIds?: string[]
}

export type TranslationPack = {
  language: string
  label: string
  generatedAt: string
  provider?: string
  model?: string
  sourceLanguage?: string | null
  cues: CaptionCue[]
}

export type TranscriptDocument = {
  id: string
  version: 1
  generatedAt: string
  provider: string
  wordModel: string
  diarizeModel?: string | null
  diarized: boolean
  language?: string | null
  sourceFileIndex: number
  sourceTrackId: string
  text: string
  words: TranscriptWord[]
  captionsEnabled: boolean
  captionSize: number
  captionPosition: CaptionPosition
  captionColor: string
  captionBoxOpacity: number
  captionMaxWords: number
  captionMaxDuration: number
  captionBreakGap: number
  captionSpeakerLabels: boolean
  captionPreset?: string
  captionLanguage?: string
  captionTranslations?: Record<string, TranslationPack>
  captionManualCues?: CaptionCue[]
}

export type TimelineAudioWithTranscript = {
  id: string
  lane: 'A1' | 'A2' | 'A3'
  name?: string
  fileIndex: number
  dialogueTranscript?: TranscriptDocument
  [key: string]: unknown
}

export type TranscriptProjectShape = {
  audioTracks?: TimelineAudioWithTranscript[]
  [key: string]: unknown
}

export type CaptionGroup = CaptionCue & {
  words?: TranscriptWord[]
  translated?: boolean
  manual?: boolean
}

export type TitleLike = {
  id?: string
  kind?: string
  text?: string
  startAt: number
  endAt: number
  position?: CaptionPosition
}

export type CueQcMetrics = {
  cueId: string
  duration: number
  cps: number
  cpl: number
  characters: number
}

export type CueQcIssue = {
  cueId: string
  code: 'OVERLAP' | 'GAP' | 'CPS' | 'CPL' | 'SHORT' | 'LONG' | 'GRAPHIC_CONFLICT'
  severity: 'error' | 'warning'
  message: string
  start: number
}

export type SubtitleQcReport = {
  metrics: CueQcMetrics[]
  issues: CueQcIssue[]
  errors: number
  warnings: number
  averageCps: number
  maxCpl: number
  graphicConflicts: number
}

export function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

export function quantizeSubtitleTime(value: number) {
  return Math.max(0, Math.round(Math.max(0, value) * SUBTITLE_FPS) / SUBTITLE_FPS)
}

function cleanWords(document: TranscriptDocument) {
  return [...(document.words || [])]
    .filter((word) => !word.deleted && word.text.trim())
    .sort((a, b) => a.timelineStart - b.timelineStart || a.timelineEnd - b.timelineEnd)
}

export function buildAutoSourceCaptionGroups(document: TranscriptDocument): CaptionGroup[] {
  const words = cleanWords(document)
  const groups: CaptionGroup[] = []
  let current: TranscriptWord[] = []
  const maxWords = Math.max(2, Math.min(12, Number(document.captionMaxWords || 7)))
  const maxDuration = Math.max(1, Math.min(6, Number(document.captionMaxDuration || 3.2)))
  const breakGap = Math.max(.1, Math.min(1.5, Number(document.captionBreakGap || .65)))

  const flush = () => {
    if (!current.length) return
    const first = current[0]
    const last = current[current.length - 1]
    groups.push({
      id: `c${groups.length + 1}`,
      start: first.timelineStart,
      end: Math.max(last.timelineEnd, first.timelineStart + .12),
      text: current.map((word) => word.text).join(' '),
      speaker: first.speaker || null,
      wordIds: current.map((word) => word.id),
      words: [...current],
      translated: false,
      manual: false,
    })
    current = []
  }

  for (const word of words) {
    if (current.length) {
      const previous = current[current.length - 1]
      const gap = word.timelineStart - previous.timelineEnd
      const duration = word.timelineEnd - current[0].timelineStart
      const speakerChanged = Boolean(word.speaker && current[0].speaker && word.speaker !== current[0].speaker)
      if (gap > breakGap || duration > maxDuration || current.length >= maxWords || speakerChanged) flush()
    }
    current.push(word)
    if (/[.!?؟؛:]$/.test(word.text)) flush()
  }
  flush()
  return groups
}

export function buildManualSourceCaptionGroups(document: TranscriptDocument): CaptionGroup[] | null {
  const manual = Array.isArray(document.captionManualCues) ? document.captionManualCues : []
  if (!manual.length) return null
  const wordMap = new Map(cleanWords(document).map((word) => [word.id, word]))
  const groups = manual
    .map((cue) => {
      const words = (cue.wordIds || []).map((id) => wordMap.get(id)).filter((word): word is TranscriptWord => Boolean(word))
      const text = words.length ? words.map((word) => word.text).join(' ') : cue.text.trim()
      if (!text) return null
      return {
        ...cue,
        start: quantizeSubtitleTime(cue.start),
        end: Math.max(quantizeSubtitleTime(cue.start) + SUBTITLE_FRAME * 2, quantizeSubtitleTime(cue.end)),
        text,
        speaker: words[0]?.speaker || cue.speaker || null,
        words,
        translated: false,
        manual: true,
      } satisfies CaptionGroup
    })
    .filter((cue): cue is CaptionGroup => Boolean(cue))
    .sort((a, b) => a.start - b.start || a.end - b.end)
  return groups.length ? groups : null
}

export function buildSourceCaptionGroups(document: TranscriptDocument): CaptionGroup[] {
  return buildManualSourceCaptionGroups(document) || buildAutoSourceCaptionGroups(document)
}

export function buildCaptionGroups(document: TranscriptDocument, language = document.captionLanguage || 'source'): CaptionGroup[] {
  if (language !== 'source') {
    const pack = document.captionTranslations?.[language]
    if (pack?.cues?.length) {
      return pack.cues
        .filter((cue) => cue.text.trim() && cue.end > cue.start)
        .map((cue) => ({ ...cue, translated: true, manual: true }))
        .sort((a, b) => a.start - b.start || a.end - b.end)
    }
  }
  return buildSourceCaptionGroups(document)
}

export function materializeManualSourceCues(document: TranscriptDocument): CaptionCue[] {
  const existing = buildManualSourceCaptionGroups(document)
  if (existing) {
    return existing.map(({ words: _words, translated: _translated, manual: _manual, ...cue }) => ({ ...cue }))
  }
  return buildAutoSourceCaptionGroups(document).map((cue) => ({
    id: cue.id,
    start: quantizeSubtitleTime(cue.start),
    end: quantizeSubtitleTime(cue.end),
    text: cue.text,
    speaker: cue.speaker || null,
    wordIds: cue.wordIds ? [...cue.wordIds] : [],
  }))
}

function captionText(cue: CaptionGroup, document: TranscriptDocument) {
  return `${document.captionSpeakerLabels && cue.speaker ? `${cue.speaker}: ` : ''}${cue.text}`.trim()
}

function intervalsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return aStart < bEnd - .001 && bStart < aEnd - .001
}

export function evaluateSubtitleQc(cues: CaptionGroup[], document: TranscriptDocument, titles: TitleLike[] = []): SubtitleQcReport {
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end)
  const metrics: CueQcMetrics[] = []
  const issues: CueQcIssue[] = []
  let graphicConflicts = 0

  sorted.forEach((cue, index) => {
    const duration = Math.max(SUBTITLE_FRAME, cue.end - cue.start)
    const text = captionText(cue, document)
    const characters = text.length
    const cps = characters / duration
    const lines = text.split(/\n/)
    const cpl = Math.max(0, ...lines.map((line) => line.trim().length))
    metrics.push({ cueId: cue.id, duration, cps, cpl, characters })

    const add = (code: CueQcIssue['code'], severity: CueQcIssue['severity'], message: string) => {
      issues.push({ cueId: cue.id, code, severity, message, start: cue.start })
    }

    if (duration < .5) add('SHORT', 'error', `مدة الـCaption ${duration.toFixed(2)}s فقط؛ أقل من الحد الآمن للقراءة.`)
    else if (duration < .8) add('SHORT', 'warning', `مدة الـCaption ${duration.toFixed(2)}s قصيرة نسبيًا.`)
    if (duration > 7) add('LONG', 'warning', `الـCaption مستمر ${duration.toFixed(2)}s؛ راجع تقسيم الجملة.`)
    if (cps > 25) add('CPS', 'error', `سرعة القراءة ${cps.toFixed(1)} CPS مرتفعة جدًا.`)
    else if (cps > 20) add('CPS', 'warning', `سرعة القراءة ${cps.toFixed(1)} CPS أعلى من الهدف الاحترافي.`)
    if (cpl > 48) add('CPL', 'error', `أطول سطر ${cpl} حرفًا؛ يتجاوز 48 CPL.`)
    else if (cpl > 42) add('CPL', 'warning', `أطول سطر ${cpl} حرفًا؛ يفضل ألا يتجاوز 42 CPL.`)

    const next = sorted[index + 1]
    if (next) {
      if (next.start < cue.end - SUBTITLE_FRAME / 2) add('OVERLAP', 'error', `يتداخل مع Caption التالي بمقدار ${(cue.end - next.start).toFixed(2)}s.`)
      else if (next.start - cue.end < SUBTITLE_FRAME * 2) add('GAP', 'warning', 'الفاصل مع Caption التالي أقل من إطارين.')
    }

    const conflicts = titles.filter((title) => {
      if (title.kind && title.kind !== 'title') return false
      const sameZone = (title.position || 'bottom') === (document.captionPosition || 'bottom')
      return sameZone && intervalsOverlap(cue.start, cue.end, title.startAt, title.endAt)
    })
    if (conflicts.length) {
      graphicConflicts += 1
      add('GRAPHIC_CONFLICT', 'warning', `يتزامن مع ${conflicts.length} Title/Lower Third في نفس منطقة العرض.`)
    }
  })

  const errors = issues.filter((issue) => issue.severity === 'error').length
  const warnings = issues.filter((issue) => issue.severity === 'warning').length
  return {
    metrics,
    issues: issues.sort((a, b) => a.start - b.start || (a.severity === 'error' ? -1 : 1)),
    errors,
    warnings,
    averageCps: metrics.length ? metrics.reduce((sum, item) => sum + item.cps, 0) / metrics.length : 0,
    maxCpl: metrics.length ? Math.max(...metrics.map((item) => item.cpl)) : 0,
    graphicConflicts,
  }
}

function pad(value: number, digits = 2) {
  return String(Math.max(0, Math.floor(value))).padStart(digits, '0')
}

function subtitleTimestamp(seconds: number, separator: ',' | '.') {
  const safe = Math.max(0, seconds)
  const whole = Math.floor(safe)
  const milliseconds = Math.round((safe - whole) * 1000)
  const normalizedWhole = milliseconds >= 1000 ? whole + 1 : whole
  const normalizedMs = milliseconds >= 1000 ? 0 : milliseconds
  const hh = Math.floor(normalizedWhole / 3600)
  const mm = Math.floor((normalizedWhole % 3600) / 60)
  const ss = normalizedWhole % 60
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}${separator}${pad(normalizedMs, 3)}`
}

export function captionsToSrt(cues: CaptionGroup[], document: TranscriptDocument) {
  return [...cues]
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map((cue, index) => `${index + 1}\n${subtitleTimestamp(cue.start, ',')} --> ${subtitleTimestamp(cue.end, ',')}\n${captionText(cue, document)}\n`)
    .join('\n')
}

export function captionsToVtt(cues: CaptionGroup[], document: TranscriptDocument) {
  const body = [...cues]
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map((cue) => `${subtitleTimestamp(cue.start, '.')} --> ${subtitleTimestamp(cue.end, '.')}\n${captionText(cue, document)}`)
    .join('\n\n')
  return `WEBVTT\n\n${body}\n`
}
