import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Headphones, Layers3, Mic, Play, Scissors, Square, Trash2 } from 'lucide-react'
import { getActiveStudioProjectId } from './lib/projectHubStore'
import { loadStoredVideoProject, saveStoredVideoProject, type StoredVideoProject } from './lib/projectStore'
import './studioADRTakeManagerPro.css'

type AudioLane = 'A1' | 'A2' | 'A3'
type AdrPhase = 'idle' | 'requesting' | 'pre-roll' | 'recording' | 'post-roll' | 'saving'
type AudioTrack = {
  id: string
  lane: AudioLane
  name: string
  fileIndex: number
  startAt: number
  sourceStart: number
  sourceEnd: number
  volume: number
  fadeIn: number
  fadeOut: number
  automation?: Array<{ time: number; gain: number }>
  linkedClipId?: string | null
  adrGroupId?: string
  adrTakeNumber?: number
  adrTakeActive?: boolean
  adrSourceTake?: boolean
  adrCompSegment?: boolean
  adrCompSourceTakeId?: string
  adrPunchIn?: number
  adrPunchOut?: number
  [key: string]: unknown
}
type ProjectShape = {
  audioTracks?: AudioTrack[]
  audioBins?: string[]
  rangeIn?: number | null
  rangeOut?: number | null
  trackStates?: Partial<Record<AudioLane, { locked?: boolean }>>
  [key: string]: unknown
}
type PunchSpec = { projectId: string; lane: AudioLane; punchIn: number; punchOut: number; groupId: string; preRoll: number; postRoll: number }

const ROOT = '.maghrabi-studio-pro main'
const HEADER_WIDTH = 122
const LANES: AudioLane[] = ['A1', 'A2', 'A3']
const FRAME = 1 / 30

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

function parseZoom() {
  for (const span of Array.from(document.querySelectorAll<HTMLSpanElement>(`${ROOT} span`))) {
    const match = (span.textContent || '').match(/([\d.]+)\s*px\/s/i)
    if (match) return Math.max(1, Number(match[1]) || 12)
  }
  return 12
}

function timelineRoot() {
  return document.querySelector<HTMLElement>('.maghrabi-time-ruler')?.parentElement || null
}

function playheadTime() {
  const timeline = timelineRoot()
  const playhead = document.querySelector<HTMLElement>('.maghrabi-playhead')
  if (!timeline || !playhead) return Number(document.documentElement.dataset.maghrabiFrameClockTime || 0) || 0
  const timelineRect = timeline.getBoundingClientRect()
  const playheadRect = playhead.getBoundingClientRect()
  return Math.max(0, (playheadRect.left + playheadRect.width / 2 - timelineRect.left - HEADER_WIDTH) / parseZoom())
}

function findScrubTarget(timeline: HTMLElement) {
  const adjustmentRow = Array.from(timeline.children).find((child) => child instanceof HTMLElement && child.className.includes('h-[52px]')) as HTMLElement | undefined
  return adjustmentRow?.lastElementChild as HTMLElement | null
}

function jumpToTime(time: number) {
  const timeline = timelineRoot()
  if (!timeline) return false
  const target = findScrubTarget(timeline)
  if (!target) return false
  const rect = target.getBoundingClientRect()
  if (!rect.width) return false
  const x = Math.max(rect.left, Math.min(rect.right - 1, rect.left + Math.max(0, time) * parseZoom()))
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: rect.top + rect.height / 2, view: window }))
  return true
}

function programPanel() {
  const labels = Array.from(document.querySelectorAll<HTMLElement>(`${ROOT} p`))
  const label = labels.find((item) => (item.textContent || '').trim().toUpperCase() === 'PROGRAM MONITOR')
  return label?.closest<HTMLElement>('div[class*="rounded-3xl"]') || null
}

function nativeTransportButton() {
  const panel = programPanel()
  if (!panel) return null
  return Array.from(panel.querySelectorAll<HTMLButtonElement>('button')).find((button) => /^(PLAY|PAUSE)/i.test((button.textContent || '').trim())) || null
}

