import { useEffect, useState } from 'react'
import { getActiveStudioProjectId } from './lib/projectHubStore'
import { loadStoredVideoProject, saveStoredVideoProject, type StoredVideoProject } from './lib/projectStore'
import './studioTimelineInteraction.css'

type VideoLane = 'V1' | 'V2' | 'V3'
type AudioLane = 'A1' | 'A2' | 'A3'
type LaneKey = VideoLane | AudioLane

type TrackState = { targeted?: boolean; locked?: boolean; syncLock?: boolean }

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
  linkedAudio?: boolean
  detachedTrackId?: string | null
  groupId?: string | null
  [key: string]: unknown
}

type AudioClip = {
  id: string
  lane: AudioLane
  fileIndex: number
  startAt: number
  sourceStart: number
  sourceEnd: number
  name?: string
  linkedClipId?: string | null
  [key: string]: unknown
}

type ProjectShape = {
  clips?: VideoClip[]
  audioTracks?: AudioClip[]
  trackStates?: Partial<Record<LaneKey, TrackState>>
  [key: string]: unknown
}

type ClipRef = {
  kind: 'video' | 'audio'
  lane: LaneKey
  startAt: number
  duration: number
  fileIndex: number | null
  name: string
  element: HTMLButtonElement
}

type LaneSurface = {
  lane: LaneKey
  row: HTMLElement
  header: HTMLElement
  surface: HTMLElement
  locked: boolean
}

type SnapResult = {
  startAt: number
  clientX: number | null
  label: string
}

const ROOT = '.maghrabi-studio-pro main'
const HEADER_WIDTH = 122
const FRAME = 1 / 30
const SNAP_THRESHOLD_PX = 10
const MOVE_THRESHOLD_PX = 4

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function isVideoLane(value: string): value is VideoLane {
  return value === 'V1' || value === 'V2' || value === 'V3'
}

function isAudioLane(value: string): value is AudioLane {
  return value === 'A1' || value === 'A2' || value === 'A3'
}

function sameKind(kind: ClipRef['kind'], lane: LaneKey) {
  return kind === 'video' ? isVideoLane(lane) : isAudioLane(lane)
}

function parseClock(value: string) {
  const match = value.trim().match(/^(\d+):(\d+(?:\.\d+)?)$/)
  if (!match) return Number.NaN
  return Number(match[1]) * 60 + Number(match[2])
}

function formatTime(seconds: number) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const minutes = Math.floor(safe / 60)
  const secs = safe - minutes * 60
  return `${String(minutes).padStart(2, '0')}:${secs.toFixed(2).padStart(5, '0')}`
}

function parseZoom() {
  const spans = Array.from(document.querySelectorAll<HTMLSpanElement>(`${ROOT} span`))
  for (const span of spans) {
    const match = (span.textContent || '').match(/([\d.]+)\s*px\/s/i)
    if (match) return Math.max(1, Number(match[1]) || 12)
  }
  return 12
}

function zoomInput() {
  return document.querySelector<HTMLInputElement>('.maghrabi-studio-pro input[type="range"][min="5"][max="30"]')
}

function timelineRoot() {
  return document.querySelector<HTMLElement>('.maghrabi-time-ruler')?.parentElement || null
}

function timelineScroller() {
  return timelineRoot()?.parentElement as HTMLElement | null
}

function editorButtons() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(`${ROOT} button`))
}

function clickRestore() {
  editorButtons().find((button) => (button.textContent || '').includes('استعادة'))?.click()
}

function firstClipLabel(button: HTMLButtonElement) {
  return (button.querySelector('span')?.textContent || '').trim()
}

function clipDurationFromButton(button: HTMLButtonElement, zoom = parseZoom()) {
  for (const span of Array.from(button.querySelectorAll<HTMLSpanElement>('span'))) {
    const match = (span.textContent || '').match(/(\d+:\d+(?:\.\d+)?)\s*·\s*(\d+:\d+(?:\.\d+)?)/)
    if (!match) continue
    const duration = parseClock(match[2])
    if (Number.isFinite(duration) && duration > 0) return duration
  }
  const width = Number.parseFloat(button.style.width || '0') || button.getBoundingClientRect().width
  return Math.max(FRAME, width / Math.max(1, zoom))
}

