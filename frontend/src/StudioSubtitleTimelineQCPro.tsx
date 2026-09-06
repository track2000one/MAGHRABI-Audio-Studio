import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, BadgeCheck, Captions, Download, Gauge, RotateCcw, ShieldCheck, X } from 'lucide-react'
import { getActiveStudioProjectId } from './lib/projectHubStore'
import { loadStoredVideoProject, saveStoredVideoProject, type StoredVideoProject } from './lib/projectStore'
import { loadCreativeSettings, type CreativeTitle } from './lib/creativeProjectSettings'
import {
  SUBTITLE_FPS,
  SUBTITLE_FRAME,
  buildAutoSourceCaptionGroups,
  buildCaptionGroups,
  captionsToSrt,
  captionsToVtt,
  clampNumber,
  evaluateSubtitleQc,
  materializeManualSourceCues,
  quantizeSubtitleTime,
  type CaptionGroup,
  type TranscriptDocument,
  type TranscriptProjectShape,
  type TimelineAudioWithTranscript,
} from './lib/subtitleQc'
import './studioSubtitleTimelineQCPro.css'

const HEADER_WIDTH = 122
const MIN_CUE_DURATION = SUBTITLE_FRAME * 2

type TimingDraft = { cueId: string; start: number; end: number } | null
type GestureMode = 'move' | 'trim-left' | 'trim-right'
type GestureSnapshot = {
  cue: CaptionGroup
  mode: GestureMode
  startClientX: number
  zoom: number
  moved: boolean
  draftStart: number
  draftEnd: number
}

function parseZoom() {
  const spans = Array.from(document.querySelectorAll<HTMLSpanElement>('.maghrabi-studio-pro main span'))
  for (const span of spans) {
    const match = (span.textContent || '').match(/([\d.]+)\s*px\/s/i)
    if (match) return Math.max(1, Number(match[1]) || 12)
  }
  return 12
}

function timelineRoot() {
  return document.querySelector<HTMLElement>('.maghrabi-time-ruler')?.parentElement || null
}

function programPanel() {
  const labels = Array.from(document.querySelectorAll<HTMLElement>('.maghrabi-studio-pro main p'))
  const label = labels.find((item) => (item.textContent || '').trim().toUpperCase() === 'PROGRAM MONITOR')
  return label?.closest<HTMLElement>('div[class*="rounded-3xl"]') || null
}

function programVideoHost() {
  return programPanel()?.querySelector<HTMLElement>('.aspect-video') || null
}

function editorButtons() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.maghrabi-studio-pro main button'))
}

function clickRestore() {
  editorButtons().find((button) => (button.textContent || '').includes('استعادة'))?.click()
}

async function flushEditorSave(projectId: string) {
  const button = editorButtons().find((item) => (item.textContent || '').includes('حفظ'))
  if (!button || button.disabled) return loadStoredVideoProject<TranscriptProjectShape>(projectId)
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
  return loadStoredVideoProject<TranscriptProjectShape>(projectId)
}