function setNativePlaying(wanted: boolean) {
  const button = nativeTransportButton()
  if (!button || button.disabled) return false
  const playing = /^PAUSE/.test((button.textContent || '').trim().toUpperCase())
  if (playing !== wanted) button.click()
  return true
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

function rangeFromProject(project: ProjectShape) {
  const a = Number(project.rangeIn)
  const b = Number(project.rangeOut)
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) < .08) return null
  return { punchIn: Math.min(a, b), punchOut: Math.max(a, b) }
}

function recorderMimeType() {
  if (typeof MediaRecorder === 'undefined') return ''
  const candidates = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm']
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || ''
}

function extensionForMime(mime: string) {
  return mime.includes('ogg') ? 'ogg' : 'webm'
}

function measureDuration(file: File, fallback: number) {
  return new Promise<number>((resolve) => {
    const url = URL.createObjectURL(file)
    const audio = document.createElement('audio')
    let settled = false
    const finish = (value: number) => {
      if (settled) return
      settled = true
      URL.revokeObjectURL(url)
      resolve(clamp(Number.isFinite(value) && value > .02 ? value : fallback, .02, 60 * 60 * 8))
    }
    audio.preload = 'metadata'
    audio.onloadedmetadata = () => finish(audio.duration)
    audio.onerror = () => finish(fallback)
    audio.src = url
    window.setTimeout(() => finish(audio.duration), 1400)
  })
}

function matchingGroup(tracks: AudioTrack[], lane: AudioLane, punchIn: number, punchOut: number) {
  return tracks.find((track) => track.adrSourceTake && track.lane === lane && Math.abs(Number(track.adrPunchIn) - punchIn) < .05 && Math.abs(Number(track.adrPunchOut) - punchOut) < .05)?.adrGroupId || uid('adr')
}

function takeTracks(project: ProjectShape, groupId: string | null) {
  if (!groupId) return []
  return (project.audioTracks || [])
    .filter((track) => track.adrGroupId === groupId && track.adrSourceTake)
    .sort((a, b) => Number(a.adrTakeNumber || 0) - Number(b.adrTakeNumber || 0))
}

async function saveMutation(projectId: string, mutate: (snapshot: StoredVideoProject<ProjectShape>, project: ProjectShape) => void) {
  const snapshot = await loadStoredVideoProject<ProjectShape>(projectId)
  if (!snapshot) throw new Error('تعذر قراءة مشروع ADR الحالي.')
  const project = JSON.parse(JSON.stringify(snapshot.project || {})) as ProjectShape
  project.audioTracks = Array.isArray(project.audioTracks) ? project.audioTracks : []
  project.audioBins = Array.isArray(project.audioBins) ? project.audioBins : []
  mutate(snapshot, project)
  await saveStoredVideoProject({ ...snapshot, project, savedAt: new Date().toISOString() }, projectId)
  window.setTimeout(clickRestore, 70)
  return project
}

function splitCompAroundRange(track: AudioTrack, from: number, to: number) {
  const start = Number(track.startAt)
  const end = start + Math.max(.02, Number(track.sourceEnd) - Number(track.sourceStart))
  if (end <= from || start >= to) return [track]
  const parts: AudioTrack[] = []
  if (start < from - .01) {
    const duration = from - start
    parts.push({ ...track, id: uid('comp'), sourceEnd: Number(track.sourceStart) + duration })
  }
  if (end > to + .01) {
    const offset = to - start
    parts.push({ ...track, id: uid('comp'), startAt: to, sourceStart: Number(track.sourceStart) + offset })
  }
  return parts
}

