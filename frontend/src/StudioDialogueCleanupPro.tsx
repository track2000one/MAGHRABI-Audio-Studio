import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlignCenter, AudioLines, Gauge, RotateCcw, Save, Sparkles, TimerReset } from 'lucide-react'
import { getActiveStudioProjectId } from './lib/projectHubStore'
import { loadStoredVideoProject, saveStoredVideoProject, type StoredVideoProject } from './lib/projectStore'
import './studioDialogueCleanupPro.css'

type AudioLane = 'A1' | 'A2' | 'A3'
type AudioTrack = {
  id: string
  lane: AudioLane
  name?: string
  fileIndex: number
  startAt: number
  sourceStart: number
  sourceEnd: number
  volume: number
  fadeIn: number
  fadeOut: number
  adrGroupId?: string
  adrTakeNumber?: number
  adrTakeActive?: boolean
  adrSourceTake?: boolean
  adrCompSegment?: boolean
  adrPunchIn?: number
  adrPunchOut?: number
  dialogueCleanupEnabled?: boolean
  dialogueTempo?: number
  dialogueNoiseReductionDb?: number
  dialogueHighPassHz?: number
  dialogueDeEss?: number
  dialogueCompressorEnabled?: boolean
  dialogueCompressorThresholdDb?: number
  dialogueCompressorRatio?: number
  dialogueLoudnessMatchEnabled?: boolean
  dialogueTargetLufs?: number
  dialogueRoomToneDb?: number
  dialogueRoomToneAnchor?: 'head' | 'tail'
  dialogueAlignMs?: number
  [key: string]: unknown
}
type ProjectShape = {
  audioTracks?: AudioTrack[]
  trackStates?: Partial<Record<AudioLane, { locked?: boolean }>>
  [key: string]: unknown
}
type FormState = {
  enabled: boolean
  tempo: number
  noiseReductionDb: number
  highPassHz: number
  deEss: number
  compressor: boolean
  compressorThresholdDb: number
  compressorRatio: number
  loudnessMatch: boolean
  targetLufs: number
  roomToneDb: number
  roomToneAnchor: 'head' | 'tail'
  fadeIn: number
  fadeOut: number
}
type Envelope = { values: Float32Array; step: number }

const ROOT = '.maghrabi-studio-pro main'
const MAX_ALIGN_SECONDS = 1.5
const ENVELOPE_STEP = .01
const FRAME_MS = 1000 / 30

const DEFAULT_FORM: FormState = {
  enabled: true,
  tempo: 1,
  noiseReductionDb: 8,
  highPassHz: 75,
  deEss: .32,
  compressor: true,
  compressorThresholdDb: -18,
  compressorRatio: 3,
  loudnessMatch: true,
  targetLufs: -18,
  roomToneDb: -60,
  roomToneAnchor: 'tail',
  fadeIn: .025,
  fadeOut: .04,
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function programPanel() {
  const labels = Array.from(document.querySelectorAll<HTMLElement>(`${ROOT} p`))
  const label = labels.find((item) => (item.textContent || '').trim().toUpperCase() === 'PROGRAM MONITOR')
  return label?.closest<HTMLElement>('div[class*="rounded-3xl"]') || null
}

function editorButtons() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(`${ROOT} button`))
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

function labelFor(track: AudioTrack) {
  if (track.adrCompSegment) return `${track.lane} · COMP · ${track.name || track.id.slice(-5)}`
  if (track.adrSourceTake) return `${track.lane} · ADR T${track.adrTakeNumber || '?'}${track.adrTakeActive ? ' · ACTIVE' : ''}`
  return `${track.lane} · ${track.name || `Audio ${track.fileIndex + 1}`}`
}