function readFrameClock() {
  const value = Number(document.documentElement.dataset.maghrabiFrameClockTime)
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function formatTc(seconds: number) {
  const totalFrames = Math.max(0, Math.round(seconds * SUBTITLE_FPS))
  const frames = totalFrames % SUBTITLE_FPS
  const whole = Math.floor(totalFrames / SUBTITLE_FPS)
  const ss = whole % 60
  const mm = Math.floor(whole / 60) % 60
  const hh = Math.floor(whole / 3600)
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}:${String(frames).padStart(2, '0')}`
}

function rtlLanguage(language: string | null | undefined) {
  return ['ar', 'ur', 'fa', 'he'].includes((language || '').toLowerCase())
}

function downloadText(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1200)
}

function safeFilePart(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'source'
}

function seekTimeline(time: number) {
  const timeline = timelineRoot()
  if (!timeline) return
  const adjustmentRow = Array.from(timeline.children).find((child) => child instanceof HTMLElement && child.className.includes('h-[52px]')) as HTMLElement | undefined
  const surface = adjustmentRow?.lastElementChild as HTMLElement | null
  if (!surface) return
  const rect = surface.getBoundingClientRect()
  if (!rect.width) return
  const clientX = Math.min(rect.right - 1, Math.max(rect.left, rect.left + time * parseZoom()))
  surface.dispatchEvent(new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY: rect.top + rect.height / 2,
    view: window,
  }))
}

function nearestBoundary(value: number, boundaries: number[]) {
  let best = value
  let distance = SUBTITLE_FRAME * 2 + .0001
  for (const boundary of boundaries) {
    const delta = Math.abs(boundary - value)
    if (delta < distance) {
      distance = delta
      best = boundary
    }
  }
  return distance <= SUBTITLE_FRAME * 2 ? quantizeSubtitleTime(best) : value
}

function activeLanguageLabel(document: TranscriptDocument, language: string) {
  if (language === 'source') return `${(document.language || 'SOURCE').toUpperCase()} · SOURCE`
  return document.captionTranslations?.[language]?.label || language.toUpperCase()
}

function cueDisplayLanguage(document: TranscriptDocument) {
  const selected = document.captionLanguage || 'source'
  return selected !== 'source' && document.captionTranslations?.[selected] ? selected : 'source'
}

function sourceWordHighlight(cue: CaptionGroup, time: number) {
  if (!cue.words?.length) return -1
  if (!cue.manual) return cue.words.findIndex((word) => time >= word.timelineStart - .01 && time <= word.timelineEnd + .01)
  const progress = clampNumber((time - cue.start) / Math.max(MIN_CUE_DURATION, cue.end - cue.start), 0, .9999)
  return Math.floor(progress * cue.words.length)
}

export default function StudioSubtitleTimelineQCPro() {
  const [timelineHost, setTimelineHost] = useState<HTMLElement | null>(null)
  const [programHost, setProgramHost] = useState<HTMLElement | null>(null)
  const [snapshot, setSnapshot] = useState<StoredVideoProject<TranscriptProjectShape> | null>(null)
  const [targetId, setTargetId] = useState('')
  const [qcLanguage, setQcLanguage] = useState('source')
  const [zoom, setZoom] = useState(() => parseZoom())
  const [clock, setClock] = useState(() => readFrameClock())
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [safeAreas, setSafeAreas] = useState(false)
  const [timingDraft, setTimingDraft] = useState<TimingDraft>(null)
  const [busyCueId, setBusyCueId] = useState('')
  const [message, setMessage] = useState('')
  const [titles, setTitles] = useState<CreativeTitle[]>([])
  const gestureRef = useRef<GestureSnapshot | null>(null)

  const tracks = snapshot?.project.audioTracks || []
  const transcriptTracks = useMemo(() => tracks.filter((track): track is TimelineAudioWithTranscript & { dialogueTranscript: TranscriptDocument } => Boolean(track.dialogueTranscript)), [tracks])
  const target = useMemo(() => transcriptTracks.find((track) => track.id === targetId) || transcriptTracks[0] || null, [transcriptTracks, targetId])
  const transcript = target?.dialogueTranscript || null
  const availableLanguages = useMemo(() => {
    if (!transcript) return ['source']
    return ['source', ...Object.keys(transcript.captionTranslations || {}).filter((language) => Boolean(transcript.captionTranslations?.[language]?.cues?.length))]
  }, [transcript])
  const baseCues = useMemo(() => transcript ? buildCaptionGroups(transcript, qcLanguage) : [], [transcript, qcLanguage])
  const cues = useMemo(() => baseCues.map((cue) => timingDraft?.cueId === cue.id ? { ...cue, start: timingDraft.start, end: timingDraft.end } : cue), [baseCues, timingDraft])
  const report = useMemo(() => transcript ? evaluateSubtitleQc(cues, transcript, titles) : null, [cues, transcript, titles])
  const issueMap = useMemo(() => {
    const map = new Map<string, { errors: number; warnings: number }>()
    report?.issues.forEach((issue) => {
      const current = map.get(issue.cueId) || { errors: 0, warnings: 0 }
      if (issue.severity === 'error') current.errors += 1
      else current.warnings += 1
      map.set(issue.cueId, current)
    })
    return map
  }, [report])

  const liveLanguage = transcript ? cueDisplayLanguage(transcript) : 'source'
  const liveCues = useMemo(() => transcript ? buildCaptionGroups(transcript, liveLanguage) : [], [transcript, liveLanguage])
  const liveCue = useMemo(() => liveCues.find((cue) => clock >= cue.start - .015 && clock <= cue.end + .015) || null, [liveCues, clock])

  const announce = (text: string) => {
    setMessage(text)
    window.setTimeout(() => setMessage((current) => current === text ? '' : current), 4200)
  }

  const reload = async (preferredId?: string) => {
    const projectId = getActiveStudioProjectId()
    if (!projectId) {
      setSnapshot(null)
      setTargetId('')
      setTitles([])
      return
    }
    const next = await loadStoredVideoProject<TranscriptProjectShape>(projectId).catch(() => null)
    setSnapshot(next)
    const nextTracks = (next?.project.audioTracks || []).filter((track) => track.dialogueTranscript)
    const preferred = nextTracks.find((track) => track.id === (preferredId || targetId)) || nextTracks[0]
    setTargetId(preferred?.id || '')
    setTitles(loadCreativeSettings(projectId).titles)
  }

  const persistProjectDocument = async (
    mutator: (document: TranscriptDocument) => TranscriptDocument,
    success: string,
    cueId = '',
  ) => {
    const projectId = getActiveStudioProjectId()
    if (!projectId || !target || !transcript) return
    setBusyCueId(cueId || '__project__')
    try {
      const current = await flushEditorSave(projectId)
      if (!current) throw new Error('تعذر قراءة المشروع الحالي.')
      const project = JSON.parse(JSON.stringify(current.project || {})) as TranscriptProjectShape
      const currentTrack = (project.audioTracks || []).find((track) => track.id === target.id)
      const currentDocument = currentTrack?.dialogueTranscript
      if (!currentDocument) throw new Error('Transcript المحدد لم يعد موجودًا.')
      currentTrack.dialogueTranscript = mutator(currentDocument)
      await saveStoredVideoProject({ ...current, project, savedAt: new Date().toISOString() }, projectId)
      window.setTimeout(clickRestore, 70)
      await reload(target.id)
      window.dispatchEvent(new CustomEvent('maghrabi-subtitle-qc-changed', { detail: { projectId, transcriptId: currentDocument.id } }))
      announce(success)
    } catch (error) {
      announce(error instanceof Error ? error.message : 'تعذر حفظ Subtitle QC.')
    } finally {
      setBusyCueId('')
      setTimingDraft(null)
    }
  }

  const persistTiming = async (cue: CaptionGroup, start: number, end: number) => {
    if (!transcript) return
    const safeStart = quantizeSubtitleTime(start)
    const safeEnd = Math.max(safeStart + MIN_CUE_DURATION, quantizeSubtitleTime(end))
    await persistProjectDocument((document) => {
      if (qcLanguage === 'source') {
        const manual = materializeManualSourceCues(document).map((item) => item.id === cue.id ? { ...item, start: safeStart, end: safeEnd } : item)
        const translations = Object.fromEntries(Object.entries(document.captionTranslations || {}).map(([language, pack]) => [
          language,
          { ...pack, cues: pack.cues.map((item) => item.id === cue.id ? { ...item, start: safeStart, end: safeEnd } : item) },
        ]))
        return { ...document, captionManualCues: manual, captionTranslations: translations }
      }
      const pack = document.captionTranslations?.[qcLanguage]
      if (!pack) return document
      return {
        ...document,
        captionTranslations: {
          ...(document.captionTranslations || {}),
          [qcLanguage]: { ...pack, cues: pack.cues.map((item) => item.id === cue.id ? { ...item, start: safeStart, end: safeEnd } : item) },
        },
      }
    }, `تم تثبيت ${cue.id} على ${formatTc(safeStart)} → ${formatTc(safeEnd)} بدقة ${SUBTITLE_FPS}fps.`, cue.id)
  }

  const resetSourceTiming = async () => {
    if (!transcript?.captionManualCues?.length) return
    await persistProjectDocument((document) => {
      const nextDocument: TranscriptDocument = { ...document }
      delete nextDocument.captionManualCues
      const automatic = buildAutoSourceCaptionGroups(nextDocument)
      const byId = new Map(automatic.map((cue) => [cue.id, cue]))
      nextDocument.captionTranslations = Object.fromEntries(Object.entries(nextDocument.captionTranslations || {}).map(([language, pack]) => [
        language,
        {
          ...pack,
          cues: pack.cues.map((cue) => {
            const source = byId.get(cue.id)
            return source ? { ...cue, start: source.start, end: source.end } : cue
          }),
        },
      ]))
      return nextDocument
    }, 'تمت استعادة Word-Sync الأصلية ومزامنة توقيت اللغات المترجمة معها.')
  }

  const beginGesture = (event: React.PointerEvent<HTMLElement>, cue: CaptionGroup, mode: GestureMode) => {
    if (event.button !== 0 || busyCueId) return
    event.preventDefault()
    event.stopPropagation()
    const gesture: GestureSnapshot = {
      cue,
      mode,
      startClientX: event.clientX,
      zoom: parseZoom(),
      moved: false,
      draftStart: cue.start,
      draftEnd: cue.end,
    }
    gestureRef.current = gesture
    document.body.classList.add('maghrabi-subtitle-editing')
    const otherBoundaries = baseCues.filter((item) => item.id !== cue.id).flatMap((item) => [item.start, item.end])

    const onMove = (moveEvent: PointerEvent) => {
      const active = gestureRef.current
      if (!active) return
      moveEvent.preventDefault()
      const deltaPixels = moveEvent.clientX - active.startClientX
      const delta = deltaPixels / Math.max(1, active.zoom)
      active.moved ||= Math.abs(deltaPixels) >= 3
      const duration = active.cue.end - active.cue.start
      let start = active.cue.start
      let end = active.cue.end

      if (active.mode === 'move') {
        start = quantizeSubtitleTime(active.cue.start + delta)
        end = start + duration
        if (!moveEvent.altKey) {
          const snappedStart = nearestBoundary(start, otherBoundaries)
          const snappedEnd = nearestBoundary(end, otherBoundaries)
          const startShift = Math.abs(snappedStart - start)
          const endShift = Math.abs(snappedEnd - end)
          if (startShift <= endShift && snappedStart !== start) {
            start = snappedStart
            end = start + duration
          } else if (snappedEnd !== end) {
            end = snappedEnd
            start = Math.max(0, end - duration)
          }
        }
        if (start < 0) {
          end -= start
          start = 0
        }
      } else if (active.mode === 'trim-left') {
        start = quantizeSubtitleTime(active.cue.start + delta)
        if (!moveEvent.altKey) start = nearestBoundary(start, otherBoundaries)
        start = clampNumber(start, 0, active.cue.end - MIN_CUE_DURATION)
      } else {
        end = quantizeSubtitleTime(active.cue.end + delta)
        if (!moveEvent.altKey) end = nearestBoundary(end, otherBoundaries)
        end = Math.max(active.cue.start + MIN_CUE_DURATION, end)
      }

      active.draftStart = quantizeSubtitleTime(start)
      active.draftEnd = Math.max(active.draftStart + MIN_CUE_DURATION, quantizeSubtitleTime(end))
      setTimingDraft({ cueId: cue.id, start: active.draftStart, end: active.draftEnd })
    }

    const finish = () => {
      const active = gestureRef.current
      gestureRef.current = null
      document.body.classList.remove('maghrabi-subtitle-editing')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', cancel)
      if (!active) return
      if (!active.moved) {
        setTimingDraft(null)
        seekTimeline(active.cue.start)
        return
      }
      void persistTiming(active.cue, active.draftStart, active.draftEnd)
    }
    const cancel = () => {
      gestureRef.current = null
      document.body.classList.remove('maghrabi-subtitle-editing')
      setTimingDraft(null)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', cancel)
    }

    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', finish, { once: true })
    window.addEventListener('pointercancel', cancel, { once: true })
  }

  const exportLanguage = (language: string, format: 'srt' | 'vtt') => {
    if (!transcript) return
    const languageCues = buildCaptionGroups(transcript, language)
    if (!languageCues.length) return
    const code = language === 'source' ? transcript.language || 'source' : language
    const filename = `maghrabi-${safeFilePart(code)}-captions.${format}`
    const text = format === 'srt' ? captionsToSrt(languageCues, transcript) : captionsToVtt(languageCues, transcript)
    downloadText(filename, text, format === 'srt' ? 'application/x-subrip' : 'text/vtt')
  }

  const exportAll = (format: 'srt' | 'vtt') => {
    availableLanguages.forEach((language, index) => {
      window.setTimeout(() => exportLanguage(language, format), index * 120)
    })
    announce(`تم تجهيز ${availableLanguages.length} ملف ${format.toUpperCase()} مستقل للغات المتاحة.`)
  }

  useEffect(() => {
    let disposed = false
    const refreshHosts = () => {
      if (disposed) return
      setTimelineHost((current) => timelineRoot() || current)
      setProgramHost((current) => programVideoHost() || current)
    }
    const observer = new MutationObserver(refreshHosts)
    observer.observe(document.body, { childList: true, subtree: true })
    refreshHosts()
    void reload()

    const onSnapshot = () => void reload()
    const onProject = () => {
      setDrawerOpen(false)
      setSafeAreas(false)
      setTimingDraft(null)
      void reload()
    }
    const onCreative = () => {
      const projectId = getActiveStudioProjectId()
      setTitles(projectId ? loadCreativeSettings(projectId).titles : [])
    }
    const onClock = (event: Event) => {
      const time = Number((event as CustomEvent<{ time?: number }>).detail?.time)
      if (Number.isFinite(time)) setClock(Math.max(0, time))
    }
    const interval = window.setInterval(() => {
      setZoom((current) => {
        const next = parseZoom()
        return Math.abs(current - next) > .01 ? next : current
      })
      const nextClock = readFrameClock()
      setClock((current) => Math.abs(current - nextClock) > .0005 ? nextClock : current)
      refreshHosts()
    }, 120)

    window.addEventListener('maghrabi-project-snapshot-changed', onSnapshot)
    window.addEventListener('maghrabi-active-project-changed', onProject)
    window.addEventListener('maghrabi-creative-settings-changed', onCreative)
    window.addEventListener('maghrabi-frame-clock', onClock as EventListener)
    return () => {
      disposed = true
      observer.disconnect()
      window.clearInterval(interval)
      window.removeEventListener('maghrabi-project-snapshot-changed', onSnapshot)
      window.removeEventListener('maghrabi-active-project-changed', onProject)
      window.removeEventListener('maghrabi-creative-settings-changed', onCreative)
      window.removeEventListener('maghrabi-frame-clock', onClock as EventListener)
      document.documentElement.classList.remove('maghrabi-subtitle-qc-live-active')
      document.body.classList.remove('maghrabi-subtitle-editing')
    }
  }, [])

  useEffect(() => {
    if (!transcript) {
      setQcLanguage('source')
      return
    }
    setQcLanguage((current) => availableLanguages.includes(current) ? current : cueDisplayLanguage(transcript))
  }, [transcript?.id, transcript?.captionLanguage, availableLanguages.join('|')])

  useEffect(() => {
    document.documentElement.classList.toggle('maghrabi-subtitle-qc-live-active', Boolean(transcript?.captionsEnabled))
    return () => document.documentElement.classList.remove('maghrabi-subtitle-qc-live-active')
  }, [transcript?.captionsEnabled, transcript?.id])

  const timelineTrack = timelineHost && transcript ? createPortal(
    <div className="maghrabi-subtitle-track-row" dir="ltr" data-maghrabi-subtitle-track="1">
      <button type="button" className="maghrabi-subtitle-track-head" onClick={() => setDrawerOpen(true)} title="Open Professional Subtitle QC">
        <span>SUB</span>
        <small>{qcLanguage === 'source' ? (transcript.language || 'SRC').toUpperCase() : qcLanguage.toUpperCase()}</small>
        {report?.errors ? <b className="is-error">{report.errors}</b> : report?.warnings ? <b className="is-warning">{report.warnings}</b> : <b className="is-pass">✓</b>}
      </button>
      <div className="maghrabi-subtitle-track-surface" aria-label="Professional subtitle timeline track">
        {cues.map((cue) => {
          const status = issueMap.get(cue.id)
          const width = Math.max(18, (cue.end - cue.start) * zoom)
          const isBusy = busyCueId === cue.id
          return <div
            key={`${qcLanguage}-${cue.id}`}
            className={`maghrabi-subtitle-cue${status?.errors ? ' has-error' : status?.warnings ? ' has-warning' : ' is-clean'}${timingDraft?.cueId === cue.id ? ' is-editing' : ''}${isBusy ? ' is-saving' : ''}`}
            style={{ left: `${cue.start * zoom}px`, width: `${width}px` }}
            title={`${cue.id} · ${formatTc(cue.start)} → ${formatTc(cue.end)} · ${cue.text}`}
            data-maghrabi-subtitle-cue={cue.id}
          >
            <span className="maghrabi-subtitle-trim is-left" onPointerDown={(event) => beginGesture(event, cue, 'trim-left')} />
            <span className="maghrabi-subtitle-cue-body" onPointerDown={(event) => beginGesture(event, cue, 'move')}>
              <b>{cue.text}</b>
              <small>{formatTc(cue.start)} · {(cue.end - cue.start).toFixed(2)}s</small>
            </span>
            <span className="maghrabi-subtitle-trim is-right" onPointerDown={(event) => beginGesture(event, cue, 'trim-right')} />
          </div>
        })}
        {!cues.length ? <div className="maghrabi-subtitle-track-empty">NO CAPTION CUES</div> : null}
      </div>
    </div>,
    timelineHost,
  ) : null

  const liveOverlay = programHost && transcript?.captionsEnabled && liveCue ? createPortal(
    <div className={`maghrabi-subtitle-qc-live-layer is-${transcript.captionPosition || 'bottom'} preset-${transcript.captionPreset || 'broadcast'}`} aria-hidden="true">
      <div
        className="maghrabi-subtitle-qc-live-card"
        dir={rtlLanguage(liveLanguage === 'source' ? transcript.language : liveLanguage) ? 'rtl' : 'auto'}
        style={{
          '--maghrabi-subtitle-size': `${clampNumber(transcript.captionSize || 38, 18, 84)}px`,
          '--maghrabi-subtitle-opacity': String(clampNumber(transcript.captionBoxOpacity ?? .48, 0, 1)),
          '--maghrabi-subtitle-color': transcript.captionColor || '#ffffff',
        } as CSSProperties}
      >
        {transcript.captionSpeakerLabels && liveCue.speaker ? <span className="maghrabi-subtitle-qc-speaker">{liveCue.speaker}:</span> : null}
        <span className="maghrabi-subtitle-qc-words">
          {liveCue.words?.length ? liveCue.words.map((word, index) => <span key={word.id} className={index === sourceWordHighlight(liveCue, clock) ? 'is-current' : ''}>{word.text}</span>) : liveCue.text.split(/\s+/).filter(Boolean).map((token, index, tokens) => {
            const progress = clampNumber((clock - liveCue.start) / Math.max(MIN_CUE_DURATION, liveCue.end - liveCue.start), 0, .9999)
            return <span key={`${liveCue.id}-${index}`} className={index === Math.floor(progress * tokens.length) ? 'is-current' : ''}>{token}</span>
          })}
        </span>
      </div>
    </div>,
    programHost,
  ) : null

  const safeOverlay = programHost && safeAreas ? createPortal(
    <div className="maghrabi-subtitle-safe-overlay" aria-hidden="true">
      <div className="is-action-safe"><span>ACTION SAFE 90%</span></div>
      <div className="is-title-safe"><span>TITLE / SUBTITLE SAFE 80%</span></div>
    </div>,
    programHost,
  ) : null

  const drawer = drawerOpen ? createPortal(
    <div className="maghrabi-subtitle-qc-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setDrawerOpen(false) }}>
      <section className="maghrabi-subtitle-qc-drawer" dir="rtl" aria-label="Professional Subtitle Timeline and QC">
        <header>
          <div>
            <div className="maghrabi-subtitle-qc-kicker"><ShieldCheck className="h-4 w-4" /> PROFESSIONAL SUBTITLE TIMELINE & QC</div>
            <h2>Subtitle Timing · Readability · Safe Areas · Delivery</h2>
            <p>Frame-accurate cue editing at {SUBTITLE_FPS}fps with CPS/CPL checks, graphic-collision warnings and multilingual SRT/VTT delivery.</p>
          </div>
          <button type="button" className="maghrabi-subtitle-qc-close" onClick={() => setDrawerOpen(false)}><X className="h-4 w-4" /></button>
        </header>

        {!transcript ? <div className="maghrabi-subtitle-qc-empty"><Captions className="h-7 w-7" /><strong>لا توجد Captions جاهزة للفحص</strong></div> : <>
          <div className="maghrabi-subtitle-qc-toolbar">
            <label>Transcript Track<select value={target?.id || ''} onChange={(event) => { setTargetId(event.target.value); setQcLanguage('source') }}>{transcriptTracks.map((track) => <option key={track.id} value={track.id}>{track.lane} · {track.name || `Audio ${track.fileIndex + 1}`}</option>)}</select></label>
            <label>QC Language<select value={qcLanguage} onChange={(event) => setQcLanguage(event.target.value)}>{availableLanguages.map((language) => <option key={language} value={language}>{activeLanguageLabel(transcript, language)}</option>)}</select></label>
            <button type="button" className={safeAreas ? 'is-on' : ''} onClick={() => setSafeAreas((value) => !value)}><ShieldCheck className="h-3.5 w-3.5" />SAFE AREAS</button>
            {transcript.captionManualCues?.length ? <button type="button" disabled={Boolean(busyCueId)} onClick={() => void resetSourceTiming()}><RotateCcw className="h-3.5 w-3.5" />RESET WORD-SYNC</button> : null}
          </div>

          <div className="maghrabi-subtitle-qc-scorecards">
            <div><Captions className="h-4 w-4" /><span>CUES</span><strong>{cues.length}</strong><small>{qcLanguage === 'source' && transcript.captionManualCues?.length ? 'MANUAL TIMING' : qcLanguage === 'source' ? 'WORD-SYNC' : 'TRANSLATED TRACK'}</small></div>
            <div className={report?.errors ? 'is-error' : 'is-pass'}>{report?.errors ? <AlertTriangle className="h-4 w-4" /> : <BadgeCheck className="h-4 w-4" />}<span>ERRORS</span><strong>{report?.errors || 0}</strong><small>{report?.errors ? 'FIX BEFORE DELIVERY' : 'NO BLOCKING ERRORS'}</small></div>
            <div className={report?.warnings ? 'is-warning' : 'is-pass'}><Gauge className="h-4 w-4" /><span>WARNINGS</span><strong>{report?.warnings || 0}</strong><small>{report?.graphicConflicts || 0} GRAPHIC CONFLICTS</small></div>
            <div><Gauge className="h-4 w-4" /><span>READABILITY</span><strong>{(report?.averageCps || 0).toFixed(1)} CPS</strong><small>MAX {report?.maxCpl || 0} CPL</small></div>
          </div>

          <div className="maghrabi-subtitle-qc-grid">
            <div className="maghrabi-subtitle-qc-panel">
              <div className="maghrabi-subtitle-qc-panel-head"><div><strong>QC Findings</strong><span>Errors block professional delivery; warnings require editorial review.</span></div></div>
              <div className="maghrabi-subtitle-qc-findings">
                {report?.issues.length ? report.issues.map((issue, index) => <button type="button" key={`${issue.cueId}-${issue.code}-${index}`} className={`is-${issue.severity}`} onClick={() => seekTimeline(issue.start)}>
                  <span>{issue.severity === 'error' ? <AlertTriangle className="h-4 w-4" /> : <Gauge className="h-4 w-4" />}</span>
                  <div><strong>{issue.code} · {issue.cueId}</strong><p>{issue.message}</p></div>
                  <code>{formatTc(issue.start)}</code>
                </button>) : <div className="maghrabi-subtitle-qc-pass"><BadgeCheck className="h-6 w-6" /><strong>QC PASS</strong><span>لا توجد أخطاء أو تحذيرات وفق معايير القراءة والتداخل الحالية.</span></div>}
              </div>
            </div>

            <div className="maghrabi-subtitle-qc-panel">
              <div className="maghrabi-subtitle-qc-panel-head"><div><strong>Delivery</strong><span>تصدير Subtitle Tracks مستقلة مع الحفاظ على التوقيت الحالي.</span></div></div>
              <div className="maghrabi-subtitle-delivery-actions">
                <button type="button" disabled={!cues.length} onClick={() => exportLanguage(qcLanguage, 'srt')}><Download className="h-4 w-4" /><span><strong>EXPORT SRT</strong><small>{activeLanguageLabel(transcript, qcLanguage)}</small></span></button>
                <button type="button" disabled={!cues.length} onClick={() => exportLanguage(qcLanguage, 'vtt')}><Download className="h-4 w-4" /><span><strong>EXPORT VTT</strong><small>{activeLanguageLabel(transcript, qcLanguage)}</small></span></button>
                <button type="button" disabled={!availableLanguages.length} onClick={() => exportAll('srt')}><Download className="h-4 w-4" /><span><strong>ALL LANGUAGES · SRT</strong><small>{availableLanguages.length} TRACKS</small></span></button>
                <button type="button" disabled={!availableLanguages.length} onClick={() => exportAll('vtt')}><Download className="h-4 w-4" /><span><strong>ALL LANGUAGES · VTT</strong><small>{availableLanguages.length} TRACKS</small></span></button>
              </div>
              <div className="maghrabi-subtitle-qc-standards">
                <div><b>≤ 20 CPS</b><span>Target reading speed</span></div>
                <div><b>≤ 42 CPL</b><span>Preferred line length</span></div>
                <div><b>≥ 0.80s</b><span>Preferred cue duration</span></div>
                <div><b>2 FRAMES</b><span>Preferred inter-cue gap</span></div>
              </div>
              <p className="maghrabi-subtitle-qc-hint">اسحب جسم الـCaption على مسار SUB لتحريكه. اسحب الحافة اليمنى أو اليسرى للـTrim. يتم التثبيت على الإطارات ومغنطة الحدود القريبة؛ اضغط Alt لتعطيل Snap أثناء السحب.</p>
            </div>
          </div>
        </>}
        {message ? <div className="maghrabi-subtitle-qc-toast">{message}</div> : null}
      </section>
    </div>,
    document.body,
  ) : null

  return <>{timelineTrack}{liveOverlay}{safeOverlay}{drawer}</>
}