export default function StudioADRTakeManagerPro() {
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [phase, setPhase] = useState<AdrPhase>('idle')
  const [lane, setLane] = useState<AudioLane>('A2')
  const [preRoll, setPreRoll] = useState(3)
  const [postRoll, setPostRoll] = useState(1)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState('')
  const [groupId, setGroupId] = useState<string | null>(null)
  const [takes, setTakes] = useState<AudioTrack[]>([])
  const [selectedTakeId, setSelectedTakeId] = useState<string | null>(null)
  const [punchRange, setPunchRange] = useState<{ punchIn: number; punchOut: number } | null>(null)
  const [compIn, setCompIn] = useState<number | null>(null)
  const [compOut, setCompOut] = useState<number | null>(null)
  const [message, setMessage] = useState('')

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const specRef = useRef<PunchSpec | null>(null)
  const phaseRef = useRef<AdrPhase>('idle')
  const startedPerfRef = useRef(0)
  const cancelRef = useRef(false)
  const postStopAtRef = useRef<number | null>(null)
  const previewStopAtRef = useRef<number | null>(null)
  const fallbackAnchorRef = useRef<{ time: number; clock: number } | null>(null)

  const selectedTake = useMemo(() => takes.find((take) => take.id === selectedTakeId) || takes.at(-1) || null, [takes, selectedTakeId])

  const announce = (text: string) => {
    setMessage(text)
    window.setTimeout(() => setMessage((current) => current === text ? '' : current), 2600)
  }

  const setPhaseSafe = (next: AdrPhase) => {
    phaseRef.current = next
    setPhase(next)
    document.documentElement.dataset.maghrabiAdrPhase = next
  }

  const refreshDevices = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    try {
      const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput')
      setDevices(inputs)
      if (!deviceId && inputs[0]?.deviceId) setDeviceId(inputs[0].deviceId)
    } catch { setDevices([]) }
  }

  const refreshSession = async () => {
    const projectId = getActiveStudioProjectId()
    if (!projectId) return
    const snapshot = await loadStoredVideoProject<ProjectShape>(projectId).catch(() => null)
    if (!snapshot) return
    const range = rangeFromProject(snapshot.project)
    setPunchRange(range)
    const tracks = snapshot.project.audioTracks || []
    let nextGroup = groupId
    if (range) {
      const matched = tracks.find((track) => track.adrSourceTake && track.lane === lane && Math.abs(Number(track.adrPunchIn) - range.punchIn) < .05 && Math.abs(Number(track.adrPunchOut) - range.punchOut) < .05)
      if (matched?.adrGroupId) nextGroup = matched.adrGroupId
    }
    if (!nextGroup) {
      const latest = [...tracks].reverse().find((track) => track.adrSourceTake && track.lane === lane)
      nextGroup = latest?.adrGroupId || null
    }
    setGroupId(nextGroup)
    const nextTakes = takeTracks(snapshot.project, nextGroup)
    setTakes(nextTakes)
    if (!nextTakes.some((take) => take.id === selectedTakeId)) setSelectedTakeId(nextTakes.find((take) => take.adrTakeActive)?.id || nextTakes.at(-1)?.id || null)
  }

  const closeStream = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }

  const commitRecordedTake = async (blob: Blob, fallbackDuration: number, spec: PunchSpec) => {
    const snapshot = await loadStoredVideoProject<ProjectShape>(spec.projectId)
    if (!snapshot) throw new Error('تعذر قراءة المشروع بعد Punch Out.')
    const project = JSON.parse(JSON.stringify(snapshot.project || {})) as ProjectShape
    project.audioTracks = Array.isArray(project.audioTracks) ? project.audioTracks : []
    project.audioBins = Array.isArray(project.audioBins) ? project.audioBins : []
    if (project.trackStates?.[spec.lane]?.locked) throw new Error(`المسار ${spec.lane} أصبح مقفلًا.`)

    const mime = blob.type || recorderMimeType() || 'audio/webm'
    const file = new File([blob], `ADR-${new Date().toISOString().replace(/[:.]/g, '-')}.${extensionForMime(mime)}`, { type: mime, lastModified: Date.now() })
    const duration = await measureDuration(file, fallbackDuration)
    const existing = project.audioTracks.filter((track) => track.adrGroupId === spec.groupId && track.adrSourceTake)
    const takeNumber = Math.max(0, ...existing.map((track) => Number(track.adrTakeNumber || 0))) + 1
    project.audioTracks = project.audioTracks.map((track) => track.adrGroupId === spec.groupId && track.adrSourceTake ? { ...track, volume: 0, adrTakeActive: false } : track)
    const fileIndex = snapshot.audios.length
    const track: AudioTrack = {
      id: uid('take'), lane: spec.lane, name: `ADR T${takeNumber}`, fileIndex,
      startAt: spec.punchIn, sourceStart: 0, sourceEnd: duration,
      volume: 1, fadeIn: Math.min(.02, duration / 5), fadeOut: Math.min(.04, duration / 4), automation: [], linkedClipId: null,
      adrGroupId: spec.groupId, adrTakeNumber: takeNumber, adrTakeActive: true, adrSourceTake: true,
      adrPunchIn: spec.punchIn, adrPunchOut: spec.punchOut,
    }
    project.audioTracks.push(track)
    project.audioBins.push('Audio')
    await saveStoredVideoProject({ ...snapshot, project, audios: [...snapshot.audios, file], audioDurations: [...snapshot.audioDurations, duration], savedAt: new Date().toISOString() }, spec.projectId)
    window.setTimeout(clickRestore, 70)
    setGroupId(spec.groupId)
    setTakes(takeTracks(project, spec.groupId))
    setSelectedTakeId(track.id)
    window.dispatchEvent(new CustomEvent('maghrabi-adr-take-added', { detail: { projectId: spec.projectId, groupId: spec.groupId, takeId: track.id, takeNumber, lane: spec.lane, punchIn: spec.punchIn, punchOut: spec.punchOut } }))
    return track
  }

  const cancelPunch = () => {
    cancelRef.current = true
    postStopAtRef.current = null
    previewStopAtRef.current = null
    setNativePlaying(false)
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop() } catch {}
    } else {
      closeStream()
      recorderRef.current = null
      setPhaseSafe('idle')
    }
  }

  const startPunch = async () => {
    if (phaseRef.current !== 'idle') return
    const projectId = getActiveStudioProjectId()
    if (!projectId) return announce('افتح مشروعًا أولًا.')
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return announce('المتصفح لا يدعم ADR recording.')
    setPhaseSafe('requesting')
    cancelRef.current = false
    try {
      const snapshot = await flushEditorSave(projectId)
      if (!snapshot) throw new Error('تعذر حفظ المشروع قبل ADR.')
      const range = rangeFromProject(snapshot.project)
      if (!range) throw new Error('حدد TIMELINE IN و TIMELINE OUT أولًا لتكوين Punch Range.')
      if (snapshot.project.trackStates?.[lane]?.locked) throw new Error(`المسار ${lane} مقفل.`)
      const group = matchingGroup(snapshot.project.audioTracks || [], lane, range.punchIn, range.punchOut)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1, sampleRate: 48000 }, video: false })
      if (cancelRef.current) { stream.getTracks().forEach((track) => track.stop()); setPhaseSafe('idle'); return }
      streamRef.current = stream
      await refreshDevices()
      const mime = recorderMimeType()
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 192000 } : { audioBitsPerSecond: 192000 })
      recorderRef.current = recorder
      chunksRef.current = []
      const spec: PunchSpec = { projectId, lane, punchIn: range.punchIn, punchOut: range.punchOut, groupId: group, preRoll, postRoll }
      specRef.current = spec
      setGroupId(group)
      setPunchRange(range)
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunksRef.current.push(event.data) }
      recorder.onerror = () => announce('حدث خطأ أثناء ADR recording.')
      recorder.onstop = async () => {
        const wasCancelled = cancelRef.current
        const payload = new Blob(chunksRef.current, { type: recorder.mimeType || mime || 'audio/webm' })
        recorderRef.current = null
        closeStream()
        if (wasCancelled) {
          chunksRef.current = []
          setPhaseSafe('idle')
          return
        }
        setPhaseSafe(postRoll > 0 ? 'post-roll' : 'saving')
        try {
          const fallback = Math.max(.02, (performance.now() - startedPerfRef.current) / 1000)
          const take = await commitRecordedTake(payload, fallback, spec)
          announce(`ADR Take ${take.adrTakeNumber} محفوظ على ${take.lane}.`)
        } catch (error) {
          announce(error instanceof Error ? error.message : 'تعذر حفظ ADR Take.')
        } finally {
          chunksRef.current = []
          if (!postStopAtRef.current) setPhaseSafe('idle')
        }
      }

      const startAt = Math.max(0, range.punchIn - preRoll)
      fallbackAnchorRef.current = { time: startAt, clock: performance.now() }
      jumpToTime(startAt)
      setPhaseSafe('pre-roll')
      window.setTimeout(() => setNativePlaying(true), 70)
    } catch (error) {
      closeStream()
      recorderRef.current = null
      setPhaseSafe('idle')
      announce(error instanceof Error ? error.message : 'تعذر تشغيل ADR Punch.')
    }
  }

  const auditionTake = async (take: AudioTrack) => {
    const projectId = getActiveStudioProjectId()
    if (!projectId || !take.adrGroupId) return
    await saveMutation(projectId, (_snapshot, project) => {
      project.audioTracks = (project.audioTracks || []).map((track) => {
        if (track.adrGroupId !== take.adrGroupId) return track
        if (track.adrCompSegment) return { ...track, volume: 0 }
        if (track.adrSourceTake) return { ...track, volume: track.id === take.id ? 1 : 0, adrTakeActive: track.id === take.id }
        return track
      })
    })
    setSelectedTakeId(take.id)
    const from = Number(take.adrPunchIn ?? take.startAt)
    const to = Number(take.adrPunchOut ?? (take.startAt + take.sourceEnd - take.sourceStart))
    previewStopAtRef.current = to
    jumpToTime(from)
    window.setTimeout(() => setNativePlaying(true), 70)
  }

  const setCompBoundary = (edge: 'in' | 'out') => {
    if (!punchRange) return announce('لا يوجد Punch Range نشط.')
    const time = clamp(playheadTime(), punchRange.punchIn, punchRange.punchOut)
    if (edge === 'in') setCompIn(time)
    else setCompOut(time)
  }

  const commitCompSegment = async () => {
    const projectId = getActiveStudioProjectId()
    if (!projectId || !selectedTake?.adrGroupId || !punchRange) return announce('اختر ADR Take أولًا.')
    const a = Number(compIn)
    const b = Number(compOut)
    if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) < .05) return announce('حدد COMP IN و COMP OUT أولًا.')
    const from = clamp(Math.min(a, b), punchRange.punchIn, punchRange.punchOut)
    const to = clamp(Math.max(a, b), punchRange.punchIn, punchRange.punchOut)
    if (to - from < .05) return announce('Comp Segment قصير جدًا.')
    await saveMutation(projectId, (_snapshot, project) => {
      const next: AudioTrack[] = []
      for (const track of project.audioTracks || []) {
        if (track.adrGroupId === selectedTake.adrGroupId && track.adrCompSegment) next.push(...splitCompAroundRange(track, from, to))
        else if (track.adrGroupId === selectedTake.adrGroupId && track.adrSourceTake) next.push({ ...track, volume: 0, adrTakeActive: track.id === selectedTake.id })
        else next.push(track)
      }
      const sourceOffset = Math.max(0, from - Number(selectedTake.startAt))
      const maxAvailable = Math.max(.02, Number(selectedTake.sourceEnd) - Number(selectedTake.sourceStart))
      const span = Math.min(to - from, Math.max(.02, maxAvailable - sourceOffset))
      next.push({
        ...selectedTake,
        id: uid('comp'),
        name: `COMP · T${selectedTake.adrTakeNumber || '?'} · ${from.toFixed(2)}-${(from + span).toFixed(2)}`,
        startAt: from,
        sourceStart: Number(selectedTake.sourceStart) + sourceOffset,
        sourceEnd: Number(selectedTake.sourceStart) + sourceOffset + span,
        volume: 1,
        fadeIn: Math.min(.012, span / 6),
        fadeOut: Math.min(.012, span / 6),
        adrSourceTake: false,
        adrCompSegment: true,
        adrCompSourceTakeId: selectedTake.id,
        adrTakeActive: false,
      })
      project.audioTracks = next
    })
    announce(`تم تركيب Comp Segment من Take ${selectedTake.adrTakeNumber}.`)
    setCompIn(null)
    setCompOut(null)
  }

  const clearComp = async () => {
    const projectId = getActiveStudioProjectId()
    if (!projectId || !selectedTake?.adrGroupId) return
    await saveMutation(projectId, (_snapshot, project) => {
      project.audioTracks = (project.audioTracks || [])
        .filter((track) => !(track.adrGroupId === selectedTake.adrGroupId && track.adrCompSegment))
        .map((track) => track.adrGroupId === selectedTake.adrGroupId && track.adrSourceTake ? { ...track, volume: track.id === selectedTake.id ? 1 : 0, adrTakeActive: track.id === selectedTake.id } : track)
    })
    announce('تم حذف Comp Segments والعودة إلى الـTake المحدد.')
  }

  useEffect(() => {
    const refreshHost = () => setHost(programPanel())
    const observer = new MutationObserver(refreshHost)
    observer.observe(document.body, { childList: true, subtree: true })
    refreshHost()
    void refreshDevices()
    void refreshSession()
    const onSnapshot = () => void refreshSession()
    const onProject = () => void refreshSession()
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices)
    window.addEventListener('maghrabi-project-snapshot-changed', onSnapshot)
    window.addEventListener('maghrabi-project-active-changed', onProject)
    return () => {
      observer.disconnect()
      navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices)
      window.removeEventListener('maghrabi-project-snapshot-changed', onSnapshot)
      window.removeEventListener('maghrabi-project-active-changed', onProject)
    }
  }, [lane, groupId])

  useEffect(() => {
    const onClock = (event: Event) => {
      const detail = (event as CustomEvent<{ time?: number; playing?: boolean }>).detail || {}
      const spec = specRef.current
      let time = Number(detail.time)
      if (!Number.isFinite(time)) time = playheadTime()
      const fallback = fallbackAnchorRef.current
      if (spec && fallback && (!detail.playing || time < fallback.time - .1)) time = fallback.time + (performance.now() - fallback.clock) / 1000

      if (spec && phaseRef.current === 'pre-roll' && time >= spec.punchIn - FRAME / 2) {
        const recorder = recorderRef.current
        if (recorder && recorder.state === 'inactive') {
          chunksRef.current = []
          startedPerfRef.current = performance.now()
          try { recorder.start(100); setPhaseSafe('recording') } catch { cancelPunch() }
        }
      }
      if (spec && phaseRef.current === 'recording' && time >= spec.punchOut - FRAME / 2) {
        const recorder = recorderRef.current
        if (recorder && recorder.state === 'recording') {
          postStopAtRef.current = spec.postRoll > 0 ? spec.punchOut + spec.postRoll : null
          if (!postStopAtRef.current) setNativePlaying(false)
          try { recorder.stop() } catch { cancelPunch() }
        }
      }
      if (postStopAtRef.current && time >= postStopAtRef.current - FRAME / 2) {
        postStopAtRef.current = null
        setNativePlaying(false)
        jumpToTime(spec?.punchIn || time)
        if (!recorderRef.current) setPhaseSafe('idle')
      }
      if (previewStopAtRef.current && time >= previewStopAtRef.current - FRAME / 2) {
        previewStopAtRef.current = null
        setNativePlaying(false)
      }
    }
    window.addEventListener('maghrabi-frame-clock', onClock as EventListener)
    return () => window.removeEventListener('maghrabi-frame-clock', onClock as EventListener)
  }, [])

  useEffect(() => () => {
    cancelRef.current = true
    try { if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop() } catch {}
    setNativePlaying(false)
    closeStream()
    delete document.documentElement.dataset.maghrabiAdrPhase
  }, [])

  if (!host) return null
  const busy = phase !== 'idle'
  const compRangeLabel = Number.isFinite(Number(compIn)) || Number.isFinite(Number(compOut)) ? `${compIn?.toFixed(2) ?? '--'} → ${compOut?.toFixed(2) ?? '--'}` : 'SET COMP RANGE'

  return createPortal(
    <div className="maghrabi-adr-panel" dir="ltr">
      <div className="maghrabi-adr-head">
        <span className="maghrabi-adr-title"><Layers3 className="h-3.5 w-3.5" /> ADR PUNCH / TAKE MANAGER</span>
        <span className={`maghrabi-adr-phase is-${phase.replace(/[^a-z]/g, '')}`}>{phase.toUpperCase()}</span>
      </div>

      <div className="maghrabi-adr-range">
        <span>PUNCH</span><b>{punchRange ? `${punchRange.punchIn.toFixed(2)}s → ${punchRange.punchOut.toFixed(2)}s` : 'SET TIMELINE IN / OUT'}</b>
        <span>GROUP</span><b>{groupId ? groupId.slice(-6).toUpperCase() : 'NEW'}</b>
      </div>

      <div className="maghrabi-adr-controls">
        <label><span>INPUT</span><select disabled={busy} value={deviceId} onChange={(event) => setDeviceId(event.target.value)}><option value="">Default microphone</option>{devices.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}</select></label>
        <div className="maghrabi-adr-lanes">{LANES.map((item) => <button key={item} disabled={busy} className={lane === item ? 'is-active' : ''} onClick={() => { setLane(item); setGroupId(null) }}>{item}</button>)}</div>
        <button disabled={busy} onClick={() => setPreRoll((value) => value === 2 ? 3 : value === 3 ? 5 : 2)}>PRE {preRoll}s</button>
        <button disabled={busy} onClick={() => setPostRoll((value) => value === 0 ? 1 : value === 1 ? 2 : 0)}>POST {postRoll}s</button>
        {busy ? <button className="is-stop" onClick={cancelPunch}><Square className="h-3 w-3" /> CANCEL</button> : <button className="is-record" onClick={() => void startPunch()}><Mic className="h-3 w-3" /> PUNCH REC</button>}
      </div>

      <div className="maghrabi-adr-takes">
        <div className="maghrabi-adr-takes-head"><span>TAKES</span><b>{takes.length}</b></div>
        <div className="maghrabi-adr-take-list">
          {!takes.length && <span className="maghrabi-adr-empty">No ADR takes for this punch yet</span>}
          {takes.map((take) => <button key={take.id} className={`${selectedTake?.id === take.id ? 'is-selected' : ''}${take.adrTakeActive ? ' is-active' : ''}`} onClick={() => setSelectedTakeId(take.id)}><span>T{take.adrTakeNumber || '?'}</span><small>{(Number(take.sourceEnd) - Number(take.sourceStart)).toFixed(2)}s</small>{take.adrTakeActive && <Check className="h-3 w-3" />}</button>)}
        </div>
        <div className="maghrabi-adr-take-actions">
          <button disabled={!selectedTake || busy} onClick={() => selectedTake && void auditionTake(selectedTake)}><Headphones className="h-3 w-3" /> AUDITION TAKE</button>
          <button disabled={!selectedTake || busy} onClick={() => punchRange && jumpToTime(punchRange.punchIn)}><Play className="h-3 w-3" /> GO PUNCH IN</button>
        </div>
      </div>

      <div className="maghrabi-adr-comp">
        <div className="maghrabi-adr-comp-head"><span><Scissors className="h-3 w-3" /> COMPING</span><b>{compRangeLabel}</b></div>
        <div className="maghrabi-adr-comp-actions">
          <button disabled={!selectedTake || busy} onClick={() => setCompBoundary('in')}>SET COMP IN</button>
          <button disabled={!selectedTake || busy} onClick={() => setCompBoundary('out')}>SET COMP OUT</button>
          <button disabled={!selectedTake || busy || compIn === null || compOut === null} className="is-commit" onClick={() => void commitCompSegment()}>USE T{selectedTake?.adrTakeNumber || '?'} SEGMENT</button>
          <button disabled={!selectedTake || busy} className="is-clear" onClick={() => void clearComp()}><Trash2 className="h-3 w-3" /> CLEAR COMP</button>
        </div>
      </div>

      {message && <div className="maghrabi-adr-message">{message}</div>}
    </div>, host,
  )
}
