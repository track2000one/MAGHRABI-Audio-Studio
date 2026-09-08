import { useEffect } from 'react'
import { getActiveStudioProjectId } from './lib/projectHubStore'
import { loadStoredVideoProject, saveStoredVideoProject, type StoredVideoProject } from './lib/projectStore'

type VideoLane = 'V1' | 'V2' | 'V3'
type AudioLane = 'A1' | 'A2' | 'A3'
type LaneKey = VideoLane | AudioLane

type TrackState = { syncLock?: boolean }
type VideoClip = {
  id: string
  lane: VideoLane
  fileIndex: number
  startAt: number
  detachedTrackId?: string | null
  groupId?: string | null
  [key: string]: unknown
}
type AudioClip = {
  id: string
  lane: AudioLane
  fileIndex: number
  startAt: number
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
}

type LaneSurface = { lane: LaneKey; surface: HTMLElement; locked: boolean }

const SNAP_KEY = 'maghrabi-studio-snap-enabled-v1'
const MOVE_THRESHOLD_PX = 2
const SNAP_THRESHOLD_PX = 6
const VIDEO_FRAME = 1 / 30

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

function compatible(kind: ClipRef['kind'], lane: LaneKey) {
  return kind === 'video' ? isVideoLane(lane) : isAudioLane(lane)
}

function parseZoom() {
  for (const span of Array.from(document.querySelectorAll<HTMLSpanElement>('.maghrabi-studio-pro main span'))) {
    const match = (span.textContent || '').match(/([\d.]+)\s*px\/s/i)
    if (match) return Math.max(1, Number(match[1]) || 12)
  }
  return 12
}

function formatTime(seconds: number) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const minutes = Math.floor(safe / 60)
  return `${String(minutes).padStart(2, '0')}:${(safe - minutes * 60).toFixed(2).padStart(5, '0')}`
}

function firstLabel(button: HTMLButtonElement) {
  return (button.querySelector('span')?.textContent || '').trim()
}

function clipRef(button: HTMLButtonElement): ClipRef | null {
  const label = firstLabel(button)
  const match = label.match(/^(V[123]|A[123])\s*·\s*(.*)$/)
  if (!match) return null
  const lane = match[1]
  if (!isVideoLane(lane) && !isAudioLane(lane)) return null
  const zoom = parseZoom()
  const durationFromData = Number(button.dataset.maghrabiDuration)
  const width = Number.parseFloat(button.style.width || '0') || button.getBoundingClientRect().width
  const duration = Number.isFinite(durationFromData) && durationFromData > 0 ? durationFromData : Math.max(VIDEO_FRAME, width / zoom)
  const fileMatch = label.match(/^V[123]\s*·\s*V(\d+)/)
  return {
    kind: isVideoLane(lane) ? 'video' : 'audio',
    lane,
    startAt: Math.max(0, (Number.parseFloat(button.style.left || '0') || 0) / zoom),
    duration,
    fileIndex: fileMatch ? Math.max(0, Number(fileMatch[1]) - 1) : null,
    name: match[2].trim(),
  }
}

function laneSurfaces(): LaneSurface[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.maghrabi-pro-lane-surface[data-maghrabi-lane]'))
    .map((surface) => {
      const lane = surface.dataset.maghrabiLane || ''
      if (!isVideoLane(lane) && !isAudioLane(lane)) return null
      return { lane, surface, locked: surface.classList.contains('is-locked') }
    })
    .filter((item): item is LaneSurface => Boolean(item))
}

function laneAtY(kind: ClipRef['kind'], clientY: number, fallback: LaneSurface, lockLane: boolean) {
  if (lockLane) return fallback
  return laneSurfaces().find((item) => {
    if (!compatible(kind, item.lane) || item.locked) return false
    const rect = item.surface.getBoundingClientRect()
    return clientY >= rect.top && clientY <= rect.bottom
  }) || fallback
}

function snapEnabled() {
  return localStorage.getItem(SNAP_KEY) !== '0'
}

function quantize(time: number, kind: ClipRef['kind']) {
  if (kind === 'audio') return Math.max(0, Math.round(time * 1000) / 1000)
  return Math.max(0, Math.round(time / VIDEO_FRAME) * VIDEO_FRAME)
}

function timelineScroller() {
  return document.querySelector<HTMLElement>('.maghrabi-timeline-pro-scroller')
}