function formFromTrack(track: AudioTrack): FormState {
  return {
    enabled: track.dialogueCleanupEnabled ?? DEFAULT_FORM.enabled,
    tempo: clamp(Number(track.dialogueTempo ?? 1), .9, 1.1),
    noiseReductionDb: clamp(Number(track.dialogueNoiseReductionDb ?? DEFAULT_FORM.noiseReductionDb), 0, 24),
    highPassHz: clamp(Number(track.dialogueHighPassHz ?? DEFAULT_FORM.highPassHz), 40, 180),
    deEss: clamp(Number(track.dialogueDeEss ?? DEFAULT_FORM.deEss), 0, 1),
    compressor: track.dialogueCompressorEnabled ?? DEFAULT_FORM.compressor,
    compressorThresholdDb: clamp(Number(track.dialogueCompressorThresholdDb ?? DEFAULT_FORM.compressorThresholdDb), -36, -6),
    compressorRatio: clamp(Number(track.dialogueCompressorRatio ?? DEFAULT_FORM.compressorRatio), 1, 8),
    loudnessMatch: track.dialogueLoudnessMatchEnabled ?? DEFAULT_FORM.loudnessMatch,
    targetLufs: clamp(Number(track.dialogueTargetLufs ?? DEFAULT_FORM.targetLufs), -24, -14),
    roomToneDb: clamp(Number(track.dialogueRoomToneDb ?? DEFAULT_FORM.roomToneDb), -60, -24),
    roomToneAnchor: track.dialogueRoomToneAnchor === 'head' ? 'head' : 'tail',
    fadeIn: clamp(Number(track.fadeIn ?? DEFAULT_FORM.fadeIn), 0, .25),
    fadeOut: clamp(Number(track.fadeOut ?? DEFAULT_FORM.fadeOut), 0, .25),
  }
}

function preset(name: 'clean' | 'adr' | 'broadcast'): FormState {
  if (name === 'clean') return { ...DEFAULT_FORM, noiseReductionDb: 12, highPassHz: 85, deEss: .38, compressorRatio: 2.8, targetLufs: -19, roomToneDb: -60 }
  if (name === 'broadcast') return { ...DEFAULT_FORM, noiseReductionDb: 10, highPassHz: 90, deEss: .48, compressorThresholdDb: -20, compressorRatio: 3.8, targetLufs: -16, roomToneDb: -54, fadeIn: .018, fadeOut: .025 }
  return { ...DEFAULT_FORM, noiseReductionDb: 6, highPassHz: 70, deEss: .28, compressorThresholdDb: -18, compressorRatio: 2.5, targetLufs: -18, roomToneDb: -46, fadeIn: .03, fadeOut: .05 }
}

async function decodeEnvelope(file: Blob, sourceStart: number, sourceEnd: number): Promise<Envelope> {
  const context = new AudioContext()
  try {
    const buffer = await context.decodeAudioData((await file.arrayBuffer()).slice(0))
    const start = clamp(sourceStart, 0, buffer.duration)
    const end = clamp(sourceEnd, start + .02, buffer.duration)
    const count = Math.max(2, Math.floor((end - start) / ENVELOPE_STEP))
    const values = new Float32Array(count)
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index))
    const halfWindow = Math.max(8, Math.floor(buffer.sampleRate * ENVELOPE_STEP * .35))
    for (let index = 0; index < count; index += 1) {
      const center = Math.floor((start + index * ENVELOPE_STEP) * buffer.sampleRate)
      const from = clamp(center - halfWindow, 0, buffer.length - 1)
      const to = clamp(center + halfWindow, from + 1, buffer.length)
      let sum = 0
      let samples = 0
      const stride = Math.max(1, Math.floor((to - from) / 48))
      for (let frame = from; frame < to; frame += stride) {
        let mixed = 0
        for (const channel of channels) mixed += Math.abs(channel[frame] || 0)
        sum += mixed / Math.max(1, channels.length)
        samples += 1
      }
      values[index] = samples ? sum / samples : 0
    }
    return { values, step: ENVELOPE_STEP }
  } finally {
    void context.close().catch(() => undefined)
  }
}

function correlation(target: Float32Array, reference: Float32Array, offset: number) {
  let n = 0
  let sx = 0
  let sy = 0
  let sxx = 0
  let syy = 0
  let sxy = 0
  for (let index = 0; index < target.length; index += 1) {
    const refIndex = index + offset
    if (refIndex < 0 || refIndex >= reference.length) continue
    const x = target[index]
    const y = reference[refIndex]
    sx += x
    sy += y
    sxx += x * x
    syy += y * y
    sxy += x * y
    n += 1
  }
  if (n < 18) return -1
  const covariance = sxy - sx * sy / n
  const vx = sxx - sx * sx / n
  const vy = syy - sy * sy / n
  if (vx <= 1e-8 || vy <= 1e-8) return -1
  return covariance / Math.sqrt(vx * vy)
}

