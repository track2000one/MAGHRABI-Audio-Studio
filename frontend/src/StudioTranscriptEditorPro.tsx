import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Captions,
  Clock3,
  Download,
  FileText,
  Scissors,
  Search,
  Sparkles,
  Trash2,
  Upload,
  Users,
  WandSparkles,
  X,
} from 'lucide-react'
import { getActiveStudioProjectId } from './lib/projectHubStore'
import { loadStoredVideoProject, saveStoredVideoProject, type StoredVideoProject } from './lib/projectStore'
import { getTranscriptStatus, transcribeAudioTrack, type TranscriptStatus } from './lib/transcriptApi'
import './studioTranscriptEditorPro.css'

type VideoLane = 'V1' | 'V2' | 'V3'
type AudioLane = 'A1' | 'A2' | 'A3'
type LaneKey = VideoLane | AudioLane

type TranscriptWord = {
  id: string
  text: string
  start: number
  end: number
  timelineStart: number
  timelineEnd: number
  speaker?: string | null
}

type TranscriptDocument = {
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
  captionPosition: 'top' | 'center' | 'bottom'
  captionColor: string
  captionBoxOpacity: number
  captionMaxWords: number
  captionMaxDuration: number
  captionBreakGap: number
  captionSpeakerLabels: boolean
}

type TimelineClip = {
  id: string
  lane: VideoLane
  startAt: number
  start: number
  end: number
  speed: number
  freezeFrame?: boolean
  freezeDuration?: number
  transitionOut?: unknown
  detachedTrackId?: string | null
  [key: string]: unknown
}

type TimelineAudio = {
  id: string
  lane: AudioLane
  name?: string
  fileIndex: number
  startAt: number
  sourceStart: number
  sourceEnd: number
  linkedClipId?: string | null
  dialogueTempo?: number
  dialogueTranscript?: TranscriptDocument
  [key: string]: unknown
}

type AdjustmentLayer = {
  id: string
  startAt: number
  endAt: number
  [key: string]: unknown
}

type ProjectShape = {
  clips?: TimelineClip[]
  audioTracks?: TimelineAudio[]
  adjustments?: AdjustmentLayer[]
  trackStates?: Partial<Record<LaneKey, { locked?: boolean; syncLock?: boolean }>>
  [key: string]: unknown
}

type CutRange = { start: number; end: number }
type ParsedCaption = { start: number; end: number; text: string }

const HEADER_WIDTH = 122
const FILLERS = new Set([
  'um', 'uh', 'umm', 'uhh', 'erm', 'hmm', 'mmm', 'ah', 'eh',
  'امم', 'اممم', 'أمم', 'مم', 'ممم', 'آه', 'اه', 'إيه', 'يعني',
])