function clipRef(button: HTMLButtonElement): ClipRef | null {
  const label = firstClipLabel(button)
  const laneMatch = label.match(/^(V[123]|A[123])\s*·\s*(.*)$/)
  if (!laneMatch) return null
  const lane = laneMatch[1]
  if (!isVideoLane(lane) && !isAudioLane(lane)) return null
  const zoom = parseZoom()
  const startAt = Math.max(0, (Number.parseFloat(button.style.left || '0') || 0) / zoom)
  const fileMatch = label.match(/^V[123]\s*·\s*V(\d+)/)
  return {
    kind: isVideoLane(lane) ? 'video' : 'audio',
    lane,
    startAt,
    duration: clipDurationFromButton(button, zoom),
    fileIndex: fileMatch ? Math.max(0, Number(fileMatch[1]) - 1) : null,
    name: laneMatch[2].trim(),
    element: button,
  }
}

function laneSurfaces(timeline = timelineRoot()): LaneSurface[] {
  if (!timeline) return []
  const result: LaneSurface[] = []
  for (const row of Array.from(timeline.children)) {
    if (!(row instanceof HTMLElement) || !row.className.includes('h-[66px]')) continue
    const header = row.firstElementChild
    const surface = row.lastElementChild
    if (!(header instanceof HTMLElement) || !(surface instanceof HTMLElement) || header === surface) continue
    const label = (header.lastElementChild?.textContent || '').trim()
    if (!isVideoLane(label) && !isAudioLane(label)) continue
    const locked = Boolean(header.querySelector('svg.lucide-lock'))
    result.push({ lane: label, row, header, surface, locked })
  }
  return result
}

function laneAtY(kind: ClipRef['kind'], clientY: number, fallback: LaneSurface, lockLane = false) {
  if (lockLane) return fallback
  const compatible = laneSurfaces().filter((item) => sameKind(kind, item.lane) && !item.locked)
  return compatible.find((item) => {
    const rect = item.surface.getBoundingClientRect()
    return clientY >= rect.top && clientY <= rect.bottom
  }) || fallback
}

function quantizeToFrame(time: number) {
  return Math.max(0, Math.round(time / FRAME) * FRAME)
}

function snapCandidates(active: HTMLElement) {
  const timeline = timelineRoot()
  if (!timeline) return [] as number[]
  const values: number[] = []
  timeline.querySelectorAll<HTMLButtonElement>('button.maghrabi-pro-clip').forEach((button) => {
    if (button === active) return
    const ref = clipRef(button)
    if (!ref) return
    const rect = button.parentElement?.getBoundingClientRect()
    if (!rect) return
    values.push(rect.left + ref.startAt * parseZoom())
    values.push(rect.left + (ref.startAt + ref.duration) * parseZoom())
  })
  const playhead = document.querySelector<HTMLElement>('.maghrabi-playhead')
  if (playhead) {
    const rect = playhead.getBoundingClientRect()
    values.push(rect.left + rect.width / 2)
  }
  timeline.querySelectorAll<HTMLElement>('.maghrabi-marker').forEach((marker) => {
    const rect = marker.getBoundingClientRect()
    values.push(rect.left + rect.width / 2)
  })
  return Array.from(new Set(values.map((value) => Math.round(value * 10) / 10)))
}