async function estimateAlignment(snapshot: StoredVideoProject<ProjectShape>, target: AudioTrack, reference: AudioTrack) {
  const targetFile = snapshot.audios[target.fileIndex]
  const referenceFile = snapshot.audios[reference.fileIndex]
  if (!(targetFile instanceof Blob) || !(referenceFile instanceof Blob)) throw new Error('تعذر قراءة ملفات المقارنة الصوتية.')

  const targetDuration = Math.max(.02, target.sourceEnd - target.sourceStart)
  const referenceDuration = Math.max(.02, reference.sourceEnd - reference.sourceStart)
  const targetEnd = target.startAt + targetDuration
  const referenceEnd = reference.startAt + referenceDuration
  const windowStart = Math.max(reference.startAt, target.startAt - MAX_ALIGN_SECONDS)
  const windowEnd = Math.min(referenceEnd, targetEnd + MAX_ALIGN_SECONDS)
  if (windowEnd - windowStart < .35) throw new Error('لا يوجد تداخل زمني كافٍ مع Reference Track.')

  const referenceSourceStart = reference.sourceStart + (windowStart - reference.startAt)
  const referenceSourceEnd = reference.sourceStart + (windowEnd - reference.startAt)
  const [targetEnvelope, referenceEnvelope] = await Promise.all([
    decodeEnvelope(targetFile, target.sourceStart, target.sourceEnd),
    decodeEnvelope(referenceFile, referenceSourceStart, referenceSourceEnd),
  ])

  const baseOffset = Math.round((target.startAt - windowStart) / ENVELOPE_STEP)
  const maxLag = Math.round(MAX_ALIGN_SECONDS / ENVELOPE_STEP)
  let bestLagFrames = 0
  let bestScore = -1
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    const score = correlation(targetEnvelope.values, referenceEnvelope.values, baseOffset + lag)
    if (score > bestScore) {
      bestScore = score
      bestLagFrames = lag
    }
  }
  return { seconds: bestLagFrames * ENVELOPE_STEP, score: bestScore }
}

