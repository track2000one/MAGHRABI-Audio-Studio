import { useEffect, useState } from 'react'
import { getActiveStudioProjectId } from './lib/projectHubStore'
import { loadStoredVideoProject, saveStoredVideoProject, type StoredVideoProject } from './lib/projectStore'
import './studioAdvancedTrim.css'

type VideoLane = 'V1' | 'V2' | 'V3'
type AudioLane = 'A1' | 'A2' | 'A3'
type LaneKey = VideoLane | AudioLane

type TrackState = { locked?: boolean; syncLock?: boolean }

type VideoClip = {
  id: string
  lane: VideoLane
  fileIndex: number
  startAt: number
  start: number
  end: number
  speed: number
  freezeFrame?: boolean
  freezeDuration?: number
  detachedTrackId?: string | null
  [key: string]: unknown
}

type AudioClip = {
  id: string
  lane: AudioLane
  fileIndex: number
  startAt: number
  sourceStart: number
  sourceEnd: number
  linkedClipId?: string | null
  [key: string]: unknown
}

type AdjustmentLayer = { id?: string; startAt: number; endAt: number; [key: string]: unknown }

type ProjectShape = {
  clips?: VideoClip[]
  audioTracks?: AudioClip[]
  adjustments?: AdjustmentLayer[]
  trackStates?: Partial<Record<LaneKey, TrackState>>
  [key: string]: unknown
}

type ClipRef = {
  kind: 'video' | 'audio'
  lane: LaneKey
  startAt: number
  fileIndex: number | null
  element: HTMLButtonElement
}

const ROOT = '.maghrabi-studio-pro main'
const MIN_DURATION = .05

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function isVideoLane(value: string): value is VideoLane {
  return value === 'V1' || value === 'V2' || value === 'V3'
}

function parseZoom() {
  const spans = Array.from(document.querySelectorAll<HTMLSpanElement>(`${ROOT} span`))
  for (const span of spans) {
    const match = (span.textContent || '').match(/([\d.]+)\s*px\/s/i)
    if (match) return Math.max(1, Number(match[1]) || 12)
  }
  return 12
}

function firstClipLabel(button: HTMLButtonElement) {
  return (button.querySelector('span')?.textContent || '').trim()
}

function clipRef(button: HTMLButtonElement): ClipRef | null {
  const label = firstClipLabel(button)
  const laneMatch = label.match(/^(V[123]|A[123])\s*·/)
  if (!laneMatch) return null
  const lane = laneMatch[1]
  const zoom = parseZoom()
  const fileMatch = label.match(/^V[123]\s*·\s*V(\d+)/)
  return {
    kind: lane.startsWith('V') ? 'video' : 'audio',
    lane: lane as LaneKey,
    startAt: Math.max(0, (Number.parseFloat(button.style.left || '0') || 0) / zoom),
    fileIndex: fileMatch ? Math.max(0, Number(fileMatch[1]) - 1) : null,
    element: button,
  }
}

function clipDuration(clip: VideoClip) {
  if (clip.freezeFrame) return Math.max(.2, clip.freezeDuration || 2)
  return Math.max(.02, (clip.end - clip.start) / Math.max(.25, clip.speed || 1))
}

function videoEnd(clip: VideoClip) {
  return clip.startAt + clipDuration(clip)
}

function audioDuration(track: AudioClip) {
  return Math.max(.02, track.sourceEnd - track.sourceStart)
}

function audioEnd(track: AudioClip) {
  return track.startAt + audioDuration(track)
}

function editorButtons() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(`${ROOT} button`))
}

function clickRestore() {
  editorButtons().find((button) => (button.textContent || '').includes('استعادة'))?.click()
}

