import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Captions, Check, Languages, PencilLine, Save, Sparkles, Type, X } from 'lucide-react'
import { getActiveStudioProjectId } from './lib/projectHubStore'
import { loadStoredVideoProject, saveStoredVideoProject, type StoredVideoProject } from './lib/projectStore'
import { translateTranscriptCaptions } from './lib/transcriptApi'
import './studioTranscriptFinishingPro.css'

type CaptionPosition = 'top' | 'center' | 'bottom'
type CaptionPreset = 'broadcast' | 'social' | 'cinema' | 'minimal' | 'karaoke' | 'custom'
type FinishingTab = 'corrections' | 'captions' | 'translation'

type TranscriptWord = {
  id: string
  text: string
  start: number
  end: number
  timelineStart: number
  timelineEnd: number
  speaker?: string | null
  deleted?: boolean
}

type TranslationCue = {
  id: string
  start: number
  end: number
  text: string
  speaker?: string | null
}

type TranslationPack = {
  language: string
  label: string
  generatedAt: string
  provider?: string
  model?: string
  sourceLanguage?: string | null
  cues: TranslationCue[]
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
  captionPosition: CaptionPosition
  captionColor: string
  captionBoxOpacity: number
  captionMaxWords: number
  captionMaxDuration: number
  captionBreakGap: number
  captionSpeakerLabels: boolean
  captionPreset?: CaptionPreset
  captionLanguage?: string
  captionTranslations?: Record<string, TranslationPack>
}

type TimelineAudio = {
  id: string
  lane: 'A1' | 'A2' | 'A3'
  name?: string
  fileIndex: number
  dialogueTranscript?: TranscriptDocument
  [key: string]: unknown
}

type ProjectShape = {
  audioTracks?: TimelineAudio[]
  [key: string]: unknown
}

type CaptionGroup = {
  id: string
  start: number
  end: number
  text: string
  speaker?: string | null
  words?: TranscriptWord[]
  translated?: boolean
}

type StyleDraft = {
  size: number
  position: CaptionPosition
  color: string
  boxOpacity: number
  maxWords: number
  maxDuration: number
  breakGap: number
  speakerLabels: boolean
}

type PresetDefinition = StyleDraft & {
  id: Exclude<CaptionPreset, 'custom'>
  label: string
  description: string
}

const PRESETS: PresetDefinition[] = [
  { id: 'broadcast', label: 'BROADCAST', description: 'Balanced broadcast readability', size: 38, position: 'bottom', color: '#ffffff', boxOpacity: .5, maxWords: 7, maxDuration: 3.2, breakGap: .65, speakerLabels: true },
  { id: 'social', label: 'SOCIAL', description: 'Fast, compact vertical/social captions', size: 46, position: 'bottom', color: '#ffffff', boxOpacity: .7, maxWords: 4, maxDuration: 2.2, breakGap: .45, speakerLabels: false },
  { id: 'cinema', label: 'CINEMA', description: 'Longer cinematic reading cadence', size: 34, position: 'bottom', color: '#ffffff', boxOpacity: .34, maxWords: 9, maxDuration: 4.0, breakGap: .8, speakerLabels: false },
  { id: 'minimal', label: 'MINIMAL', description: 'Low visual weight, clean lower third', size: 32, position: 'bottom', color: '#ffffff', boxOpacity: .14, maxWords: 8, maxDuration: 3.5, breakGap: .72, speakerLabels: false },
  { id: 'karaoke', label: 'KARAOKE', description: 'Short phrases with active word emphasis', size: 44, position: 'bottom', color: '#ffffff', boxOpacity: .58, maxWords: 5, maxDuration: 2.4, breakGap: .5, speakerLabels: false },
]

const LANGUAGES = [
  { code: 'ar', label: 'Arabic · العربية' },
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'French · Français' },
  { code: 'es', label: 'Spanish · Español' },
  { code: 'de', label: 'German · Deutsch' },
  { code: 'tr', label: 'Turkish · Türkçe' },
  { code: 'ur', label: 'Urdu · اردو' },
]