function snappedStart(
  desiredStartAt: number,
  duration: number,
  lane: LaneSurface,
  active: HTMLElement,
  bypassSnap: boolean,
): SnapResult {
  const zoom = parseZoom()
  const startAt = quantizeToFrame(desiredStartAt)
  if (bypassSnap) return { startAt, clientX: null, label: '' }
  const rect = lane.surface.getBoundingClientRect()
  const left = rect.left + startAt * zoom
  const right = left + duration * zoom
  let bestDistance = Number.POSITIVE_INFINITY
  let bestOffsetPx = 0
  let bestClientX: number | null = null
  let label = ''
  for (const candidate of snapCandidates(active)) {
    const toIn = candidate - left
    const inDistance = Math.abs(toIn)
    if (inDistance < bestDistance) {
      bestDistance = inDistance
      bestOffsetPx = toIn
      bestClientX = candidate
      label = 'SNAP IN'
    }
    const toOut = candidate - right
    const outDistance = Math.abs(toOut)
    if (outDistance < bestDistance) {
      bestDistance = outDistance
      bestOffsetPx = toOut
      bestClientX = candidate
      label = 'SNAP OUT'
    }
  }
  if (bestDistance > SNAP_THRESHOLD_PX || bestClientX === null) return { startAt, clientX: null, label: '' }
  return {
    startAt: quantizeToFrame(Math.max(0, startAt + bestOffsetPx / zoom)),
    clientX: bestClientX,
    label,
  }
}

function overlapsAnother(button: HTMLButtonElement, lane: LaneSurface, startAt: number, duration: number) {
  const endAt = startAt + duration
  return Array.from(lane.surface.querySelectorAll<HTMLButtonElement>('button.maghrabi-pro-clip')).some((other) => {
    if (other === button) return false
    const ref = clipRef(other)
    if (!ref) return false
    const otherEnd = ref.startAt + ref.duration
    return startAt < otherEnd - .01 && endAt > ref.startAt + .01
  })
}

function findVideo(project: ProjectShape, ref: ClipRef) {
  const clips = Array.isArray(project.clips) ? project.clips : []
  const candidates = clips.filter((clip) => clip?.lane === ref.lane && (ref.fileIndex === null || clip.fileIndex === ref.fileIndex))
  return candidates.sort((a, b) => Math.abs(a.startAt - ref.startAt) - Math.abs(b.startAt - ref.startAt))[0] || null
}

function findAudio(project: ProjectShape, ref: ClipRef) {
  const tracks = Array.isArray(project.audioTracks) ? project.audioTracks : []
  const named = tracks.filter((track) => track?.lane === ref.lane && (!ref.name || !track.name || ref.name.includes(track.name)))
  const candidates = named.length ? named : tracks.filter((track) => track?.lane === ref.lane)
  return candidates.sort((a, b) => Math.abs(a.startAt - ref.startAt) - Math.abs(b.startAt - ref.startAt))[0] || null
}