async function flushEditorSave(projectId: string) {
  const saveButton = editorButtons().find((button) => (button.textContent || '').includes('حفظ'))
  if (!saveButton || saveButton.disabled) return loadStoredVideoProject<ProjectShape>(projectId)
  const confirmed = new Promise<void>((resolve) => {
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
  saveButton.click()
  await confirmed
  return loadStoredVideoProject<ProjectShape>(projectId)
}

async function mutateProject(mutator: (project: ProjectShape, snapshot: StoredVideoProject<ProjectShape>) => boolean) {
  const projectId = getActiveStudioProjectId()
  if (!projectId) return false
  const snapshot = await flushEditorSave(projectId)
  if (!snapshot) return false
  const project = JSON.parse(JSON.stringify(snapshot.project || {})) as ProjectShape
  project.clips = Array.isArray(project.clips) ? project.clips : []
  project.audioTracks = Array.isArray(project.audioTracks) ? project.audioTracks : []
  project.adjustments = Array.isArray(project.adjustments) ? project.adjustments : []
  if (!mutator(project, snapshot)) return false
  await saveStoredVideoProject({ ...snapshot, project, savedAt: new Date().toISOString() }, projectId)
  window.setTimeout(clickRestore, 70)
  return true
}

function findVideo(project: ProjectShape, ref: ClipRef) {
  const candidates = (project.clips || []).filter((clip) => clip.lane === ref.lane && (ref.fileIndex === null || clip.fileIndex === ref.fileIndex))
  return candidates.sort((a, b) => Math.abs(a.startAt - ref.startAt) - Math.abs(b.startAt - ref.startAt))[0] || null
}

function findAudio(project: ProjectShape, ref: ClipRef) {
  const candidates = (project.audioTracks || []).filter((track) => track.lane === ref.lane)
  return candidates.sort((a, b) => Math.abs(a.startAt - ref.startAt) - Math.abs(b.startAt - ref.startAt))[0] || null
}

function syncEnabled(project: ProjectShape, lane: LaneKey) {
  return project.trackStates?.[lane]?.syncLock !== false
}

function laneLocked(project: ProjectShape, lane: LaneKey) {
  return project.trackStates?.[lane]?.locked === true
}

function shiftFollowing(project: ProjectShape, boundary: number, delta: number, excludeVideo = new Set<string>(), excludeAudio = new Set<string>()) {
  if (Math.abs(delta) < .0001) return
  ;(project.clips || []).forEach((clip) => {
    if (excludeVideo.has(clip.id) || !syncEnabled(project, clip.lane)) return
    if (clip.startAt >= boundary - .015) clip.startAt = Math.max(0, clip.startAt + delta)
  })
  ;(project.audioTracks || []).forEach((track) => {
    if (excludeAudio.has(track.id) || !syncEnabled(project, track.lane)) return
    if (track.startAt >= boundary - .015) track.startAt = Math.max(0, track.startAt + delta)
  })
  ;(project.adjustments || []).forEach((layer) => {
    if (layer.startAt >= boundary - .015) {
      layer.startAt = Math.max(0, layer.startAt + delta)
      layer.endAt = Math.max(layer.startAt + .02, layer.endAt + delta)
    }
  })
}

async function rippleTrim(ref: ClipRef, edge: 'in' | 'out', requestedTimeline: number) {
  return mutateProject((project, snapshot) => {
    if (laneLocked(project, ref.lane)) return false
    if (ref.kind === 'video') {
      const clip = findVideo(project, ref)
      if (!clip || clip.freezeFrame) return false
      const speed = Math.max(.25, clip.speed || 1)
      const sourceDuration = snapshot.videoDurations?.[clip.fileIndex] || clip.end
      const boundary = videoEnd(clip)
      let durationChange = 0
      let sourceInApplied = 0
      if (edge === 'out') {
        const nextEnd = clamp(clip.end + requestedTimeline * speed, clip.start + MIN_DURATION, sourceDuration)
        const applied = (nextEnd - clip.end) / speed
        if (Math.abs(applied) < .0001) return false
        clip.end = nextEnd
        durationChange = applied
      } else {
        const nextStart = clamp(clip.start + requestedTimeline * speed, 0, clip.end - MIN_DURATION)
        const applied = (nextStart - clip.start) / speed
        if (Math.abs(applied) < .0001) return false
        clip.start = nextStart
        sourceInApplied = applied
        durationChange = -applied
      }

      const excludeVideo = new Set<string>([clip.id])
      const excludeAudio = new Set<string>()
      if (clip.detachedTrackId) {
        const linked = (project.audioTracks || []).find((track) => track.id === clip.detachedTrackId)
        if (linked && syncEnabled(project, linked.lane)) {
          excludeAudio.add(linked.id)
          if (edge === 'out') linked.sourceEnd = clamp(linked.sourceEnd + durationChange, linked.sourceStart + MIN_DURATION, snapshot.audioDurations?.[linked.fileIndex] || linked.sourceEnd + Math.max(0, durationChange))
          else linked.sourceStart = clamp(linked.sourceStart + sourceInApplied, 0, linked.sourceEnd - MIN_DURATION)
        }
      }
      shiftFollowing(project, boundary, durationChange, excludeVideo, excludeAudio)
      return true
    }

    const track = findAudio(project, ref)
    if (!track) return false
    const sourceDuration = snapshot.audioDurations?.[track.fileIndex] || track.sourceEnd
    const boundary = audioEnd(track)
    let durationChange = 0
    if (edge === 'out') {
      const nextEnd = clamp(track.sourceEnd + requestedTimeline, track.sourceStart + MIN_DURATION, sourceDuration)
      const applied = nextEnd - track.sourceEnd
      if (Math.abs(applied) < .0001) return false
      track.sourceEnd = nextEnd
      durationChange = applied
    } else {
      const nextStart = clamp(track.sourceStart + requestedTimeline, 0, track.sourceEnd - MIN_DURATION)
      const applied = nextStart - track.sourceStart
      if (Math.abs(applied) < .0001) return false
      track.sourceStart = nextStart
      durationChange = -applied
    }
    shiftFollowing(project, boundary, durationChange, new Set(), new Set([track.id]))
    return true
  })
}

async function rollingTrim(ref: ClipRef, edge: 'in' | 'out', requestedTimeline: number) {
  return mutateProject((project, snapshot) => {
    if (laneLocked(project, ref.lane)) return false
    if (ref.kind === 'video') {
      const selected = findVideo(project, ref)
      if (!selected || selected.freezeFrame) return false
      const lane = (project.clips || []).filter((clip) => clip.lane === selected.lane && !clip.freezeFrame).sort((a, b) => a.startAt - b.startAt)
      const index = lane.findIndex((clip) => clip.id === selected.id)
      if (index < 0) return false
      const left = edge === 'out' ? selected : lane[index - 1]
      const right = edge === 'out' ? lane[index + 1] : selected
      if (!left || !right || Math.abs(videoEnd(left) - right.startAt) > .15) return false
      const leftSpeed = Math.max(.25, left.speed || 1)
      const rightSpeed = Math.max(.25, right.speed || 1)
      const leftSourceDuration = snapshot.videoDurations?.[left.fileIndex] || left.end
      const maxPositive = Math.min(
        Math.max(0, (leftSourceDuration - left.end) / leftSpeed),
        Math.max(0, (right.end - right.start - MIN_DURATION) / rightSpeed),
      )
      const maxNegative = Math.min(
        Math.max(0, (left.end - left.start - MIN_DURATION) / leftSpeed),
        Math.max(0, right.start / rightSpeed),
      )
      const applied = clamp(requestedTimeline, -maxNegative, maxPositive)
      if (Math.abs(applied) < .0001) return false
      left.end += applied * leftSpeed
      right.startAt += applied
      right.start += applied * rightSpeed
      return true
    }

    const selected = findAudio(project, ref)
    if (!selected) return false
    const lane = (project.audioTracks || []).filter((track) => track.lane === selected.lane).sort((a, b) => a.startAt - b.startAt)
    const index = lane.findIndex((track) => track.id === selected.id)
    if (index < 0) return false
    const left = edge === 'out' ? selected : lane[index - 1]
    const right = edge === 'out' ? lane[index + 1] : selected
    if (!left || !right || Math.abs(audioEnd(left) - right.startAt) > .15) return false
    const leftSourceDuration = snapshot.audioDurations?.[left.fileIndex] || left.sourceEnd
    const maxPositive = Math.min(
      Math.max(0, leftSourceDuration - left.sourceEnd),
      Math.max(0, right.sourceEnd - right.sourceStart - MIN_DURATION),
    )
    const maxNegative = Math.min(
      Math.max(0, left.sourceEnd - left.sourceStart - MIN_DURATION),
      Math.max(0, right.sourceStart),
    )
    const applied = clamp(requestedTimeline, -maxNegative, maxPositive)
    if (Math.abs(applied) < .0001) return false
    left.sourceEnd += applied
    right.startAt += applied
    right.sourceStart += applied
    return true
  })
}

function neighborButton(button: HTMLButtonElement, ref: ClipRef, edge: 'in' | 'out') {
  const siblings = Array.from(button.parentElement?.querySelectorAll<HTMLButtonElement>('button.maghrabi-pro-clip') || [])
    .map((element) => ({ element, ref: clipRef(element) }))
    .filter((item): item is { element: HTMLButtonElement; ref: ClipRef } => Boolean(item.ref) && item.ref.lane === ref.lane)
    .sort((a, b) => a.ref.startAt - b.ref.startAt)
  const index = siblings.findIndex((item) => item.element === button)
  return edge === 'out' ? siblings[index + 1]?.element || null : siblings[index - 1]?.element || null
}

export default function StudioAdvancedTrimPro() {
  const [message, setMessage] = useState('')

  useEffect(() => {
    let activeCleanup: (() => void) | null = null
    let decorateFrame = 0

    const announce = (text: string) => {
      setMessage(text)
      window.setTimeout(() => setMessage((current) => current === text ? '' : current), 2200)
    }

    const decorate = () => {
      window.cancelAnimationFrame(decorateFrame)
      decorateFrame = window.requestAnimationFrame(() => {
        document.querySelectorAll<HTMLElement>('.maghrabi-trim-handle').forEach((handle) => {
          const edge = handle.classList.contains('is-in') ? 'IN' : 'OUT'
          handle.title = `Trim ${edge} · Shift+Drag = Ripple Trim · Alt+Drag = Rolling Edit`
        })
      })
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || (!event.shiftKey && !event.altKey)) return
      const target = event.target instanceof HTMLElement ? event.target : null
      const handle = target?.closest<HTMLElement>('.maghrabi-trim-handle')
      const button = handle?.closest<HTMLButtonElement>('button.maghrabi-pro-clip')
      if (!handle || !button) return
      const ref = clipRef(button)
      if (!ref) return
      const edge: 'in' | 'out' = handle.classList.contains('is-in') ? 'in' : 'out'
      const mode: 'ripple' | 'rolling' = event.altKey ? 'rolling' : 'ripple'
      const startX = event.clientX
      const pointerId = event.pointerId
      const originalLeft = Number.parseFloat(button.style.left || '0') || 0
      const originalWidth = Number.parseFloat(button.style.width || '0') || button.getBoundingClientRect().width
      const neighbor = mode === 'rolling' ? neighborButton(button, ref, edge) : null
      const neighborLeft = neighbor ? Number.parseFloat(neighbor.style.left || '0') || 0 : 0
      const neighborWidth = neighbor ? Number.parseFloat(neighbor.style.width || '0') || neighbor.getBoundingClientRect().width : 0

      const badge = document.createElement('div')
      badge.className = `maghrabi-advanced-trim-badge is-${mode}`
      document.body.appendChild(badge)
      document.body.classList.add('maghrabi-advanced-trimming')
      handle.classList.add('is-active')

      const restore = () => {
        button.style.left = `${originalLeft}px`
        button.style.width = `${originalWidth}px`
        if (neighbor) {
          neighbor.style.left = `${neighborLeft}px`
          neighbor.style.width = `${neighborWidth}px`
        }
      }

      const onMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return
        moveEvent.preventDefault()
        moveEvent.stopPropagation()
        const delta = moveEvent.clientX - startX
        if (mode === 'ripple') {
          if (edge === 'out') button.style.width = `${Math.max(10, originalWidth + delta)}px`
          else button.style.width = `${Math.max(10, originalWidth - delta)}px`
        } else if (neighbor) {
          if (edge === 'out') {
            button.style.width = `${Math.max(10, originalWidth + delta)}px`
            neighbor.style.left = `${neighborLeft + delta}px`
            neighbor.style.width = `${Math.max(10, neighborWidth - delta)}px`
          } else {
            neighbor.style.width = `${Math.max(10, neighborWidth + delta)}px`
            button.style.left = `${originalLeft + delta}px`
            button.style.width = `${Math.max(10, originalWidth - delta)}px`
          }
        }
        badge.style.left = `${clamp(moveEvent.clientX + 14, 8, window.innerWidth - 198)}px`
        badge.style.top = `${clamp(moveEvent.clientY - 44, 8, window.innerHeight - 52)}px`
        badge.innerHTML = `<strong>${mode === 'ripple' ? 'RIPPLE TRIM' : 'ROLLING EDIT'} · ${edge.toUpperCase()}</strong><span>${(delta / parseZoom()).toFixed(2)}s</span>`
      }

      const cleanup = () => {
        window.removeEventListener('pointermove', onMove, true)
        window.removeEventListener('pointerup', onUp, true)
        window.removeEventListener('pointercancel', onCancel, true)
        document.body.classList.remove('maghrabi-advanced-trimming')
        handle.classList.remove('is-active')
        badge.remove()
        activeCleanup = null
      }

      const onUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return
        upEvent.preventDefault()
        upEvent.stopPropagation()
        const deltaTimeline = (upEvent.clientX - startX) / parseZoom()
        restore()
        if (Math.abs(deltaTimeline) < .01) { cleanup(); return }
        const operation = mode === 'ripple' ? rippleTrim(ref, edge, deltaTimeline) : rollingTrim(ref, edge, deltaTimeline)
        void operation.then((ok) => {
          announce(ok
            ? `${mode === 'ripple' ? 'Ripple Trim' : 'Rolling Edit'} تم تطبيقه بدقة`
            : mode === 'rolling' ? 'Rolling Edit يحتاج مقطعين متصلين ومساحة Source كافية' : 'تعذر تنفيذ Ripple Trim ضمن حدود Source')
        }).catch(() => announce('تعذر حفظ عملية التحرير الدقيقة')).finally(() => window.setTimeout(cleanup, 100))
      }

      const onCancel = (cancelEvent: PointerEvent) => {
        if (cancelEvent.pointerId !== pointerId) return
        restore()
        cleanup()
      }

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      activeCleanup?.()
      activeCleanup = () => { restore(); cleanup() }
      window.addEventListener('pointermove', onMove, true)
      window.addEventListener('pointerup', onUp, true)
      window.addEventListener('pointercancel', onCancel, true)
    }

    const observer = new MutationObserver(() => decorate())
    observer.observe(document.body, { childList: true, subtree: true })
    document.addEventListener('pointerdown', onPointerDown, true)
    decorate()

    return () => {
      observer.disconnect()
      document.removeEventListener('pointerdown', onPointerDown, true)
      activeCleanup?.()
      window.cancelAnimationFrame(decorateFrame)
      document.body.classList.remove('maghrabi-advanced-trimming')
    }
  }, [])

  return message ? <div className="maghrabi-advanced-trim-toast" dir="rtl">{message}</div> : null
}