function snapCandidates(active: HTMLButtonElement) {
  const values: number[] = []
  document.querySelectorAll<HTMLButtonElement>('button.maghrabi-pro-clip').forEach((button) => {
    if (button === active) return
    const rect = button.getBoundingClientRect()
    values.push(rect.left, rect.right)
  })
  const playhead = document.querySelector<HTMLElement>('.maghrabi-playhead')
  if (playhead) {
    const rect = playhead.getBoundingClientRect()
    values.push(rect.left + rect.width / 2)
  }
  document.querySelectorAll<HTMLElement>('.maghrabi-marker').forEach((marker) => {
    const rect = marker.getBoundingClientRect()
    values.push(rect.left + rect.width / 2)
  })
  return values
}

function snapStart(desired: number, ref: ClipRef, lane: LaneSurface, active: HTMLButtonElement, bypass: boolean) {
  const base = quantize(desired, ref.kind)
  if (bypass || !snapEnabled()) return { startAt: base, clientX: null as number | null, label: '' }
  const zoom = parseZoom()
  const rect = lane.surface.getBoundingClientRect()
  const left = rect.left + base * zoom
  const right = left + ref.duration * zoom
  let best = Number.POSITIVE_INFINITY
  let offset = 0
  let clientX: number | null = null
  let label = ''
  for (const candidate of snapCandidates(active)) {
    const inDelta = candidate - left
    if (Math.abs(inDelta) < best) {
      best = Math.abs(inDelta); offset = inDelta; clientX = candidate; label = 'SNAP IN'
    }
    const outDelta = candidate - right
    if (Math.abs(outDelta) < best) {
      best = Math.abs(outDelta); offset = outDelta; clientX = candidate; label = 'SNAP OUT'
    }
  }
  if (best > SNAP_THRESHOLD_PX || clientX === null) return { startAt: base, clientX: null, label: '' }
  return { startAt: quantize(Math.max(0, base + offset / zoom), ref.kind), clientX, label }
}

function showSnapGuide(clientX: number | null, label = '') {
  const guide = document.querySelector<HTMLElement>('.maghrabi-snap-guide')
  const timeline = document.querySelector<HTMLElement>('.maghrabi-timeline-pro-root')
  if (!guide || !timeline) return
  if (clientX === null) {
    guide.classList.remove('is-visible')
    return
  }
  const rect = timeline.getBoundingClientRect()
  guide.style.left = `${clientX - rect.left}px`
  guide.dataset.label = label || 'SNAP'
  guide.classList.add('is-visible')
}

function editorButton(text: string) {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.maghrabi-studio-pro main button'))
    .find((button) => (button.textContent || '').includes(text))
}

function clickRestore() {
  editorButton('استعادة')?.click()
}

function snapshotPromise(projectId: string) {
  const save = editorButton('حفظ')
  if (!save || save.disabled) return loadStoredVideoProject<ProjectShape>(projectId)
  return new Promise<StoredVideoProject<ProjectShape> | null>((resolve) => {
    let settled = false
    let timer = 0
    const finish = async () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      window.removeEventListener('maghrabi-project-snapshot-changed', onSaved as EventListener)
      resolve(await loadStoredVideoProject<ProjectShape>(projectId))
    }
    const onSaved = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string | null }>).detail
      if (detail?.projectId && detail.projectId !== projectId) return
      void finish()
    }
    window.addEventListener('maghrabi-project-snapshot-changed', onSaved as EventListener)
    save.click()
    timer = window.setTimeout(() => void finish(), 500)
  })
}

function syncEnabled(project: ProjectShape, lane: LaneKey) {
  return project.trackStates?.[lane]?.syncLock !== false
}

function findVideo(project: ProjectShape, ref: ClipRef) {
  const clips = Array.isArray(project.clips) ? project.clips : []
  const candidates = clips.filter((clip) => clip.lane === ref.lane && (ref.fileIndex === null || clip.fileIndex === ref.fileIndex))
  return candidates.sort((a, b) => Math.abs(a.startAt - ref.startAt) - Math.abs(b.startAt - ref.startAt))[0] || null
}

function findAudio(project: ProjectShape, ref: ClipRef) {
  const tracks = Array.isArray(project.audioTracks) ? project.audioTracks : []
  const named = tracks.filter((track) => track.lane === ref.lane && (!ref.name || !track.name || ref.name.includes(track.name)))
  const candidates = named.length ? named : tracks.filter((track) => track.lane === ref.lane)
  return candidates.sort((a, b) => Math.abs(a.startAt - ref.startAt) - Math.abs(b.startAt - ref.startAt))[0] || null
}