function uid(prefix = 'tr') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function normalizeWord(text: string) {
  return text.trim().toLocaleLowerCase().replace(/^[\s.,!?؟،؛:()\[\]{}"'«»]+|[\s.,!?؟،؛:()\[\]{}"'«»]+$/g, '')
}

function isFiller(word: TranscriptWord) {
  return FILLERS.has(normalizeWord(word.text))
}

function fmt(seconds: number) {
  const safe = Math.max(0, seconds)
  const whole = Math.floor(safe)
  const ms = Math.round((safe - whole) * 1000)
  const hh = Math.floor(whole / 3600)
  const mm = Math.floor((whole % 3600) / 60)
  const ss = whole % 60
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

function subtitleTimestamp(seconds: number, comma = true) {
  const safe = Math.max(0, seconds)
  const whole = Math.floor(safe)
  const ms = Math.round((safe - whole) * 1000)
  const hh = Math.floor(whole / 3600)
  const mm = Math.floor((whole % 3600) / 60)
  const ss = whole % 60
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}${comma ? ',' : '.'}${String(ms).padStart(3, '0')}`
}

function parseTimestamp(value: string) {
  const match = value.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/)
  if (!match) return Number.NaN
  const hours = Number(match[1] || 0)
  const minutes = Number(match[2] || 0)
  const seconds = Number(match[3] || 0)
  const millis = Number(String(match[4]).padEnd(3, '0').slice(0, 3))
  return hours * 3600 + minutes * 60 + seconds + millis / 1000
}

function parseCaptionFile(text: string): ParsedCaption[] {
  const normalized = text.replace(/^\uFEFF/, '').replace(/^WEBVTT[^\n]*\n/i, '').replace(/\r/g, '')
  const blocks = normalized.split(/\n{2,}/)
  const output: ParsedCaption[] = []
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean)
    const timingIndex = lines.findIndex((line) => line.includes('-->'))
    if (timingIndex < 0) continue
    const [left, right] = lines[timingIndex].split('-->').map((part) => part.trim().split(/\s+/)[0])
    const start = parseTimestamp(left)
    const end = parseTimestamp(right)
    const body = lines.slice(timingIndex + 1).join(' ').replace(/<[^>]+>/g, '').trim()
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !body) continue
    output.push({ start, end, text: body })
  }
  return output.sort((a, b) => a.start - b.start)
}

function wordsFromCaptions(captions: ParsedCaption[], timelineOffset: number): TranscriptWord[] {
  const output: TranscriptWord[] = []
  for (const caption of captions) {
    const tokens = caption.text.split(/\s+/).filter(Boolean)
    if (!tokens.length) continue
    const span = Math.max(.02, caption.end - caption.start)
    tokens.forEach((token, index) => {
      const start = caption.start + span * index / tokens.length
      const end = caption.start + span * (index + 1) / tokens.length
      output.push({
        id: uid('w'),
        text: token,
        start,
        end,
        timelineStart: timelineOffset + start,
        timelineEnd: timelineOffset + end,
        speaker: null,
      })
    })
  }
  return output
}

function programPanel() {
  const labels = Array.from(document.querySelectorAll<HTMLElement>('.maghrabi-studio-pro main p'))
  const label = labels.find((item) => (item.textContent || '').trim().toUpperCase() === 'PROGRAM MONITOR')
  return label?.closest<HTMLElement>('div[class*="rounded-3xl"]') || null
}

function editorButtons() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.maghrabi-studio-pro main button'))
}

function clickRestore() {
  editorButtons().find((button) => (button.textContent || '').includes('استعادة'))?.click()
}

async function flushEditorSave(projectId: string) {
  const button = editorButtons().find((item) => (item.textContent || '').includes('حفظ'))
  if (!button || button.disabled) return loadStoredVideoProject<ProjectShape>(projectId)
  const done = new Promise<void>((resolve) => {
    let timer = 0
    const finish = () => {
      window.clearTimeout(timer)
      window.removeEventListener('maghrabi-project-snapshot-changed', onSaved as EventListener)
      resolve()
    }
    const onSaved = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string | null }>).detail
      if (detail?.projectId && detail.projectId !== projectId) return
      finish()
    }
    window.addEventListener('maghrabi-project-snapshot-changed', onSaved as EventListener)
    timer = window.setTimeout(finish, 1800)
  })
  button.click()
  await done
  return loadStoredVideoProject<ProjectShape>(projectId)
}

function parseZoom() {
  const spans = Array.from(document.querySelectorAll<HTMLSpanElement>('.maghrabi-studio-pro main span'))
  for (const span of spans) {
    const match = (span.textContent || '').match(/([\d.]+)\s*px\/s/i)
    if (match) return Math.max(1, Number(match[1]) || 12)
  }
  return 12
}

function seekTimeline(time: number) {
  const playhead = document.querySelector<HTMLElement>('.maghrabi-playhead')
    || document.querySelector<HTMLElement>('.maghrabi-studio-pro .bg-red-400.pointer-events-none')
  const timeline = playhead?.parentElement
  if (!timeline || !playhead) return
  const adjustmentRow = Array.from(timeline.children).find((child) => child instanceof HTMLElement && child.className.includes('h-[52px]')) as HTMLElement | undefined
  const target = adjustmentRow?.lastElementChild as HTMLElement | null
  if (!target) return
  const rect = target.getBoundingClientRect()
  const x = clamp(rect.left + Math.max(0, time) * parseZoom(), rect.left, Math.max(rect.left, rect.right - 1))
  target.dispatchEvent(new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: rect.top + rect.height / 2,
    view: window,
  }))
  playhead.style.left = `${HEADER_WIDTH + Math.max(0, time) * parseZoom()}px`
  window.dispatchEvent(new CustomEvent('maghrabi-transcript-seek', { detail: { time } }))
}

function videoDuration(clip: TimelineClip) {
  if (clip.freezeFrame) return Math.max(.2, Number(clip.freezeDuration || 2))
  return Math.max(.02, (Number(clip.end) - Number(clip.start)) / Math.max(.25, Number(clip.speed || 1)))
}

function audioDuration(track: TimelineAudio) {
  return Math.max(.02, Number(track.sourceEnd) - Number(track.sourceStart))
}

function videoPiecesAfterRemoval(clip: TimelineClip, cutStart: number, cutEnd: number, closeGap: boolean) {
  const clipStart = clip.startAt
  const clipEnd = clip.startAt + videoDuration(clip)
  const delta = cutEnd - cutStart
  if (clipEnd <= cutStart || clipStart >= cutEnd) {
    return [clipStart >= cutEnd && closeGap ? { ...clip, startAt: clip.startAt - delta } : clip]
  }
  const result: TimelineClip[] = []
  if (clip.freezeFrame) {
    if (clipStart < cutStart) result.push({ ...clip, id: uid('v'), freezeDuration: Math.max(.02, cutStart - clipStart), transitionOut: undefined })
    if (clipEnd > cutEnd) result.push({ ...clip, id: uid('v'), startAt: closeGap ? cutStart : cutEnd, freezeDuration: Math.max(.02, clipEnd - cutEnd), transitionOut: undefined })
    return result
  }
  const speed = Math.max(.25, Number(clip.speed || 1))
  if (clipStart < cutStart) {
    const sourceEnd = Number(clip.start) + (cutStart - clipStart) * speed
    result.push({ ...clip, id: uid('v'), end: clamp(sourceEnd, Number(clip.start) + .02, Number(clip.end)), detachedTrackId: null, transitionOut: undefined })
  }
  if (clipEnd > cutEnd) {
    const sourceStart = Number(clip.start) + (cutEnd - clipStart) * speed
    result.push({ ...clip, id: uid('v'), start: clamp(sourceStart, Number(clip.start), Number(clip.end) - .02), startAt: closeGap ? cutStart : cutEnd, detachedTrackId: null, transitionOut: undefined })
  }
  return result
}

function audioPiecesAfterRemoval(track: TimelineAudio, cutStart: number, cutEnd: number, closeGap: boolean) {
  const trackStart = track.startAt
  const trackEnd = track.startAt + audioDuration(track)
  const delta = cutEnd - cutStart
  if (trackEnd <= cutStart || trackStart >= cutEnd) {
    return [trackStart >= cutEnd && closeGap ? { ...track, startAt: track.startAt - delta } : track]
  }
  const result: TimelineAudio[] = []
  if (trackStart < cutStart) {
    const sourceEnd = Number(track.sourceStart) + (cutStart - trackStart)
    result.push({ ...track, id: uid('a'), sourceEnd: clamp(sourceEnd, Number(track.sourceStart) + .02, Number(track.sourceEnd)), linkedClipId: null })
  }
  if (trackEnd > cutEnd) {
    const sourceStart = Number(track.sourceStart) + (cutEnd - trackStart)
    result.push({ ...track, id: uid('a'), sourceStart: clamp(sourceStart, Number(track.sourceStart), Number(track.sourceEnd) - .02), startAt: closeGap ? cutStart : cutEnd, linkedClipId: null })
  }
  return result
}

function adjustmentAfterRemoval(layer: AdjustmentLayer, cutStart: number, cutEnd: number, closeGap: boolean) {
  const delta = cutEnd - cutStart
  if (layer.endAt <= cutStart) return [layer]
  if (layer.startAt >= cutEnd) return [{ ...layer, startAt: closeGap ? layer.startAt - delta : layer.startAt, endAt: closeGap ? layer.endAt - delta : layer.endAt }]
  if (layer.startAt < cutStart && layer.endAt > cutEnd) return [{ ...layer, endAt: closeGap ? layer.endAt - delta : layer.endAt }]
  if (layer.startAt < cutStart) return [{ ...layer, endAt: cutStart }]
  if (layer.endAt > cutEnd) return [{ ...layer, startAt: closeGap ? cutStart : cutEnd, endAt: closeGap ? layer.endAt - delta : layer.endAt }]
  return []
}

function rangeTouchesLane(project: ProjectShape, lane: LaneKey, range: CutRange) {
  if (lane.startsWith('V')) {
    return (project.clips || []).some((clip) => clip.lane === lane && clip.startAt + videoDuration(clip) > range.start && clip.startAt >= range.start - videoDuration(clip))
  }
  return (project.audioTracks || []).some((track) => track.lane === lane && track.startAt + audioDuration(track) > range.start && track.startAt >= range.start - audioDuration(track))
}

function assertRippleSafe(project: ProjectShape, ranges: CutRange[], targetLane: AudioLane) {
  const transcriptTracks = (project.audioTracks || []).filter((track) => track.dialogueTranscript)
  if (transcriptTracks.some((track) => Math.abs(Number(track.dialogueTempo || 1) - 1) > .001)) {
    throw new Error('للدقة الإطارية: أعد Dialogue Timing Fit إلى 1.00× قبل Transcript Ripple Delete.')
  }
  const states = project.trackStates || {}
  for (const lane of ['V1', 'V2', 'V3', 'A1', 'A2', 'A3'] as LaneKey[]) {
    const state = states[lane]
    const followsRipple = lane === targetLane || state?.syncLock !== false
    if (!followsRipple || !state?.locked) continue
    if (ranges.some((range) => rangeTouchesLane(project, lane, range))) {
      throw new Error(`المسار ${lane} مقفل ويمنع Ripple Delete. افتح القفل أو عطّل Sync Lock.`)
    }
  }
}

function applyRippleCut(project: ProjectShape, range: CutRange, targetLane: AudioLane) {
  const states = project.trackStates || {}
  project.clips = (project.clips || []).flatMap((clip) => {
    const follows = states[clip.lane]?.syncLock !== false
    return follows ? videoPiecesAfterRemoval(clip, range.start, range.end, true) : [clip]
  })
  project.audioTracks = (project.audioTracks || []).flatMap((track) => {
    const follows = track.lane === targetLane || states[track.lane]?.syncLock !== false
    return follows ? audioPiecesAfterRemoval(track, range.start, range.end, true) : [track]
  })
  project.adjustments = (project.adjustments || []).flatMap((layer) => adjustmentAfterRemoval(layer, range.start, range.end, true))
}

function mergeRanges(ranges: CutRange[]) {
  const ordered = ranges
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end - range.start >= .015)
    .sort((a, b) => a.start - b.start)
  const merged: CutRange[] = []
  for (const range of ordered) {
    const previous = merged.at(-1)
    if (previous && range.start <= previous.end + .08) previous.end = Math.max(previous.end, range.end)
    else merged.push({ ...range })
  }
  return merged
}

function shiftTranscript(document: TranscriptDocument, ranges: CutRange[], removedWordIds: Set<string>) {
  const ordered = mergeRanges(ranges)
  const words = document.words
    .filter((word) => !removedWordIds.has(word.id))
    .map((word) => {
      let shift = 0
      for (const range of ordered) {
        if (word.timelineStart >= range.end - .0005) shift += range.end - range.start
      }
      return {
        ...word,
        timelineStart: Math.max(0, word.timelineStart - shift),
        timelineEnd: Math.max(.01, word.timelineEnd - shift),
      }
    })
  return { ...document, words, text: words.map((word) => word.text).join(' ') }
}

function captionGroups(document: TranscriptDocument) {
  const words = [...document.words].sort((a, b) => a.timelineStart - b.timelineStart)
  const groups: Array<{ start: number; end: number; text: string }> = []
  let current: TranscriptWord[] = []
  const flush = () => {
    if (!current.length) return
    const speaker = current[0].speaker
    let text = current.map((word) => word.text).join(' ')
    if (document.captionSpeakerLabels && speaker) text = `${speaker}: ${text}`
    groups.push({ start: current[0].timelineStart, end: current.at(-1)!.timelineEnd, text })
    current = []
  }
  for (const word of words) {
    if (current.length) {
      const gap = word.timelineStart - current.at(-1)!.timelineEnd
      const duration = word.timelineEnd - current[0].timelineStart
      const speakerChanged = Boolean(word.speaker && current[0].speaker && word.speaker !== current[0].speaker)
      if (gap > document.captionBreakGap || duration > document.captionMaxDuration || current.length >= document.captionMaxWords || speakerChanged) flush()
    }
    current.push(word)
    if (/[.!?؟؛:]$/.test(word.text)) flush()
  }
  flush()
  return groups
}

function downloadText(filename: string, text: string, type: string) {
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export default function StudioTranscriptEditorPro() {
  const [launcherHost, setLauncherHost] = useState<HTMLElement | null>(null)
  const [open, setOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<StoredVideoProject<ProjectShape> | null>(null)
  const [status, setStatus] = useState<TranscriptStatus | null>(null)
  const [targetId, setTargetId] = useState('')
  const [language, setLanguage] = useState('ar')
  const [prompt, setPrompt] = useState('')
  const [diarize, setDiarize] = useState(true)
  const [search, setSearch] = useState('')
  const [speaker, setSpeaker] = useState('ALL')
  const [selected, setSelected] = useState<string[]>([])
  const [silenceThreshold, setSilenceThreshold] = useState(.65)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const tracks = snapshot?.project.audioTracks || []
  const target = useMemo(() => tracks.find((track) => track.id === targetId) || null, [tracks, targetId])
  const document = target?.dialogueTranscript || null
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const speakers = useMemo(() => Array.from(new Set((document?.words || []).map((word) => word.speaker).filter((value): value is string => Boolean(value)))), [document])
  const fillerWords = useMemo(() => (document?.words || []).filter(isFiller), [document])
  const silenceGaps = useMemo(() => {
    if (!document) return []
    const words = [...document.words].sort((a, b) => a.timelineStart - b.timelineStart)
    return words.slice(1).map((word, index) => ({ start: words[index].timelineEnd, end: word.timelineStart })).filter((gap) => gap.end - gap.start >= silenceThreshold)
  }, [document, silenceThreshold])

  const visibleWords = useMemo(() => {
    if (!document) return []
    const query = search.trim().toLocaleLowerCase()
    return document.words.filter((word) => {
      if (speaker !== 'ALL' && word.speaker !== speaker) return false
      if (query && !word.text.toLocaleLowerCase().includes(query)) return false
      return true
    })
  }, [document, search, speaker])

  const announce = (text: string) => {
    setMessage(text)
    window.setTimeout(() => setMessage((current) => current === text ? '' : current), 3600)
  }

  const reload = async (preferTrackId?: string) => {
    const projectId = getActiveStudioProjectId()
    if (!projectId) {
      setSnapshot(null)
      return
    }
    const next = await loadStoredVideoProject<ProjectShape>(projectId).catch(() => null)
    setSnapshot(next)
    if (!next) return
    const nextTracks = next.project.audioTracks || []
    const preferred = nextTracks.find((track) => track.id === (preferTrackId || targetId))
      || nextTracks.find((track) => track.dialogueTranscript)
      || [...nextTracks].reverse().find((track) => track.adrTakeActive)
      || nextTracks[0]
    setTargetId(preferred?.id || '')
  }

  const saveDocument = async (nextDocument: TranscriptDocument, success: string) => {
    const projectId = getActiveStudioProjectId()
    if (!projectId || !target) return
    setBusy(true)
    try {
      const current = await flushEditorSave(projectId)
      if (!current) throw new Error('تعذر قراءة المشروع الحالي.')
      const project = JSON.parse(JSON.stringify(current.project || {})) as ProjectShape
      project.audioTracks = Array.isArray(project.audioTracks) ? project.audioTracks : []
      let matched = false
      project.audioTracks = project.audioTracks.map((track) => {
        const sameDocument = track.dialogueTranscript?.id && track.dialogueTranscript.id === nextDocument.id
        if (track.id === target.id || sameDocument) {
          matched = true
          return { ...track, dialogueTranscript: nextDocument }
        }
        return track
      })
      if (!matched) throw new Error('المسار الصوتي المحدد لم يعد موجودًا.')
      await saveStoredVideoProject({ ...current, project, savedAt: new Date().toISOString() }, projectId)
      window.setTimeout(clickRestore, 70)
      await reload()
      announce(success)
    } catch (error) {
      announce(error instanceof Error ? error.message : 'تعذر حفظ Transcript.')
    } finally {
      setBusy(false)
    }
  }

  const transcribe = async () => {
    const projectId = getActiveStudioProjectId()
    if (!projectId || !target) return
    const file = snapshot?.audios[target.fileIndex]
    if (!(file instanceof File)) {
      announce('تعذر قراءة ملف الصوت المرتبط بالمسار.')
      return
    }
    setBusy(true)
    try {
      const result = await transcribeAudioTrack(file, {
        sourceStart: target.sourceStart,
        sourceEnd: target.sourceEnd,
        language,
        prompt,
        diarize,
      })
      const tempo = clamp(Number(target.dialogueTempo || 1), .9, 1.1)
      const words: TranscriptWord[] = result.words.map((word) => ({
        id: uid('w'),
        text: word.text,
        start: word.start,
        end: word.end,
        timelineStart: target.startAt + word.start / tempo,
        timelineEnd: target.startAt + word.end / tempo,
        speaker: word.speaker || null,
      }))
      if (!words.length) throw new Error('لم يرجع محرك Transcript كلمات ذات Timecodes.')
      const nextDocument: TranscriptDocument = {
        id: uid('transcript'),
        version: 1,
        generatedAt: new Date().toISOString(),
        provider: result.provider,
        wordModel: result.wordModel,
        diarizeModel: result.diarizeModel,
        diarized: result.diarized,
        language: result.language || language || null,
        sourceFileIndex: target.fileIndex,
        sourceTrackId: target.id,
        text: result.text || words.map((word) => word.text).join(' '),
        words,
        captionsEnabled: false,
        captionSize: 38,
        captionPosition: 'bottom',
        captionColor: '#ffffff',
        captionBoxOpacity: .48,
        captionMaxWords: 7,
        captionMaxDuration: 3.2,
        captionBreakGap: .65,
        captionSpeakerLabels: Boolean(result.diarized),
      }
      await saveDocument(nextDocument, `اكتمل Transcript: ${words.length} كلمة${result.diarized ? ' مع Speaker Labels' : ''}.`)
      setSelected([])
    } catch (error) {
      announce(error instanceof Error ? error.message : 'تعذر إنشاء Transcript.')
    } finally {
      setBusy(false)
    }
  }

  const importCaptions = async (file: File) => {
    if (!target) return
    try {
      const parsed = parseCaptionFile(await file.text())
      if (!parsed.length) throw new Error('لم أجد Timecodes صالحة داخل ملف SRT/VTT.')
      const words = wordsFromCaptions(parsed, target.startAt)
      const nextDocument: TranscriptDocument = {
        id: uid('transcript'),
        version: 1,
        generatedAt: new Date().toISOString(),
        provider: 'subtitle-import',
        wordModel: 'timed-caption-import',
        diarizeModel: null,
        diarized: false,
        language: language || null,
        sourceFileIndex: target.fileIndex,
        sourceTrackId: target.id,
        text: parsed.map((item) => item.text).join(' '),
        words,
        captionsEnabled: true,
        captionSize: 38,
        captionPosition: 'bottom',
        captionColor: '#ffffff',
        captionBoxOpacity: .48,
        captionMaxWords: 7,
        captionMaxDuration: 3.2,
        captionBreakGap: .65,
        captionSpeakerLabels: false,
      }
      await saveDocument(nextDocument, `تم استيراد ${parsed.length} Caption وربطها بالـTimeline.`)
    } catch (error) {
      announce(error instanceof Error ? error.message : 'تعذر استيراد ملف الترجمة.')
    }
  }

  const rippleDelete = async (ranges: CutRange[], removedIds: Set<string>, label: string) => {
    if (!target || !document) return
    const merged = mergeRanges(ranges)
    if (!merged.length) return
    const total = merged.reduce((sum, range) => sum + range.end - range.start, 0)
    if (!window.confirm(`${label}\nسيتم Ripple Delete بمقدار ${total.toFixed(2)} ثانية على المسارات ذات Sync Lock. هل تريد المتابعة؟`)) return
    const projectId = getActiveStudioProjectId()
    if (!projectId) return
    setBusy(true)
    try {
      const current = await flushEditorSave(projectId)
      if (!current) throw new Error('تعذر قراءة المشروع الحالي.')
      const project = JSON.parse(JSON.stringify(current.project || {})) as ProjectShape
      assertRippleSafe(project, merged, target.lane)
      for (const range of [...merged].sort((a, b) => b.start - a.start)) applyRippleCut(project, range, target.lane)
      const nextDocument = shiftTranscript(document, merged, removedIds)
      project.audioTracks = (project.audioTracks || []).map((track) => track.dialogueTranscript?.id === document.id ? { ...track, dialogueTranscript: nextDocument } : track)
      await saveStoredVideoProject({ ...current, project, savedAt: new Date().toISOString() }, projectId)
      setSelected([])
      window.setTimeout(clickRestore, 70)
      await reload()
      announce(`${label} · تم إغلاق ${total.toFixed(2)} ثانية من الـTimeline.`)
    } catch (error) {
      announce(error instanceof Error ? error.message : 'تعذر تنفيذ Transcript Ripple Delete.')
    } finally {
      setBusy(false)
    }
  }

  const exportCaptions = (kind: 'srt' | 'vtt') => {
    if (!document) return
    const groups = captionGroups(document)
    if (kind === 'srt') {
      const body = groups.map((group, index) => `${index + 1}\n${subtitleTimestamp(group.start)} --> ${subtitleTimestamp(group.end)}\n${group.text}\n`).join('\n')
      downloadText('MAGHRABI-transcript.srt', body, 'application/x-subrip;charset=utf-8')
    } else {
      const body = `WEBVTT\n\n${groups.map((group) => `${subtitleTimestamp(group.start, false)} --> ${subtitleTimestamp(group.end, false)}\n${group.text}\n`).join('\n')}`
      downloadText('MAGHRABI-transcript.vtt', body, 'text/vtt;charset=utf-8')
    }
  }

  useEffect(() => {
    let disposed = false
    const refreshHost = () => {
      if (!disposed) setLauncherHost(programPanel())
    }
    const observer = new MutationObserver(refreshHost)
    observer.observe(document.body, { childList: true, subtree: true })
    refreshHost()
    void reload()
    void getTranscriptStatus().then(setStatus).catch(() => setStatus(null))
    const onSnapshot = () => void reload()
    const onProject = () => {
      setSelected([])
      void reload()
      void getTranscriptStatus().then(setStatus).catch(() => setStatus(null))
    }
    window.addEventListener('maghrabi-project-snapshot-changed', onSnapshot)
    window.addEventListener('maghrabi-active-project-changed', onProject)
    return () => {
      disposed = true
      observer.disconnect()
      window.removeEventListener('maghrabi-project-snapshot-changed', onSnapshot)
      window.removeEventListener('maghrabi-active-project-changed', onProject)
    }
  }, [])

  const launcher = launcherHost ? createPortal(
    <button type="button" className="maghrabi-transcript-launcher" onClick={() => setOpen(true)}>
      <FileText className="h-3.5 w-3.5" />
      TRANSCRIPT PRO
      {document ? <span>{document.words.length} WORDS</span> : null}
    </button>,
    launcherHost,
  ) : null

  const drawer = open ? createPortal(
    <div className="maghrabi-transcript-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false) }}>
      <section className="maghrabi-transcript-drawer" dir="rtl" aria-label="Transcript based editing workspace">
        <header>
          <div>
            <div className="maghrabi-transcript-kicker"><Sparkles className="h-3.5 w-3.5" /> DIALOGUE INTELLIGENCE</div>
            <h2>Transcript-Based Editing</h2>
            <p>Word Timecodes · Speaker Labels · Search · Filler/Silence Detection · Ripple Delete · Captions</p>
          </div>
          <button type="button" className="maghrabi-transcript-close" onClick={() => setOpen(false)}><X className="h-4 w-4" /></button>
        </header>

        <div className="maghrabi-transcript-source-grid">
          <label>Dialogue Track
            <select value={targetId} onChange={(event) => { setTargetId(event.target.value); setSelected([]) }}>
              {tracks.map((track) => <option key={track.id} value={track.id}>{track.lane} · {track.name || `Audio ${track.fileIndex + 1}`}{track.dialogueTranscript ? ' · TRANSCRIPT' : ''}</option>)}
            </select>
          </label>
          <label>Language
            <select value={language} onChange={(event) => setLanguage(event.target.value)}>
              <option value="ar">Arabic · ar</option>
              <option value="en">English · en</option>
              <option value="auto">Auto Detect</option>
            </select>
          </label>
          <label className="maghrabi-transcript-check"><input type="checkbox" checked={diarize} onChange={(event) => setDiarize(event.target.checked)} /> <Users className="h-3.5 w-3.5" /> Speaker Labels</label>
        </div>

        <div className="maghrabi-transcript-actions">
          <button type="button" onClick={transcribe} disabled={busy || !target || status?.configured === false}><WandSparkles className="h-3.5 w-3.5" /> {busy ? 'PROCESSING…' : 'TRANSCRIBE'}</button>
          <label className="maghrabi-transcript-import"><Upload className="h-3.5 w-3.5" /> IMPORT SRT/VTT<input type="file" accept=".srt,.vtt,text/vtt,application/x-subrip" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importCaptions(file); event.currentTarget.value = '' }} /></label>
          <span className={`maghrabi-transcript-engine ${status?.configured ? 'is-ready' : ''}`}>{status?.configured ? `${status.wordModel}${diarize ? ' + DIARIZE' : ''}` : 'TRANSCRIPTION KEY REQUIRED'}</span>
        </div>

        <label className="maghrabi-transcript-prompt">Vocabulary / Context Prompt
          <input value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="أسماء أشخاص، مصطلحات تقنية، أسماء مشاريع…" />
        </label>

        {document ? <>
          <div className="maghrabi-transcript-stats">
            <span><FileText className="h-3 w-3" /> {document.words.length} WORDS</span>
            <span><Users className="h-3 w-3" /> {speakers.length || 1} SPEAKERS</span>
            <span><Trash2 className="h-3 w-3" /> {fillerWords.length} FILLERS</span>
            <span><Clock3 className="h-3 w-3" /> {silenceGaps.length} SILENCES</span>
          </div>

          <div className="maghrabi-transcript-search-row">
            <label><Search className="h-3.5 w-3.5" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="بحث داخل الحوار…" /></label>
            <select value={speaker} onChange={(event) => setSpeaker(event.target.value)}><option value="ALL">ALL SPEAKERS</option>{speakers.map((item) => <option key={item} value={item}>{item}</option>)}</select>
          </div>

          <div className="maghrabi-transcript-wordbox" dir={document.language === 'ar' ? 'rtl' : 'ltr'}>
            {visibleWords.map((word) => <button
              type="button"
              key={word.id}
              className={`${selectedSet.has(word.id) ? 'is-selected ' : ''}${isFiller(word) ? 'is-filler ' : ''}`}
              title={`${fmt(word.timelineStart)}${word.speaker ? ` · ${word.speaker}` : ''}`}
              onDoubleClick={() => seekTimeline(word.timelineStart)}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey) setSelected((state) => state.includes(word.id) ? state.filter((id) => id !== word.id) : [...state, word.id])
                else setSelected([word.id])
              }}
            >
              {word.speaker ? <small>{word.speaker}</small> : null}<span>{word.text}</span><em>{fmt(word.timelineStart).slice(3, 8)}</em>
            </button>)}
          </div>
          <p className="maghrabi-transcript-hint">Double-click = Seek · Ctrl/Cmd + Click = Multi-select · الكلمات البرتقالية مرشحة كـFiller</p>

          <div className="maghrabi-transcript-editbar">
            <button type="button" onClick={() => setSelected(fillerWords.map((word) => word.id))}>SELECT FILLERS</button>
            <button type="button" onClick={() => setSelected([])}>CLEAR</button>
            <button type="button" className="is-danger" disabled={!selected.length || busy} onClick={() => {
              const words = document.words.filter((word) => selectedSet.has(word.id))
              void rippleDelete(words.map((word) => ({ start: word.timelineStart, end: word.timelineEnd })), selectedSet, `DELETE ${words.length} SELECTED WORDS`)
            }}><Scissors className="h-3.5 w-3.5" /> RIPPLE DELETE ({selected.length})</button>
          </div>

          <div className="maghrabi-transcript-silence">
            <div><strong>SILENCE DETECTION</strong><span>الفجوات بين الكلمات مع Handles تلقائية من Timecodes</span></div>
            <label>{silenceThreshold.toFixed(2)}s<input type="range" min="0.35" max="1.5" step="0.05" value={silenceThreshold} onChange={(event) => setSilenceThreshold(Number(event.target.value))} /></label>
            <button type="button" disabled={!silenceGaps.length || busy} onClick={() => {
              const safeRanges = silenceGaps.map((gap) => ({ start: gap.start + .08, end: gap.end - .08 })).filter((gap) => gap.end - gap.start >= .08)
              void rippleDelete(safeRanges, new Set(), `REMOVE ${safeRanges.length} SILENCE GAPS`)
            }}>REMOVE SILENCE</button>
          </div>

          <div className="maghrabi-transcript-captions">
            <div className="maghrabi-transcript-caption-head"><div><Captions className="h-4 w-4" /><span><strong>AUTO CAPTIONS</strong><small>Render-time subtitles generated directly from Transcript words</small></span></div><button type="button" className={document.captionsEnabled ? 'is-on' : ''} disabled={busy} onClick={() => void saveDocument({ ...document, captionsEnabled: !document.captionsEnabled }, document.captionsEnabled ? 'تم إيقاف Auto Captions.' : 'تم تفعيل Auto Captions للـRender.')}>{document.captionsEnabled ? 'ON' : 'OFF'}</button></div>
            <div className="maghrabi-transcript-caption-grid">
              <label>Size <input type="range" min="24" max="64" value={document.captionSize} onChange={(event) => setSnapshot((current) => current && target ? { ...current, project: { ...current.project, audioTracks: (current.project.audioTracks || []).map((track) => track.id === target.id ? { ...track, dialogueTranscript: { ...document, captionSize: Number(event.target.value) } } : track) } } : current)} /></label>
              <label>Color <input type="color" value={document.captionColor} onChange={(event) => setSnapshot((current) => current && target ? { ...current, project: { ...current.project, audioTracks: (current.project.audioTracks || []).map((track) => track.id === target.id ? { ...track, dialogueTranscript: { ...document, captionColor: event.target.value } } : track) } } : current)} /></label>
              <label>Position <select value={document.captionPosition} onChange={(event) => setSnapshot((current) => current && target ? { ...current, project: { ...current.project, audioTracks: (current.project.audioTracks || []).map((track) => track.id === target.id ? { ...track, dialogueTranscript: { ...document, captionPosition: event.target.value as TranscriptDocument['captionPosition'] } } : track) } } : current)}><option value="bottom">BOTTOM</option><option value="center">CENTER</option><option value="top">TOP</option></select></label>
              <label>Words/Caption <input type="number" min="2" max="12" value={document.captionMaxWords} onChange={(event) => setSnapshot((current) => current && target ? { ...current, project: { ...current.project, audioTracks: (current.project.audioTracks || []).map((track) => track.id === target.id ? { ...track, dialogueTranscript: { ...document, captionMaxWords: clamp(Number(event.target.value), 2, 12) } } : track) } } : current)} /></label>
              <label className="maghrabi-transcript-check"><input type="checkbox" checked={document.captionSpeakerLabels} onChange={(event) => setSnapshot((current) => current && target ? { ...current, project: { ...current.project, audioTracks: (current.project.audioTracks || []).map((track) => track.id === target.id ? { ...track, dialogueTranscript: { ...document, captionSpeakerLabels: event.target.checked } } : track) } } : current)} /> Speaker Prefix</label>
              <button type="button" onClick={() => void saveDocument(document, 'تم حفظ إعدادات Captions.')}>SAVE CAPTION STYLE</button>
            </div>
            <div className="maghrabi-transcript-export"><button type="button" onClick={() => exportCaptions('srt')}><Download className="h-3.5 w-3.5" /> SRT</button><button type="button" onClick={() => exportCaptions('vtt')}><Download className="h-3.5 w-3.5" /> VTT</button></div>
          </div>
        </> : <div className="maghrabi-transcript-empty"><FileText className="h-8 w-8" /><strong>لا يوجد Transcript لهذا المسار</strong><span>استخدم TRANSCRIBE للحصول على Word-Level Timecodes، أو استورد ملف SRT/VTT جاهزًا.</span></div>}

        {message ? <div className="maghrabi-transcript-toast">{message}</div> : null}
      </section>
    </div>,
    document.body,
  ) : null

  return <>{launcher}{drawer}</>
}