function syncEnabled(project: ProjectShape, lane: LaneKey) {
  return project.trackStates?.[lane]?.syncLock !== false
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

async function commitMove(ref: ClipRef, lane: LaneKey, startAt: number, duplicate: boolean) {
  const projectId = getActiveStudioProjectId()
  if (!projectId) return false
  const snapshot = await flushEditorSave(projectId)
  if (!snapshot) return false
  const project = JSON.parse(JSON.stringify(snapshot.project || {})) as ProjectShape
  project.clips = Array.isArray(project.clips) ? project.clips : []
  project.audioTracks = Array.isArray(project.audioTracks) ? project.audioTracks : []

  if (ref.kind === 'video' && isVideoLane(lane)) {
    const clip = findVideo(project, ref)
    if (!clip) return false
    const delta = startAt - clip.startAt
    if (duplicate) {
      const newClip: VideoClip = { ...clip, id: uid(), lane, startAt, groupId: null }
      if (clip.detachedTrackId) {
        const linked = project.audioTracks.find((track) => track.id === clip.detachedTrackId)
        if (linked) {
          const newAudioId = uid()
          const newAudio: AudioClip = { ...linked, id: newAudioId, startAt: Math.max(0, linked.startAt + delta), linkedClipId: newClip.id }
          project.audioTracks.push(newAudio)
          newClip.detachedTrackId = newAudioId
        }
      }
      project.clips.push(newClip)
    } else {
      const oldLane = clip.lane
      clip.lane = lane
      clip.startAt = startAt
      if (clip.detachedTrackId && syncEnabled(project, oldLane)) {
        const linked = project.audioTracks.find((track) => track.id === clip.detachedTrackId)
        if (linked && syncEnabled(project, linked.lane)) linked.startAt = Math.max(0, linked.startAt + delta)
      }
    }
  } else if (ref.kind === 'audio' && isAudioLane(lane)) {
    const track = findAudio(project, ref)
    if (!track) return false
    const delta = startAt - track.startAt
    if (duplicate) {
      project.audioTracks.push({ ...track, id: uid(), lane, startAt, linkedClipId: null })
    } else {
      const oldLane = track.lane
      track.lane = lane
      track.startAt = startAt
      if (track.linkedClipId && syncEnabled(project, oldLane)) {
        const linked = project.clips.find((clip) => clip.id === track.linkedClipId)
        if (linked && syncEnabled(project, linked.lane)) linked.startAt = Math.max(0, linked.startAt + delta)
      }
    }
  } else return false

  const next: StoredVideoProject<ProjectShape> = {
    ...snapshot,
    project,
    savedAt: new Date().toISOString(),
  }
  await saveStoredVideoProject(next, projectId)
  window.setTimeout(clickRestore, 70)
  return true
}

function setZoom(value: number) {
  const input = zoomInput()
  if (!input) return
  const min = Number(input.min) || 5
  const max = Number(input.max) || 30
  const next = Math.round(clamp(value, min, max))
  input.value = String(next)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function fitTimeline() {
  const scroller = timelineScroller()
  const timeline = timelineRoot()
  if (!scroller || !timeline) return false
  const zoom = parseZoom()
  let duration = 0
  timeline.querySelectorAll<HTMLButtonElement>('button.maghrabi-pro-clip').forEach((button) => {
    const ref = clipRef(button)
    if (ref) duration = Math.max(duration, ref.startAt + ref.duration)
  })
  if (duration <= .01) return false
  const available = Math.max(260, scroller.clientWidth - HEADER_WIDTH - 36)
  setZoom(available / duration)
  window.requestAnimationFrame(() => { scroller.scrollLeft = 0 })
  return true
}

function showSnapGuide(clientX: number | null, label = 'SNAP') {
  const guide = document.querySelector<HTMLElement>('.maghrabi-snap-guide')
  const timeline = timelineRoot()
  if (!guide || !timeline) return
  if (clientX === null) {
    guide.classList.remove('is-visible')
    return
  }
  const rect = timeline.getBoundingClientRect()
  guide.style.left = `${clientX - rect.left}px`
  guide.dataset.label = label
  guide.classList.add('is-visible')
}

function autoScroll(clientX: number) {
  const scroller = timelineScroller()
  if (!scroller) return
  const rect = scroller.getBoundingClientRect()
  const edge = 64
  if (clientX < rect.left + edge) {
    const strength = 1 - clamp((clientX - rect.left) / edge, 0, 1)
    scroller.scrollLeft = Math.max(0, scroller.scrollLeft - 10 - 28 * strength)
  } else if (clientX > rect.right - edge) {
    const strength = 1 - clamp((rect.right - clientX) / edge, 0, 1)
    scroller.scrollLeft += 10 + 28 * strength
  }
}

export default function StudioTimelineInteractionPro() {
  const [message, setMessage] = useState('')

  useEffect(() => {
    let observer: MutationObserver | null = null
    let refreshFrame = 0
    let activeCleanup: (() => void) | null = null

    const announce = (text: string) => {
      setMessage(text)
      window.setTimeout(() => setMessage((current) => current === text ? '' : current), 2200)
    }

    const refresh = () => {
      window.cancelAnimationFrame(refreshFrame)
      refreshFrame = window.requestAnimationFrame(() => {
        const timeline = timelineRoot()
        if (!timeline) return
        const scroller = timeline.parentElement as HTMLElement | null
        timeline.classList.add('maghrabi-timeline-pro-root')
        timeline.style.minWidth = '100%'
        timeline.style.setProperty('--maghrabi-second', `${parseZoom()}px`)
        scroller?.classList.add('maghrabi-timeline-pro-scroller')

        laneSurfaces(timeline).forEach((item) => {
          item.row.classList.add('maghrabi-pro-lane-row')
          item.header.classList.add('maghrabi-pro-lane-header')
          item.surface.classList.add('maghrabi-pro-lane-surface')
          item.surface.dataset.maghrabiLane = item.lane
          item.surface.classList.toggle('is-locked', item.locked)
        })

        const adjustment = Array.from(timeline.children).find((child) => child instanceof HTMLElement && child.className.includes('h-[52px]')) as HTMLElement | undefined
        if (adjustment) {
          const header = adjustment.firstElementChild
          const surface = adjustment.lastElementChild
          if (header instanceof HTMLElement) header.classList.add('maghrabi-pro-lane-header')
          if (surface instanceof HTMLElement) surface.classList.add('maghrabi-pro-adjustment-surface')
        }

        const clips = Array.from(timeline.querySelectorAll<HTMLButtonElement>('button[style*="left"][style*="width"]'))
          .filter((button) => /^(V[123]|A[123])\s*·/.test(firstClipLabel(button)))
        clips.forEach((button) => {
          button.classList.add('maghrabi-pro-clip')
          const ref = clipRef(button)
          if (!ref) return
          button.dataset.maghrabiKind = ref.kind
          button.dataset.maghrabiLane = ref.lane
          button.dataset.maghrabiDuration = String(ref.duration)
          const accurateWidth = Math.max(8, ref.duration * parseZoom())
          if (!document.body.classList.contains('maghrabi-direct-moving') && Math.abs((Number.parseFloat(button.style.width) || 0) - accurateWidth) > .5) {
            button.style.width = `${accurateWidth}px`
          }
          button.title = `${ref.lane} · ${formatTime(ref.startAt)} · ${formatTime(ref.duration)} | Drag to move · Edge handles to trim · Alt+Drag copy`
        })

        let empty = timeline.querySelector<HTMLElement>('.maghrabi-timeline-empty-hint')
        if (!clips.length) {
          if (!empty) {
            empty = document.createElement('div')
            empty.className = 'maghrabi-timeline-empty-hint'
            empty.innerHTML = '<strong>DROP MEDIA TO START EDITING</strong><span>اسحب المقطع إلى V1/V2/V3 · أو انقر مرتين على الفيديو لإدراجه عند Playhead</span><small>Drag = Move · Edge = Trim · Alt+Drag = Copy · Ctrl/Cmd+Drag = Free move · Shift+Z = Fit timeline</small>'
            timeline.appendChild(empty)
          }
        } else empty?.remove()

        document.querySelectorAll<HTMLButtonElement>(`${ROOT} button[draggable="true"]`).forEach((button) => {
          if (button.classList.contains('maghrabi-pro-clip')) return
          const badge = (button.querySelector('span')?.textContent || '').trim()
          if (/^V\d+$/.test(badge)) {
            button.classList.add('maghrabi-media-asset-pro')
            button.title = 'اسحب إلى Timeline · Double-click للإدراج عند Playhead'
          }
        })
      })
    }

    const startDirectMove = (event: PointerEvent, button: HTMLButtonElement) => {
      if (event.button !== 0 || button.draggable === false || event.target instanceof HTMLElement && event.target.closest('.maghrabi-trim-handle')) return
      const ref = clipRef(button)
      if (!ref) return
      const originLane = laneSurfaces().find((item) => item.lane === ref.lane)
      if (!originLane || originLane.locked) return

      event.preventDefault()
      event.stopPropagation()
      button.click()

      const pointerId = event.pointerId
      const startX = event.clientX
      const startY = event.clientY
      const buttonRect = button.getBoundingClientRect()
      const grabFraction = clamp((event.clientX - buttonRect.left) / Math.max(1, buttonRect.width), 0, 1)
      const grabOffsetTime = ref.duration * grabFraction
      const originalLeft = button.style.left
      const originalTransform = button.style.transform
      const originTop = originLane.surface.getBoundingClientRect().top
      let targetLane = originLane
      let targetStartAt = ref.startAt
      let dragging = false
      let duplicate = event.altKey
      let collision = false
      let ghost: HTMLElement | null = null

      const badge = document.createElement('div')
      badge.className = 'maghrabi-direct-drag-badge'
      document.body.appendChild(badge)

      const preventNativeDrag = (dragEvent: DragEvent) => {
        dragEvent.preventDefault()
        dragEvent.stopPropagation()
      }
      window.addEventListener('dragstart', preventNativeDrag, true)

      const onMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return
        const distance = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY)
        if (!dragging && distance < MOVE_THRESHOLD_PX) return
        if (!dragging) {
          dragging = true
          document.body.classList.add('maghrabi-direct-moving')
          button.classList.add('maghrabi-direct-dragging')
          ghost = document.createElement('div')
          ghost.className = 'maghrabi-drag-origin-ghost'
          ghost.style.left = originalLeft
          ghost.style.width = `${Math.max(8, ref.duration * parseZoom())}px`
          originLane.surface.appendChild(ghost)
        }

        moveEvent.preventDefault()
        autoScroll(moveEvent.clientX)
        duplicate = moveEvent.altKey
        targetLane = laneAtY(ref.kind, moveEvent.clientY, originLane, moveEvent.shiftKey)
        laneSurfaces().forEach((item) => item.surface.classList.toggle('is-direct-target', item.lane === targetLane.lane))
        const laneRect = targetLane.surface.getBoundingClientRect()
        const pointerTime = (moveEvent.clientX - laneRect.left) / parseZoom()
        const desired = Math.max(0, pointerTime - grabOffsetTime)
        const snapped = snappedStart(desired, ref.duration, targetLane, button, moveEvent.ctrlKey || moveEvent.metaKey)
        targetStartAt = snapped.startAt
        showSnapGuide(snapped.clientX, snapped.label)

        const topDelta = targetLane.surface.getBoundingClientRect().top - originTop
        button.style.left = `${targetStartAt * parseZoom()}px`
        button.style.transform = `translateY(${topDelta}px)`
        button.classList.toggle('is-copy', duplicate)
        collision = overlapsAnother(button, targetLane, targetStartAt, ref.duration)
        button.classList.toggle('is-collision', collision)

        badge.style.left = `${clamp(moveEvent.clientX + 14, 8, window.innerWidth - 188)}px`
        badge.style.top = `${clamp(moveEvent.clientY - 44, 8, window.innerHeight - 54)}px`
        badge.innerHTML = `<strong>${duplicate ? 'COPY' : 'MOVE'} · ${targetLane.lane}</strong><span>${formatTime(targetStartAt)}${snapped.clientX !== null ? ' · SNAP' : ''}${collision ? ' · OVERLAP' : ''}</span>`
      }

      const cleanup = () => {
        window.removeEventListener('pointermove', onMove, true)
        window.removeEventListener('pointerup', onUp, true)
        window.removeEventListener('pointercancel', onCancel, true)
        window.removeEventListener('dragstart', preventNativeDrag, true)
        laneSurfaces().forEach((item) => item.surface.classList.remove('is-direct-target'))
        document.body.classList.remove('maghrabi-direct-moving')
        button.classList.remove('maghrabi-direct-dragging', 'is-copy', 'is-collision', 'is-committing')
        ghost?.remove()
        badge.remove()
        showSnapGuide(null)
        activeCleanup = null
      }

      const restorePreview = () => {
        button.style.left = originalLeft
        button.style.transform = originalTransform
      }

      const onUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return
        if (!dragging) {
          cleanup()
          return
        }
        upEvent.preventDefault()
        upEvent.stopPropagation()
        button.classList.add('is-committing')
        const finalLane = targetLane.lane
        const finalStart = targetStartAt
        const finalDuplicate = duplicate || upEvent.altKey
        void commitMove(ref, finalLane, finalStart, finalDuplicate)
          .then((ok) => {
            if (!ok) restorePreview()
            announce(ok
              ? `${finalDuplicate ? 'تم نسخ' : 'تم تحريك'} المقطع إلى ${finalLane} عند ${formatTime(finalStart)}${collision ? ' · يوجد تداخل زمني' : ''}`
              : 'تعذر حفظ موضع المقطع الجديد')
          })
          .catch(() => {
            restorePreview()
            announce('تعذر حفظ موضع المقطع الجديد')
          })
          .finally(() => window.setTimeout(cleanup, 120))
      }

      const onCancel = (cancelEvent: PointerEvent) => {
        if (cancelEvent.pointerId !== pointerId) return
        restorePreview()
        cleanup()
      }

      activeCleanup?.()
      activeCleanup = () => {
        restorePreview()
        cleanup()
      }
      window.addEventListener('pointermove', onMove, true)
      window.addEventListener('pointerup', onUp, true)
      window.addEventListener('pointercancel', onCancel, true)
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      const button = target?.closest<HTMLButtonElement>('button.maghrabi-pro-clip')
      if (!button) return
      startDirectMove(event, button)
    }

    const onDoubleClick = (event: MouseEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target?.closest('.maghrabi-time-ruler')) {
        event.preventDefault()
        if (fitTimeline()) announce('تم ضبط Timeline على كامل المشروع')
        return
      }
      const button = target?.closest<HTMLButtonElement>('button.maghrabi-media-asset-pro')
      if (!button) return
      window.setTimeout(() => {
        const insert = editorButtons().find((item) => /TO PATCH/i.test((item.textContent || '').trim()))
        if (insert && !insert.disabled) {
          insert.click()
          announce('تم إدراج الفيديو عند Playhead')
        }
      }, 0)
    }

    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (event.shiftKey && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (fitTimeline()) announce('FIT TIMELINE')
        return
      }
      if (!event.ctrlKey && !event.metaKey && !event.altKey && (event.key === '=' || event.key === '+')) {
        event.preventDefault()
        setZoom(parseZoom() + 2)
        return
      }
      if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key === '-') {
        event.preventDefault()
        setZoom(parseZoom() - 2)
        return
      }
      if (event.key === 'Delete' && !event.shiftKey) {
        const trash = editorButtons().find((button) => !button.disabled && Boolean(button.querySelector('svg.lucide-trash-2')))
        if (trash) {
          event.preventDefault()
          trash.click()
          announce('تم حذف العنصر المحدد')
        }
      }
    }

    const onZoom = () => refresh()
    const onProject = () => window.setTimeout(refresh, 100)

    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('dblclick', onDoubleClick, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('maghrabi-active-project-changed', onProject)
    zoomInput()?.addEventListener('input', onZoom)
    observer = new MutationObserver((mutations) => {
      if (document.body.classList.contains('maghrabi-direct-moving')) return
      const meaningful = mutations.some((mutation) => mutation.type === 'childList' || mutation.type === 'attributes')
      if (meaningful) refresh()
    })
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    window.setTimeout(refresh, 80)

    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('dblclick', onDoubleClick, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('maghrabi-active-project-changed', onProject)
      zoomInput()?.removeEventListener('input', onZoom)
      observer?.disconnect()
      activeCleanup?.()
      window.cancelAnimationFrame(refreshFrame)
      document.querySelector('.maghrabi-timeline-empty-hint')?.remove()
    }
  }, [])

  return message ? <div className="maghrabi-timeline-pro-toast" dir="rtl">{message}</div> : null
}