async function persistMove(
  baseSnapshot: Promise<StoredVideoProject<ProjectShape> | null>,
  projectId: string,
  ref: ClipRef,
  lane: LaneKey,
  startAt: number,
  duplicate: boolean,
) {
  const snapshot = await baseSnapshot
  if (!snapshot) return false
  const project = JSON.parse(JSON.stringify(snapshot.project || {})) as ProjectShape
  project.clips = Array.isArray(project.clips) ? project.clips : []
  project.audioTracks = Array.isArray(project.audioTracks) ? project.audioTracks : []

  if (ref.kind === 'video' && isVideoLane(lane)) {
    const clip = findVideo(project, ref)
    if (!clip) return false
    const delta = startAt - clip.startAt
    if (duplicate) {
      const copy: VideoClip = { ...clip, id: uid(), lane, startAt, groupId: null }
      if (clip.detachedTrackId) {
        const linked = project.audioTracks.find((track) => track.id === clip.detachedTrackId)
        if (linked) {
          const audioId = uid()
          project.audioTracks.push({ ...linked, id: audioId, startAt: Math.max(0, linked.startAt + delta), linkedClipId: copy.id })
          copy.detachedTrackId = audioId
        }
      }
      project.clips.push(copy)
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
    if (duplicate) project.audioTracks.push({ ...track, id: uid(), lane, startAt, linkedClipId: null })
    else {
      const oldLane = track.lane
      track.lane = lane
      track.startAt = startAt
      if (track.linkedClipId && syncEnabled(project, oldLane)) {
        const linked = project.clips.find((clip) => clip.id === track.linkedClipId)
        if (linked && syncEnabled(project, linked.lane)) linked.startAt = Math.max(0, linked.startAt + delta)
      }
    }
  } else return false

  await saveStoredVideoProject({ ...snapshot, project, savedAt: new Date().toISOString() }, projectId)
  return true
}

export default function StudioTimelineFluidMovePro() {
  useEffect(() => {
    let cleanupActive: (() => void) | null = null

    const patchSnapTitle = () => {
      const toggle = document.querySelector<HTMLButtonElement>('.maghrabi-snap-toggle')
      if (toggle) toggle.title = 'Magnetic Snap · Ctrl/Cmd أثناء السحب = Free Move · Alt = Duplicate · Shift = Lock Lane'
    }
    const titleTimer = window.setInterval(patchSnapTitle, 900)
    patchSnapTitle()

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (!target || target.closest('.maghrabi-trim-handle')) return
      const button = target.closest<HTMLButtonElement>('button.maghrabi-pro-clip')
      if (!button || button.draggable === false) return
      const ref = clipRef(button)
      if (!ref) return
      const originLane = laneSurfaces().find((item) => item.lane === ref.lane)
      if (!originLane || originLane.locked) return

      // Window capture runs before the legacy document handler. Own the gesture here.
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()

      const projectId = getActiveStudioProjectId()
      if (!projectId) return
      const baseSnapshot = snapshotPromise(projectId)
      button.click()

      const pointerId = event.pointerId
      const startX = event.clientX
      const startY = event.clientY
      const originalLeft = button.style.left
      const originalTransform = button.style.transform
      const originRect = originLane.surface.getBoundingClientRect()
      const buttonRect = button.getBoundingClientRect()
      const grabOffsetPx = event.clientX - buttonRect.left
      let targetLane = originLane
      let targetStartAt = ref.startAt
      let dragging = false
      let lastX = event.clientX
      let lastY = event.clientY
      let lastCtrl = event.ctrlKey || event.metaKey
      let lastAlt = event.altKey
      let lastShift = event.shiftKey
      let raf = 0
      let scrollRaf = 0
      let ghost: HTMLDivElement | null = null

      const badge = document.createElement('div')
      badge.className = 'maghrabi-direct-drag-badge'
      document.body.appendChild(badge)

      const render = () => {
        raf = 0
        if (!dragging) return
        targetLane = laneAtY(ref.kind, lastY, originLane, lastShift)
        const zoom = parseZoom()
        const laneRect = targetLane.surface.getBoundingClientRect()
        const desired = Math.max(0, (lastX - laneRect.left - grabOffsetPx) / zoom)
        const snapped = snapStart(desired, ref, targetLane, button, lastCtrl)
        targetStartAt = snapped.startAt
        showSnapGuide(snapped.clientX, snapped.label)
        laneSurfaces().forEach((item) => item.surface.classList.toggle('is-direct-target', item.lane === targetLane.lane))

        const topDelta = targetLane.surface.getBoundingClientRect().top - originRect.top
        button.style.left = `${targetStartAt * zoom}px`
        button.style.transform = `translate3d(0, ${topDelta}px, 0)`
        button.classList.toggle('is-copy', lastAlt)

        badge.style.left = `${clamp(lastX + 14, 8, window.innerWidth - 198)}px`
        badge.style.top = `${clamp(lastY - 48, 8, window.innerHeight - 58)}px`
        badge.innerHTML = `<strong>${lastAlt ? 'DUPLICATE' : 'MOVE'} · ${targetLane.lane}</strong><span>${formatTime(targetStartAt)}${snapped.clientX !== null ? ' · SNAP' : lastCtrl ? ' · FREE' : ''}${lastShift ? ' · LANE LOCK' : ''}</span>`
      }

      const requestRender = () => {
        if (!raf) raf = window.requestAnimationFrame(render)
      }

      const scrollLoop = () => {
        if (!dragging) return
        const scroller = timelineScroller()
        if (scroller) {
          const rect = scroller.getBoundingClientRect()
          const edge = 86
          let delta = 0
          if (lastX < rect.left + edge) {
            const strength = 1 - clamp((lastX - rect.left) / edge, 0, 1)
            delta = -(3 + 20 * strength)
          } else if (lastX > rect.right - edge) {
            const strength = 1 - clamp((rect.right - lastX) / edge, 0, 1)
            delta = 3 + 20 * strength
          }
          if (delta) {
            scroller.scrollLeft = Math.max(0, scroller.scrollLeft + delta)
            requestRender()
          }
        }
        scrollRaf = window.requestAnimationFrame(scrollLoop)
      }

      const onMove = (move: PointerEvent) => {
        if (move.pointerId !== pointerId) return
        const distance = Math.hypot(move.clientX - startX, move.clientY - startY)
        if (!dragging && distance < MOVE_THRESHOLD_PX) return
        move.preventDefault()
        move.stopPropagation()
        move.stopImmediatePropagation()
        if (!dragging) {
          dragging = true
          document.body.classList.add('maghrabi-direct-moving')
          button.classList.add('maghrabi-direct-dragging')
          ghost = document.createElement('div')
          ghost.className = 'maghrabi-drag-origin-ghost'
          ghost.style.left = originalLeft
          ghost.style.width = `${Math.max(8, ref.duration * parseZoom())}px`
          originLane.surface.appendChild(ghost)
          scrollRaf = window.requestAnimationFrame(scrollLoop)
        }
        lastX = move.clientX
        lastY = move.clientY
        lastCtrl = move.ctrlKey || move.metaKey
        lastAlt = move.altKey
        lastShift = move.shiftKey
        requestRender()
      }

      const restorePreview = () => {
        button.style.left = originalLeft
        button.style.transform = originalTransform
      }

      const cleanup = () => {
        window.removeEventListener('pointermove', onMove, true)
        window.removeEventListener('pointerup', onUp, true)
        window.removeEventListener('pointercancel', onCancel, true)
        if (raf) window.cancelAnimationFrame(raf)
        if (scrollRaf) window.cancelAnimationFrame(scrollRaf)
        document.body.classList.remove('maghrabi-direct-moving')
        button.classList.remove('maghrabi-direct-dragging', 'is-copy', 'is-committing')
        laneSurfaces().forEach((item) => item.surface.classList.remove('is-direct-target'))
        ghost?.remove()
        badge.remove()
        showSnapGuide(null)
        cleanupActive = null
      }

      const onUp = (up: PointerEvent) => {
        if (up.pointerId !== pointerId) return
        up.preventDefault()
        up.stopPropagation()
        up.stopImmediatePropagation()
        if (!dragging) {
          cleanup()
          return
        }
        if (raf) {
          window.cancelAnimationFrame(raf)
          raf = 0
          render()
        }
        const finalLane = targetLane.lane
        const finalStart = targetStartAt
        const duplicate = lastAlt || up.altKey
        button.classList.add('is-committing')
        void persistMove(baseSnapshot, projectId, ref, finalLane, finalStart, duplicate)
          .then((ok) => {
            if (!ok) restorePreview()
            else window.setTimeout(clickRestore, 20)
          })
          .catch(() => restorePreview())
          .finally(() => window.setTimeout(cleanup, 80))
      }

      const onCancel = (cancel: PointerEvent) => {
        if (cancel.pointerId !== pointerId) return
        cancel.preventDefault()
        restorePreview()
        cleanup()
      }

      cleanupActive?.()
      cleanupActive = () => {
        restorePreview()
        cleanup()
      }
      window.addEventListener('pointermove', onMove, true)
      window.addEventListener('pointerup', onUp, true)
      window.addEventListener('pointercancel', onCancel, true)
    }

    window.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.clearInterval(titleTimer)
      cleanupActive?.()
    }
  }, [])

  return null
}