export default function StudioDialogueCleanupPro() {
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [snapshot, setSnapshot] = useState<StoredVideoProject<ProjectShape> | null>(null)
  const [targetId, setTargetId] = useState('')
  const [referenceId, setReferenceId] = useState('')
  const [form, setForm] = useState<FormState>(DEFAULT_FORM)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const tracks = snapshot?.project?.audioTracks || []
  const target = useMemo(() => tracks.find((track) => track.id === targetId) || null, [tracks, targetId])
  const references = useMemo(() => tracks.filter((track) => track.id !== targetId && (!target?.adrGroupId || track.adrGroupId !== target.adrGroupId)), [tracks, targetId, target?.adrGroupId])

  const announce = (text: string) => {
    setMessage(text)
    window.setTimeout(() => setMessage((current) => current === text ? '' : current), 2800)
  }

  const reload = async (preferId?: string) => {
    const projectId = getActiveStudioProjectId()
    if (!projectId) {
      setSnapshot(null)
      return
    }
    const next = await loadStoredVideoProject<ProjectShape>(projectId).catch(() => null)
    setSnapshot(next)
    if (!next) return
    const nextTracks = next.project.audioTracks || []
    const preferred = nextTracks.find((track) => track.id === (preferId || targetId))
      || [...nextTracks].reverse().find((track) => track.adrCompSegment)
      || nextTracks.find((track) => track.adrTakeActive)
      || [...nextTracks].reverse().find((track) => track.adrSourceTake)
      || nextTracks.at(-1)
    if (preferred) {
      setTargetId(preferred.id)
      setForm(formFromTrack(preferred))
      const refs = nextTracks.filter((track) => track.id !== preferred.id && (!preferred.adrGroupId || track.adrGroupId !== preferred.adrGroupId))
      if (!refs.some((track) => track.id === referenceId)) setReferenceId(refs[0]?.id || '')
    }
  }

  const saveTrackMutation = async (mutate: (track: AudioTrack) => void, success: string) => {
    const projectId = getActiveStudioProjectId()
    if (!projectId || !targetId) return
    setBusy(true)
    try {
      const current = await flushEditorSave(projectId)
      if (!current) throw new Error('تعذر قراءة المشروع الحالي.')
      const project = JSON.parse(JSON.stringify(current.project || {})) as ProjectShape
      project.audioTracks = Array.isArray(project.audioTracks) ? project.audioTracks : []
      const track = project.audioTracks.find((item) => item.id === targetId)
      if (!track) throw new Error('المقطع الصوتي المحدد لم يعد موجودًا.')
      if (project.trackStates?.[track.lane]?.locked) throw new Error(`المسار ${track.lane} مقفل.`)
      mutate(track)
      await saveStoredVideoProject({ ...current, project, savedAt: new Date().toISOString() }, projectId)
      window.setTimeout(clickRestore, 70)
      await reload(targetId)
      announce(success)
    } catch (error) {
      announce(error instanceof Error ? error.message : 'تعذر حفظ معالجة الحوار.')
    } finally {
      setBusy(false)
    }
  }

  const applySettings = async () => {
    await saveTrackMutation((track) => {
      track.dialogueCleanupEnabled = form.enabled
      track.dialogueTempo = clamp(form.tempo, .9, 1.1)
      track.dialogueNoiseReductionDb = clamp(form.noiseReductionDb, 0, 24)
      track.dialogueHighPassHz = clamp(form.highPassHz, 40, 180)
      track.dialogueDeEss = clamp(form.deEss, 0, 1)
      track.dialogueCompressorEnabled = form.compressor
      track.dialogueCompressorThresholdDb = clamp(form.compressorThresholdDb, -36, -6)
      track.dialogueCompressorRatio = clamp(form.compressorRatio, 1, 8)
      track.dialogueLoudnessMatchEnabled = form.loudnessMatch
      track.dialogueTargetLufs = clamp(form.targetLufs, -24, -14)
      track.dialogueRoomToneDb = clamp(form.roomToneDb, -60, -24)
      track.dialogueRoomToneAnchor = form.roomToneAnchor
      track.fadeIn = clamp(form.fadeIn, 0, .25)
      track.fadeOut = clamp(form.fadeOut, 0, .25)
    }, 'تم حفظ Dialogue Cleanup على المقطع المحدد؛ ستُطبق المعالجة الفعلية في Render.')
  }

  const nudge = async (milliseconds: number) => {
    await saveTrackMutation((track) => {
      const before = Number(track.startAt) || 0
      const after = Math.max(0, before + milliseconds / 1000)
      track.startAt = after
      track.dialogueAlignMs = Number(track.dialogueAlignMs || 0) + (after - before) * 1000
    }, `تمت إزاحة الحوار ${milliseconds > 0 ? '+' : ''}${milliseconds.toFixed(1)}ms.`)
  }

  const autoAlign = async () => {
    const reference = tracks.find((track) => track.id === referenceId)
    if (!snapshot || !target || !reference) return announce('اختر Reference Track للمزامنة التلقائية.')
    setBusy(true)
    try {
      const estimate = await estimateAlignment(snapshot, target, reference)
      if (estimate.score < .16) throw new Error(`درجة التطابق منخفضة (${estimate.score.toFixed(2)}). استخدم Nudge يدويًا أو Reference أوضح.`)
      const milliseconds = estimate.seconds * 1000
      await saveTrackMutation((track) => {
        const before = Number(track.startAt) || 0
        const after = Math.max(0, before + estimate.seconds)
        track.startAt = after
        track.dialogueAlignMs = Number(track.dialogueAlignMs || 0) + (after - before) * 1000
      }, `AUTO ALIGN ${milliseconds >= 0 ? '+' : ''}${milliseconds.toFixed(0)}ms · confidence ${Math.round(estimate.score * 100)}%`)
    } catch (error) {
      announce(error instanceof Error ? error.message : 'تعذر Auto Align.')
    } finally {
      setBusy(false)
    }
  }

  const fitPunch = () => {
    if (!target) return
    const punch = Math.max(.02, Number(target.adrPunchOut || 0) - Number(target.adrPunchIn || 0))
    const source = Math.max(.02, Number(target.sourceEnd) - Number(target.sourceStart))
    if (!Number.isFinite(punch) || punch <= .02) return announce('هذا المقطع لا يحتوي ADR Punch Range صالحًا.')
    const rawTempo = source / punch
    const tempo = clamp(rawTempo, .9, 1.1)
    setForm((current) => ({ ...current, tempo }))
    if (Math.abs(rawTempo - tempo) > .001) announce(`المطلوب ${rawTempo.toFixed(3)}×؛ تم تقييده إلى ${tempo.toFixed(3)}× للحفاظ على جودة الحوار.`)
    else announce(`TIMING FIT مضبوط على ${tempo.toFixed(3)}× بدون تغيير النبرة.`)
  }

  useEffect(() => {
    const refreshHost = () => setHost(programPanel())
    const observer = new MutationObserver(refreshHost)
    observer.observe(document.body, { childList: true, subtree: true })
    refreshHost()
    void reload()
    const onProject = () => void reload()
    const onSnapshot = () => void reload()
    window.addEventListener('maghrabi-project-active-changed', onProject)
    window.addEventListener('maghrabi-active-project-changed', onProject)
    window.addEventListener('maghrabi-project-snapshot-changed', onSnapshot)
    window.addEventListener('maghrabi-adr-take-added', onSnapshot)
    return () => {
      observer.disconnect()
      window.removeEventListener('maghrabi-project-active-changed', onProject)
      window.removeEventListener('maghrabi-active-project-changed', onProject)
      window.removeEventListener('maghrabi-project-snapshot-changed', onSnapshot)
      window.removeEventListener('maghrabi-adr-take-added', onSnapshot)
    }
  }, [])

  useEffect(() => {
    const next = tracks.find((track) => track.id === targetId)
    if (next) setForm(formFromTrack(next))
  }, [targetId])

  if (!host) return null

  return createPortal(
    <div className="maghrabi-dialogue-panel" dir="ltr">
      <div className="maghrabi-dialogue-head">
        <span><AudioLines className="h-3.5 w-3.5" /> DIALOGUE CLEANUP / ADR ALIGN</span>
        <b>RENDER-GRADE DSP</b>
      </div>

      <div className="maghrabi-dialogue-routing">
        <label><span>TARGET</span><select value={targetId} onChange={(event) => setTargetId(event.target.value)} disabled={busy}><option value="">Select dialogue clip</option>{tracks.map((track) => <option key={track.id} value={track.id}>{labelFor(track)}</option>)}</select></label>
        <label><span>ALIGN REFERENCE</span><select value={referenceId} onChange={(event) => setReferenceId(event.target.value)} disabled={busy || !target}><option value="">Manual alignment</option>{references.map((track) => <option key={track.id} value={track.id}>{labelFor(track)}</option>)}</select></label>
      </div>

      <div className="maghrabi-dialogue-align">
        <button disabled={!target || busy} onClick={() => void nudge(-FRAME_MS)}>-1F</button>
        <button disabled={!target || busy} onClick={() => void nudge(-10)}>-10ms</button>
        <button disabled={!target || !referenceId || busy} className="is-auto" onClick={() => void autoAlign()}><AlignCenter className="h-3 w-3" /> AUTO ALIGN</button>
        <button disabled={!target || busy} onClick={() => void nudge(10)}>+10ms</button>
        <button disabled={!target || busy} onClick={() => void nudge(FRAME_MS)}>+1F</button>
        <span>{target ? `OFFSET ${Number(target.dialogueAlignMs || 0).toFixed(0)}ms` : 'NO TARGET'}</span>
      </div>

      <div className="maghrabi-dialogue-presets">
        <button disabled={!target || busy} onClick={() => setForm(preset('clean'))}>CLEAN DIALOGUE</button>
        <button disabled={!target || busy} onClick={() => setForm(preset('adr'))}>ADR MATCH</button>
        <button disabled={!target || busy} onClick={() => setForm(preset('broadcast'))}>BROADCAST</button>
        <button disabled={!target || busy} onClick={() => setForm(formFromTrack(target!))}><RotateCcw className="h-3 w-3" /> RELOAD</button>
      </div>

      <div className="maghrabi-dialogue-grid">
        <div className="maghrabi-dialogue-card">
          <div className="maghrabi-dialogue-card-head"><span><TimerReset className="h-3 w-3" /> TIMING FIT</span><b>{form.tempo.toFixed(3)}×</b></div>
          <input type="range" min="0.9" max="1.1" step="0.002" value={form.tempo} disabled={!target || busy} onChange={(event) => setForm((current) => ({ ...current, tempo: Number(event.target.value) }))} />
          <button disabled={!target || busy} onClick={fitPunch}>FIT ADR PUNCH</button>
          <small>FFmpeg atempo · pitch preserved · clip container stays fixed</small>
        </div>

        <div className="maghrabi-dialogue-card">
          <div className="maghrabi-dialogue-card-head"><span><Sparkles className="h-3 w-3" /> CLEANUP</span><button className={form.enabled ? 'is-on' : ''} disabled={!target || busy} onClick={() => setForm((current) => ({ ...current, enabled: !current.enabled }))}>{form.enabled ? 'ON' : 'OFF'}</button></div>
          <label><span>NOISE REDUCTION</span><b>{form.noiseReductionDb.toFixed(0)} dB</b><input type="range" min="0" max="24" step="1" value={form.noiseReductionDb} disabled={!target || busy} onChange={(event) => setForm((current) => ({ ...current, noiseReductionDb: Number(event.target.value) }))} /></label>
          <label><span>HIGH-PASS</span><b>{form.highPassHz.toFixed(0)} Hz</b><input type="range" min="40" max="180" step="5" value={form.highPassHz} disabled={!target || busy} onChange={(event) => setForm((current) => ({ ...current, highPassHz: Number(event.target.value) }))} /></label>
          <label><span>DE-ESSER</span><b>{Math.round(form.deEss * 100)}%</b><input type="range" min="0" max="1" step="0.02" value={form.deEss} disabled={!target || busy} onChange={(event) => setForm((current) => ({ ...current, deEss: Number(event.target.value) }))} /></label>
        </div>

        <div className="maghrabi-dialogue-card">
          <div className="maghrabi-dialogue-card-head"><span><Gauge className="h-3 w-3" /> DYNAMICS</span><button className={form.compressor ? 'is-on' : ''} disabled={!target || busy} onClick={() => setForm((current) => ({ ...current, compressor: !current.compressor }))}>COMP {form.compressor ? 'ON' : 'OFF'}</button></div>
          <label><span>THRESHOLD</span><b>{form.compressorThresholdDb.toFixed(0)} dB</b><input type="range" min="-36" max="-6" step="1" value={form.compressorThresholdDb} disabled={!target || busy} onChange={(event) => setForm((current) => ({ ...current, compressorThresholdDb: Number(event.target.value) }))} /></label>
          <label><span>RATIO</span><b>{form.compressorRatio.toFixed(1)}:1</b><input type="range" min="1" max="8" step="0.1" value={form.compressorRatio} disabled={!target || busy} onChange={(event) => setForm((current) => ({ ...current, compressorRatio: Number(event.target.value) }))} /></label>
          <div className="maghrabi-dialogue-inline"><button className={form.loudnessMatch ? 'is-on' : ''} disabled={!target || busy} onClick={() => setForm((current) => ({ ...current, loudnessMatch: !current.loudnessMatch }))}>LOUDNESS MATCH</button><input type="number" min="-24" max="-14" step="0.5" value={form.targetLufs} disabled={!target || busy} onChange={(event) => setForm((current) => ({ ...current, targetLufs: Number(event.target.value) }))} /><span>LUFS</span></div>
        </div>

        <div className="maghrabi-dialogue-card">
          <div className="maghrabi-dialogue-card-head"><span>ROOM TONE / EDGES</span><b>{form.roomToneDb <= -59.5 ? 'OFF' : `${form.roomToneDb.toFixed(0)} dB`}</b></div>
          <label><span>ROOM BED</span><b>{form.roomToneDb <= -59.5 ? 'OFF' : form.roomToneDb.toFixed(0)}</b><input type="range" min="-60" max="-24" step="1" value={form.roomToneDb} disabled={!target || busy} onChange={(event) => setForm((current) => ({ ...current, roomToneDb: Number(event.target.value) }))} /></label>
          <div className="maghrabi-dialogue-inline"><button className={form.roomToneAnchor === 'head' ? 'is-on' : ''} disabled={!target || busy} onClick={() => setForm((current) => ({ ...current, roomToneAnchor: 'head' }))}>HEAD SAMPLE</button><button className={form.roomToneAnchor === 'tail' ? 'is-on' : ''} disabled={!target || busy} onClick={() => setForm((current) => ({ ...current, roomToneAnchor: 'tail' }))}>TAIL SAMPLE</button></div>
          <div className="maghrabi-dialogue-inline"><label><span>FADE IN</span><input type="number" min="0" max="0.25" step="0.005" value={form.fadeIn} disabled={!target || busy} onChange={(event) => setForm((current) => ({ ...current, fadeIn: Number(event.target.value) }))} /></label><label><span>FADE OUT</span><input type="number" min="0" max="0.25" step="0.005" value={form.fadeOut} disabled={!target || busy} onChange={(event) => setForm((current) => ({ ...current, fadeOut: Number(event.target.value) }))} /></label></div>
          <small>Room bed loops a 220ms head/tail sample underneath the processed take.</small>
        </div>
      </div>

      <div className="maghrabi-dialogue-footer">
        <span>NR · HPF · DE-ESS · COMP · LUFS · ROOM TONE · ATEMPO</span>
        <button disabled={!target || busy} onClick={() => void applySettings()}><Save className="h-3.5 w-3.5" /> {busy ? 'PROCESSING…' : 'APPLY TO TARGET'}</button>
      </div>
      {message && <div className="maghrabi-dialogue-message">{message}</div>}
    </div>,
    host,
  )
}