const HEADER_WIDTH = 122

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function formatTime(seconds: number) {
  const safe = Math.max(0, seconds)
  const total = Math.floor(safe * 1000)
  const ms = total % 1000
  const whole = Math.floor(total / 1000)
  const ss = whole % 60
  const mm = Math.floor(whole / 60) % 60
  const hh = Math.floor(whole / 3600)
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
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

function sourceCaptionGroups(document: TranscriptDocument): CaptionGroup[] {
  const words = [...(document.words || [])]
    .filter((word) => !word.deleted && word.text.trim())
    .sort((a, b) => a.timelineStart - b.timelineStart || a.timelineEnd - b.timelineEnd)
  const groups: CaptionGroup[] = []
  let current: TranscriptWord[] = []

  const flush = () => {
    if (!current.length) return
    const speaker = current[0].speaker || null
    groups.push({
      id: `c${groups.length + 1}`,
      start: current[0].timelineStart,
      end: Math.max(current.at(-1)!.timelineEnd, current[0].timelineStart + .12),
      text: current.map((word) => word.text).join(' '),
      speaker,
      words: [...current],
      translated: false,
    })
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

function activeCaptionGroups(document: TranscriptDocument): CaptionGroup[] {
  const language = document.captionLanguage || 'source'
  const pack = language !== 'source' ? document.captionTranslations?.[language] : null
  if (pack?.cues?.length) {
    return pack.cues
      .filter((cue) => cue.text.trim() && cue.end > cue.start)
      .map((cue) => ({ ...cue, translated: true }))
      .sort((a, b) => a.start - b.start || a.end - b.end)
  }
  return sourceCaptionGroups(document)
}

function styleFromTranscript(document: TranscriptDocument): StyleDraft {
  return {
    size: clamp(Number(document.captionSize || 38), 18, 84),
    position: ['top', 'center', 'bottom'].includes(document.captionPosition) ? document.captionPosition : 'bottom',
    color: /^#[0-9a-f]{6}$/i.test(document.captionColor || '') ? document.captionColor : '#ffffff',
    boxOpacity: clamp(Number(document.captionBoxOpacity ?? .48), 0, 1),
    maxWords: Math.round(clamp(Number(document.captionMaxWords || 7), 2, 12)),
    maxDuration: clamp(Number(document.captionMaxDuration || 3.2), 1, 6),
    breakGap: clamp(Number(document.captionBreakGap || .65), .1, 1.5),
    speakerLabels: Boolean(document.captionSpeakerLabels),
  }
}

function rtlLanguage(language: string | null | undefined) {
  return ['ar', 'ur', 'fa', 'he'].includes((language || '').toLowerCase())
}

function readFrameClock() {
  const value = Number(document.documentElement.dataset.maghrabiFrameClockTime)
  if (Number.isFinite(value)) return Math.max(0, value)
  const playhead = document.querySelector<HTMLElement>('.maghrabi-playhead')
  const ruler = document.querySelector<HTMLElement>('.maghrabi-time-ruler')?.parentElement
  if (!playhead || !ruler) return 0
  const zoomSpan = Array.from(document.querySelectorAll<HTMLSpanElement>('.maghrabi-studio-pro main span')).find((span) => /px\/s/i.test(span.textContent || ''))
  const zoom = Math.max(1, Number((zoomSpan?.textContent || '').match(/([\d.]+)\s*px\/s/i)?.[1]) || 12)
  const rulerRect = ruler.getBoundingClientRect()
  const headRect = playhead.getBoundingClientRect()
  return Math.max(0, (headRect.left + headRect.width / 2 - rulerRect.left - HEADER_WIDTH) / zoom)
}

function languageLabel(code: string) {
  return LANGUAGES.find((item) => item.code === code)?.label || code.toUpperCase()
}

export default function StudioTranscriptFinishingPro() {
  const [launcherHost, setLauncherHost] = useState<HTMLElement | null>(null)
  const [overlayHost, setOverlayHost] = useState<HTMLElement | null>(null)
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<FinishingTab>('corrections')
  const [snapshot, setSnapshot] = useState<StoredVideoProject<ProjectShape> | null>(null)
  const [targetId, setTargetId] = useState('')
  const [clock, setClock] = useState(() => readFrameClock())
  const [search, setSearch] = useState('')
  const [draftWords, setDraftWords] = useState<Record<string, string>>({})
  const [draftSpeakers, setDraftSpeakers] = useState<Record<string, string>>({})
  const [styleDraft, setStyleDraft] = useState<StyleDraft>({ size: 38, position: 'bottom', color: '#ffffff', boxOpacity: .48, maxWords: 7, maxDuration: 3.2, breakGap: .65, speakerLabels: false })
  const [targetLanguage, setTargetLanguage] = useState('en')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const tracks = snapshot?.project.audioTracks || []
  const transcriptTracks = useMemo(() => tracks.filter((track) => track.dialogueTranscript), [tracks])
  const target = useMemo(() => transcriptTracks.find((track) => track.id === targetId) || transcriptTracks[0] || null, [transcriptTracks, targetId])
  const transcript = target?.dialogueTranscript || null
  const sourceGroups = useMemo(() => transcript ? sourceCaptionGroups(transcript) : [], [transcript])
  const groups = useMemo(() => transcript ? activeCaptionGroups(transcript) : [], [transcript])
  const activeGroup = useMemo(() => groups.find((group) => clock >= group.start - .015 && clock <= group.end + .015) || null, [groups, clock])
  const translations = useMemo(() => Object.values(transcript?.captionTranslations || {}).sort((a, b) => a.label.localeCompare(b.label)), [transcript])
  const visibleWords = useMemo(() => {
    if (!transcript) return []
    const query = search.trim().toLocaleLowerCase()
    return transcript.words.filter((word) => !query || word.text.toLocaleLowerCase().includes(query) || (word.speaker || '').toLocaleLowerCase().includes(query)).slice(0, 220)
  }, [transcript, search])

  const announce = (text: string) => {
    setMessage(text)
    window.setTimeout(() => setMessage((current) => current === text ? '' : current), 4200)
  }

  const reload = async (preferredId?: string) => {
    const projectId = getActiveStudioProjectId()
    if (!projectId) {
      setSnapshot(null)
      setTargetId('')
      return
    }
    const next = await loadStoredVideoProject<ProjectShape>(projectId).catch(() => null)
    setSnapshot(next)
    const nextTracks = (next?.project.audioTracks || []).filter((track) => track.dialogueTranscript)
    const preferred = nextTracks.find((track) => track.id === (preferredId || targetId)) || nextTracks[0]
    setTargetId(preferred?.id || '')
  }

  const persistDocument = async (mutator: (document: TranscriptDocument) => TranscriptDocument, success: string) => {
    const projectId = getActiveStudioProjectId()
    if (!projectId || !target || !transcript) return
    setBusy(true)
    try {
      const current = await flushEditorSave(projectId)
      if (!current) throw new Error('تعذر قراءة المشروع الحالي.')
      const project = JSON.parse(JSON.stringify(current.project || {})) as ProjectShape
      const currentTrack = (project.audioTracks || []).find((track) => track.id === target.id)
      const currentDocument = currentTrack?.dialogueTranscript
      if (!currentDocument) throw new Error('Transcript المحدد لم يعد موجودًا.')
      const nextDocument = mutator(currentDocument)
      project.audioTracks = (project.audioTracks || []).map((track) => track.dialogueTranscript?.id === currentDocument.id ? { ...track, dialogueTranscript: nextDocument } : track)
      await saveStoredVideoProject({ ...current, project, savedAt: new Date().toISOString() }, projectId)
      window.setTimeout(clickRestore, 70)
      await reload(target.id)
      announce(success)
    } catch (error) {
      announce(error instanceof Error ? error.message : 'تعذر حفظ تعديلات Transcript Finishing.')
    } finally {
      setBusy(false)
    }
  }

  const saveCorrections = async () => {
    if (!transcript) return
    await persistDocument((document) => {
      const words = document.words.map((word) => ({
        ...word,
        text: (draftWords[word.id] ?? word.text).trim() || word.text,
        speaker: (draftSpeakers[word.id] ?? word.speaker ?? '').trim() || null,
      }))
      return { ...document, text: words.filter((word) => !word.deleted).map((word) => word.text).join(' '), words }
    }, 'تم حفظ التصحيحات النصية مع الحفاظ على جميع الـTimecodes دون تغيير.')
  }

  const applyPreset = async (preset: PresetDefinition) => {
    await persistDocument((document) => ({
      ...document,
      captionsEnabled: true,
      captionPreset: preset.id,
      captionSize: preset.size,
      captionPosition: preset.position,
      captionColor: preset.color,
      captionBoxOpacity: preset.boxOpacity,
      captionMaxWords: preset.maxWords,
      captionMaxDuration: preset.maxDuration,
      captionBreakGap: preset.breakGap,
      captionSpeakerLabels: preset.speakerLabels,
    }), `تم تطبيق ${preset.label} Caption Preset.`)
  }

  const applyCustomStyle = async () => {
    await persistDocument((document) => ({
      ...document,
      captionsEnabled: true,
      captionPreset: 'custom',
      captionSize: Math.round(clamp(styleDraft.size, 18, 84)),
      captionPosition: styleDraft.position,
      captionColor: styleDraft.color,
      captionBoxOpacity: clamp(styleDraft.boxOpacity, 0, 1),
      captionMaxWords: Math.round(clamp(styleDraft.maxWords, 2, 12)),
      captionMaxDuration: clamp(styleDraft.maxDuration, 1, 6),
      captionBreakGap: clamp(styleDraft.breakGap, .1, 1.5),
      captionSpeakerLabels: styleDraft.speakerLabels,
    }), 'تم تطبيق إعدادات Caption المخصصة على المعاينة والـRender.')
  }

  const toggleCaptions = async () => {
    await persistDocument((document) => ({ ...document, captionsEnabled: !document.captionsEnabled }), transcript?.captionsEnabled ? 'تم إيقاف Captions.' : 'تم تفعيل Captions.')
  }

  const selectCaptionLanguage = async (language: string) => {
    await persistDocument((document) => ({ ...document, captionLanguage: language, captionsEnabled: true }), language === 'source' ? 'تم اعتماد لغة Transcript الأصلية للـCaptions.' : `تم اعتماد ${languageLabel(language)} للـCaptions.`)
  }

  const translate = async () => {
    if (!transcript || !sourceGroups.length) return
    const targetMeta = LANGUAGES.find((item) => item.code === targetLanguage) || { code: targetLanguage, label: targetLanguage }
    setBusy(true)
    try {
      const result = await translateTranscriptCaptions(
        sourceGroups.map((group) => ({ id: group.id, text: group.text })),
        { targetLanguage: targetMeta.label, sourceLanguage: transcript.language || null },
      )
      const translated = new Map(result.translations.map((item) => [item.id, item.text]))
      await persistDocument((document) => {
        const liveSource = sourceCaptionGroups(document)
        const cues: TranslationCue[] = liveSource.map((group) => ({
          id: group.id,
          start: group.start,
          end: group.end,
          text: translated.get(group.id) || group.text,
          speaker: group.speaker || null,
        }))
        const pack: TranslationPack = {
          language: targetMeta.code,
          label: targetMeta.label,
          generatedAt: new Date().toISOString(),
          provider: result.provider,
          model: result.model,
          sourceLanguage: document.language || null,
          cues,
        }
        return {
          ...document,
          captionsEnabled: true,
          captionLanguage: targetMeta.code,
          captionTranslations: { ...(document.captionTranslations || {}), [targetMeta.code]: pack },
        }
      }, `اكتملت ترجمة ${sourceGroups.length} Caption إلى ${targetMeta.label}.`)
    } catch (error) {
      announce(error instanceof Error ? error.message : 'تعذر ترجمة Captions.')
      setBusy(false)
    }
  }

  useEffect(() => {
    let disposed = false
    const refreshHosts = () => {
      if (disposed) return
      setLauncherHost(programPanel())
      const host = programVideoHost()
      if (host) host.classList.add('maghrabi-caption-finish-host')
      setOverlayHost(host)
    }
    const observer = new MutationObserver(refreshHosts)
    observer.observe(document.body, { childList: true, subtree: true })
    refreshHosts()
    void reload()

    const onSnapshot = () => void reload()
    const onProject = () => { setOpen(false); void reload() }
    const onClock = (event: Event) => {
      const detail = (event as CustomEvent<{ time?: number }>).detail
      const time = Number(detail?.time)
      if (Number.isFinite(time)) setClock(Math.max(0, time))
    }
    const idle = window.setInterval(() => {
      const next = readFrameClock()
      setClock((current) => Math.abs(current - next) > .0005 ? next : current)
    }, 120)

    window.addEventListener('maghrabi-project-snapshot-changed', onSnapshot)
    window.addEventListener('maghrabi-active-project-changed', onProject)
    window.addEventListener('maghrabi-frame-clock', onClock as EventListener)
    return () => {
      disposed = true
      observer.disconnect()
      window.clearInterval(idle)
      window.removeEventListener('maghrabi-project-snapshot-changed', onSnapshot)
      window.removeEventListener('maghrabi-active-project-changed', onProject)
      window.removeEventListener('maghrabi-frame-clock', onClock as EventListener)
      overlayHost?.classList.remove('maghrabi-caption-finish-host')
    }
  }, [])

  useEffect(() => {
    if (!transcript) {
      setDraftWords({})
      setDraftSpeakers({})
      return
    }
    setDraftWords(Object.fromEntries(transcript.words.map((word) => [word.id, word.text])))
    setDraftSpeakers(Object.fromEntries(transcript.words.map((word) => [word.id, word.speaker || ''])))
    setStyleDraft(styleFromTranscript(transcript))
    const source = transcript.language || 'ar'
    if (targetLanguage === source) setTargetLanguage(source === 'en' ? 'ar' : 'en')
  }, [transcript?.id, transcript?.generatedAt, transcript?.captionPreset, transcript?.captionLanguage])

  const launcher = launcherHost ? createPortal(
    <button type="button" className="maghrabi-caption-finish-launcher" onClick={() => setOpen(true)}>
      <Sparkles className="h-3.5 w-3.5" /> CAPTION FINISH
      {transcript?.captionsEnabled ? <span>LIVE</span> : null}
    </button>,
    launcherHost,
  ) : null

  const overlay = overlayHost && transcript?.captionsEnabled && activeGroup ? createPortal(
    <div className={`maghrabi-caption-live-layer is-${transcript.captionPosition || 'bottom'} preset-${transcript.captionPreset || 'broadcast'}`} aria-hidden="true">
      <div
        className="maghrabi-caption-live-card"
        dir={rtlLanguage(transcript.captionLanguage === 'source' ? transcript.language : transcript.captionLanguage) ? 'rtl' : 'auto'}
        style={{
          '--maghrabi-caption-size': `${clamp(transcript.captionSize || 38, 18, 84)}px`,
          '--maghrabi-caption-box-opacity': String(clamp(transcript.captionBoxOpacity ?? .48, 0, 1)),
          '--maghrabi-caption-color': transcript.captionColor || '#ffffff',
        } as CSSProperties}
      >
        {transcript.captionSpeakerLabels && activeGroup.speaker ? <span className="maghrabi-caption-speaker">{activeGroup.speaker}:</span> : null}
        <span className="maghrabi-caption-live-words">
          {activeGroup.words?.length ? activeGroup.words.map((word) => {
            const active = clock >= word.timelineStart - .01 && clock <= word.timelineEnd + .01
            return <span key={word.id} className={active ? 'is-current' : ''}>{word.text}</span>
          }) : activeGroup.text.split(/\s+/).filter(Boolean).map((token, index, tokens) => {
            const progress = clamp((clock - activeGroup.start) / Math.max(.08, activeGroup.end - activeGroup.start), 0, .9999)
            const current = Math.floor(progress * tokens.length)
            return <span key={`${activeGroup.id}-${index}`} className={index === current ? 'is-current' : ''}>{token}</span>
          })}
        </span>
      </div>
    </div>,
    overlayHost,
  ) : null

  const drawer = open ? createPortal(
    <div className="maghrabi-caption-finish-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false) }}>
      <section className="maghrabi-caption-finish-drawer" dir="rtl" aria-label="Transcript finishing workspace">
        <header>
          <div>
            <div className="maghrabi-caption-finish-kicker"><Sparkles className="h-3.5 w-3.5" /> TRANSCRIPT FINISHING PRO</div>
            <h2>Caption Finishing & Multilingual Delivery</h2>
            <p>Text correction · Burn-in Preview · Live Word Highlight · Presets · Translation Tracks</p>
          </div>
          <button type="button" className="maghrabi-caption-finish-close" onClick={() => setOpen(false)}><X className="h-4 w-4" /></button>
        </header>

        <div className="maghrabi-caption-finish-source">
          <label>Transcript Track
            <select value={target?.id || ''} onChange={(event) => setTargetId(event.target.value)}>
              {transcriptTracks.map((track) => <option key={track.id} value={track.id}>{track.lane} · {track.name || `Audio ${track.fileIndex + 1}`} · {track.dialogueTranscript?.words.length || 0} WORDS</option>)}
            </select>
          </label>
          <button type="button" className={transcript?.captionsEnabled ? 'is-on' : ''} disabled={!transcript || busy} onClick={() => void toggleCaptions()}>
            <Captions className="h-3.5 w-3.5" /> {transcript?.captionsEnabled ? 'CAPTIONS ON' : 'CAPTIONS OFF'}
          </button>
        </div>

        <nav className="maghrabi-caption-finish-tabs">
          <button type="button" className={tab === 'corrections' ? 'is-active' : ''} onClick={() => setTab('corrections')}><PencilLine className="h-3.5 w-3.5" />Corrections</button>
          <button type="button" className={tab === 'captions' ? 'is-active' : ''} onClick={() => setTab('captions')}><Type className="h-3.5 w-3.5" />Caption Style</button>
          <button type="button" className={tab === 'translation' ? 'is-active' : ''} onClick={() => setTab('translation')}><Languages className="h-3.5 w-3.5" />Translations</button>
        </nav>

        {!transcript ? <div className="maghrabi-caption-finish-empty"><Captions className="h-6 w-6" /><strong>لا يوجد Transcript جاهز</strong><span>أنشئ Transcript أولًا من TRANSCRIPT PRO ثم عد إلى مرحلة Finishing.</span></div> : null}

        {transcript && tab === 'corrections' ? <div className="maghrabi-caption-finish-panel">
          <div className="maghrabi-caption-finish-panel-head"><div><strong>Non-Destructive Text Correction</strong><span>تعديل الكلمات وأسماء المتحدثين فقط؛ الـTimecodes لا تتغير.</span></div><button type="button" disabled={busy} onClick={() => void saveCorrections()}><Save className="h-3.5 w-3.5" />SAVE CORRECTIONS</button></div>
          <input className="maghrabi-caption-finish-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ابحث عن كلمة أو Speaker…" />
          <div className="maghrabi-caption-finish-wordlist">
            {visibleWords.map((word) => <div key={word.id} className="maghrabi-caption-finish-wordrow">
              <code>{formatTime(word.timelineStart)}</code>
              <input value={draftWords[word.id] ?? word.text} onChange={(event) => setDraftWords((current) => ({ ...current, [word.id]: event.target.value }))} aria-label={`Text at ${formatTime(word.timelineStart)}`} />
              <input className="is-speaker" value={draftSpeakers[word.id] ?? word.speaker ?? ''} onChange={(event) => setDraftSpeakers((current) => ({ ...current, [word.id]: event.target.value }))} placeholder="Speaker" aria-label="Speaker label" />
            </div>)}
          </div>
          {transcript.words.length > 220 && !search ? <small className="maghrabi-caption-finish-note">يعرض المحرر أول 220 كلمة للأداء. استخدم البحث للوصول إلى أي كلمة أخرى.</small> : null}
        </div> : null}

        {transcript && tab === 'captions' ? <div className="maghrabi-caption-finish-panel">
          <div className="maghrabi-caption-finish-panel-head"><div><strong>Professional Caption Presets</strong><span>المعاينة الحية تستخدم نفس تقسيم النص والزمن المعتمد في Render.</span></div></div>
          <div className="maghrabi-caption-preset-grid">
            {PRESETS.map((preset) => <button key={preset.id} type="button" className={transcript.captionPreset === preset.id ? 'is-active' : ''} disabled={busy} onClick={() => void applyPreset(preset)}><strong>{preset.label}</strong><span>{preset.description}</span></button>)}
          </div>
          <div className="maghrabi-caption-style-grid">
            <label>Size <b>{styleDraft.size}px</b><input type="range" min="18" max="84" step="1" value={styleDraft.size} onChange={(event) => setStyleDraft((current) => ({ ...current, size: Number(event.target.value) }))} /></label>
            <label>Position<select value={styleDraft.position} onChange={(event) => setStyleDraft((current) => ({ ...current, position: event.target.value as CaptionPosition }))}><option value="top">Top</option><option value="center">Center</option><option value="bottom">Bottom</option></select></label>
            <label>Text Color<input type="color" value={styleDraft.color} onChange={(event) => setStyleDraft((current) => ({ ...current, color: event.target.value }))} /></label>
            <label>Box Opacity <b>{Math.round(styleDraft.boxOpacity * 100)}%</b><input type="range" min="0" max="1" step="0.02" value={styleDraft.boxOpacity} onChange={(event) => setStyleDraft((current) => ({ ...current, boxOpacity: Number(event.target.value) }))} /></label>
            <label>Max Words <b>{styleDraft.maxWords}</b><input type="range" min="2" max="12" step="1" value={styleDraft.maxWords} onChange={(event) => setStyleDraft((current) => ({ ...current, maxWords: Number(event.target.value) }))} /></label>
            <label>Max Duration <b>{styleDraft.maxDuration.toFixed(1)}s</b><input type="range" min="1" max="6" step="0.1" value={styleDraft.maxDuration} onChange={(event) => setStyleDraft((current) => ({ ...current, maxDuration: Number(event.target.value) }))} /></label>
            <label>Break Gap <b>{styleDraft.breakGap.toFixed(2)}s</b><input type="range" min="0.1" max="1.5" step="0.05" value={styleDraft.breakGap} onChange={(event) => setStyleDraft((current) => ({ ...current, breakGap: Number(event.target.value) }))} /></label>
            <label className="maghrabi-caption-style-check"><input type="checkbox" checked={styleDraft.speakerLabels} onChange={(event) => setStyleDraft((current) => ({ ...current, speakerLabels: event.target.checked }))} /><span>Speaker Labels</span></label>
          </div>
          <button type="button" className="maghrabi-caption-style-apply" disabled={busy} onClick={() => void applyCustomStyle()}><Check className="h-3.5 w-3.5" />APPLY CUSTOM STYLE</button>
          <div className="maghrabi-caption-finish-preview-note"><span>LIVE PREVIEW</span><strong>{groups.length} caption cues · {transcript.captionLanguage && transcript.captionLanguage !== 'source' ? languageLabel(transcript.captionLanguage) : languageLabel(transcript.language || 'source')}</strong><small>الـProgram Monitor يعرض Burn-in Preview مع تمييز الكلمة الحالية حسب Frame Clock.</small></div>
        </div> : null}

        {transcript && tab === 'translation' ? <div className="maghrabi-caption-finish-panel">
          <div className="maghrabi-caption-finish-panel-head"><div><strong>Multilingual Subtitle Delivery</strong><span>الترجمة تتم على مستوى Caption Cues مع الحفاظ على البداية والنهاية لكل Cue.</span></div></div>
          <div className="maghrabi-caption-translation-create">
            <label>Target Language<select value={targetLanguage} onChange={(event) => setTargetLanguage(event.target.value)}>{LANGUAGES.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}</select></label>
            <button type="button" disabled={busy || !sourceGroups.length} onClick={() => void translate()}><Languages className="h-3.5 w-3.5" />{busy ? 'TRANSLATING…' : `TRANSLATE ${sourceGroups.length} CUES`}</button>
          </div>
          <div className="maghrabi-caption-language-list">
            <button type="button" className={(transcript.captionLanguage || 'source') === 'source' ? 'is-active' : ''} disabled={busy} onClick={() => void selectCaptionLanguage('source')}><span><strong>SOURCE</strong><small>{languageLabel(transcript.language || 'source')} · WORD-SYNC</small></span>{(transcript.captionLanguage || 'source') === 'source' ? <Check className="h-4 w-4" /> : null}</button>
            {translations.map((pack) => <button type="button" key={pack.language} className={transcript.captionLanguage === pack.language ? 'is-active' : ''} disabled={busy} onClick={() => void selectCaptionLanguage(pack.language)}><span><strong>{pack.label}</strong><small>{pack.cues.length} CUES · CUE-SYNC{pack.model ? ` · ${pack.model}` : ''}</small></span>{transcript.captionLanguage === pack.language ? <Check className="h-4 w-4" /> : null}</button>)}
          </div>
          <div className="maghrabi-caption-translation-note"><Sparkles className="h-4 w-4" /><div><strong>Timing safety</strong><span>الترجمة لا تغيّر أي Video/Audio Timecode. عند اختيار لغة مترجمة، يستخدم Render نفس Cue timings المحفوظة.</span></div></div>
        </div> : null}

        {message ? <div className="maghrabi-caption-finish-toast">{message}</div> : null}
      </section>
    </div>,
    document.body,
  ) : null

  return <>{launcher}{overlay}{drawer}</>
}
