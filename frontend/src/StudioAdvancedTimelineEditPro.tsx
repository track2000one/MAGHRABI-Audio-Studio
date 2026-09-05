import { useEffect, useRef, useState } from 'react'
import { Layers3, MoveHorizontal, X } from 'lucide-react'
import { getActiveStudioProjectId } from './lib/projectHubStore'
import { loadStoredVideoProject, saveStoredVideoProject, type StoredVideoProject } from './lib/projectStore'
import './studioAdvancedTimelineEdit.css'

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
  groupId?: string | null
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

type MoveTarget = { ref: ClipRef; lane: LaneKey; startAt: number }

type Commands = {
  group: () => void
  ungroup: () => void
  clear: () => void
}

const ROOT = '.maghrabi-studio-pro main'
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

function parseZoom() {
  const spans = Array.from(document.querySelectorAll<HTMLSpanElement>(`${ROOT} span`))
  for (const span of spans) {
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

function firstClipLabel(button: HTMLButtonElement) {
  return (button.querySelector('span')?.textContent || '').trim()
}

function parseClock(value: string) {
  const match = value.trim().match(/^(\d+):(\d+(?:\.\d+)?)$/)
  if (!match) return Number.NaN
  return Number(match[1]) * 60 + Number(match[2])
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
  const fileMatch = label.match(/^V[123]\s*·\s*V(\d+)/)
  return {
    kind: isVideoLane(lane) ? 'video' : 'audio',
    lane,
    startAt: Math.max(0, (Number.parseFloat(button.style.left || '0') || 0) / zoom),
    duration: clipDurationFromButton(button, zoom),
    fileIndex: fileMatch ? Math.max(0, Number(fileMatch[1]) - 1) : null,
    name: laneMatch[2].trim(),
    element: button,
  }
}

function timelineRoot() {
  return document.querySelector<HTMLElement>('.maghrabi-time-ruler')?.parentElement || null
}

function timelineScroller() {
  return timelineRoot()?.parentElement as HTMLElement | null
}

function laneSurface(lane: LaneKey) {
  return document.querySelector<HTMLElement>(`.maghrabi-pro-lane-surface[data-maghrabi-lane="${lane}"]`)
}

function laneLocked(project: ProjectShape, lane: LaneKey) {
  return project.trackStates?.[lane]?.locked === true
}

function syncEnabled(project: ProjectShape, lane: LaneKey) {
  return project.trackStates?.[lane]?.syncLock !== false
}

function findVideo(project: ProjectShape, ref: ClipRef, used = new Set<string>()) {
  const clips = Array.isArray(project.clips) ? project.clips : []
  return clips
    .filter((clip) => !used.has(clip.id) && clip.lane === ref.lane && (ref.fileIndex === null || clip.fileIndex === ref.fileIndex))
    .sort((a, b) => Math.abs(a.startAt - ref.startAt) - Math.abs(b.startAt - ref.startAt))[0] || null
}

function findAudio(project: ProjectShape, ref: ClipRef, used = new Set<string>()) {
  const tracks = Array.isArray(project.audioTracks) ? project.audioTracks : []
  const lane = tracks.filter((track) => !used.has(track.id) && track.lane === ref.lane)
  const named = lane.filter((track) => !ref.name || !track.name || ref.name.includes(track.name))
  return (named.length ? named : lane)
    .sort((a, b) => Math.abs(a.startAt - ref.startAt) - Math.abs(b.startAt - ref.startAt))[0] || null
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

async function saveMutation(mutator: (project: ProjectShape, snapshot: StoredVideoProject<ProjectShape>) => boolean) {
  const projectId = getActiveStudioProjectId()
  if (!projectId) return false
  const snapshot = await flushEditorSave(projectId)
  if (!snapshot) return false
  const project = JSON.parse(JSON.stringify(snapshot.project || {})) as ProjectShape
  project.clips = Array.isArray(project.clips) ? project.clips : []
  project.audioTracks = Array.isArray(project.audioTracks) ? project.audioTracks : []
  if (!mutator(project, snapshot)) return false
  await saveStoredVideoProject({ ...snapshot, project, savedAt: new Date().toISOString() }, projectId)
  window.setTimeout(clickRestore, 70)
  return true
}

function compatibleLaneShift(kind: ClipRef['kind'], from: LaneKey, activeFrom: LaneKey, activeTo: LaneKey) {
  const lanes: LaneKey[] = kind === 'video' ? ['V1', 'V2', 'V3'] : ['A1', 'A2', 'A3']
  const shift = lanes.indexOf(activeTo) - lanes.indexOf(activeFrom)
  const index = clamp(lanes.indexOf(from) + shift, 0, lanes.length - 1)
  return lanes[index]
}

function laneAtY(kind: ClipRef['kind'], clientY: number, fallback: LaneKey) {
  const lanes: LaneKey[] = kind === 'video' ? ['V1', 'V2', 'V3'] : ['A1', 'A2', 'A3']
  for (const lane of lanes) {
    const surface = laneSurface(lane)
    if (!surface || surface.classList.contains('is-locked')) continue
    const rect = surface.getBoundingClientRect()
    if (clientY >= rect.top && clientY <= rect.bottom) return lane
  }
  return fallback
}

function snapCandidates(excluded: Set<HTMLButtonElement>) {
  const values: number[] = []
  document.querySelectorAll<HTMLButtonElement>('button.maghrabi-pro-clip').forEach((button) => {
    if (excluded.has(button)) return
    const ref = clipRef(button)
    const surface = ref ? laneSurface(ref.lane) : null
    if (!ref || !surface) return
    const rect = surface.getBoundingClientRect()
    values.push(rect.left + ref.startAt * parseZoom(), rect.left + (ref.startAt + ref.duration) * parseZoom())
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

function snapActiveStart(desired: number, ref: ClipRef, targetLane: LaneKey, excluded: Set<HTMLButtonElement>, bypass: boolean) {
  const quantized = Math.max(0, Math.round(desired / FRAME) * FRAME)
  if (bypass) return { startAt: quantized, clientX: null as number | null }
  const surface = laneSurface(targetLane)
  if (!surface) return { startAt: quantized, clientX: null as number | null }
  const zoom = parseZoom()
  const rect = surface.getBoundingClientRect()
  const left = rect.left + quantized * zoom
  const right = left + ref.duration * zoom
  let best: { distance: number; offset: number; clientX: number } | null = null
  for (const candidate of snapCandidates(excluded)) {
    for (const edge of [left, right]) {
      const offset = candidate - edge
      const distance = Math.abs(offset)
      if (!best || distance < best.distance) best = { distance, offset, clientX: candidate }
    }
  }
  if (!best || best.distance > SNAP_THRESHOLD_PX) return { startAt: quantized, clientX: null as number | null }
  return {
    startAt: Math.max(0, Math.round((quantized + best.offset / zoom) / FRAME) * FRAME),
    clientX: best.clientX,
  }
}

function showSnapGuide(clientX: number | null, label = 'MULTI SNAP') {
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
  const edge = 72
  if (clientX < rect.left + edge) scroller.scrollLeft = Math.max(0, scroller.scrollLeft - 24)
  else if (clientX > rect.right - edge) scroller.scrollLeft += 24
}

async function commitGroupMove(targets: MoveTarget[], duplicate: boolean) {
  return saveMutation((project) => {
    const usedVideo = new Set<string>()
    const usedAudio = new Set<string>()
    const resolved = targets.map((target) => {
      if (target.ref.kind === 'video') {
        const clip = findVideo(project, target.ref, usedVideo)
        if (clip) usedVideo.add(clip.id)
        return { ...target, video: clip, audio: null as AudioClip | null }
      }
      const track = findAudio(project, target.ref, usedAudio)
      if (track) usedAudio.add(track.id)
      return { ...target, video: null as VideoClip | null, audio: track }
    })
    if (resolved.some((item) => !item.video && !item.audio)) return false
    if (resolved.some((item) => laneLocked(project, item.lane))) return false

    const selectedVideoIds = new Set(resolved.flatMap((item) => item.video ? [item.video.id] : []))
    const selectedAudioIds = new Set(resolved.flatMap((item) => item.audio ? [item.audio.id] : []))

    if (!duplicate) {
      for (const item of resolved) {
        if (item.video && isVideoLane(item.lane)) {
          const clip = item.video
          const delta = item.startAt - clip.startAt
          const oldLane = clip.lane
          clip.lane = item.lane
          clip.startAt = item.startAt
          if (clip.detachedTrackId && !selectedAudioIds.has(clip.detachedTrackId) && syncEnabled(project, oldLane)) {
            const linked = project.audioTracks?.find((track) => track.id === clip.detachedTrackId)
            if (linked && syncEnabled(project, linked.lane)) linked.startAt = Math.max(0, linked.startAt + delta)
          }
        } else if (item.audio && isAudioLane(item.lane)) {
          const track = item.audio
          const delta = item.startAt - track.startAt
          const oldLane = track.lane
          track.lane = item.lane
          track.startAt = item.startAt
          if (track.linkedClipId && !selectedVideoIds.has(track.linkedClipId) && syncEnabled(project, oldLane)) {
            const linked = project.clips?.find((clip) => clip.id === track.linkedClipId)
            if (linked && syncEnabled(project, linked.lane)) linked.startAt = Math.max(0, linked.startAt + delta)
          }
        }
      }
      return true
    }

    const idMap = new Map<string, string>()
    resolved.forEach((item) => {
      if (item.video) idMap.set(item.video.id, uid())
      if (item.audio) idMap.set(item.audio.id, uid())
    })
    const groupMap = new Map<string, string>()
    const mappedGroup = (groupId?: string | null) => {
      if (!groupId) return null
      if (!groupMap.has(groupId)) groupMap.set(groupId, `group-${uid()}`)
      return groupMap.get(groupId) || null
    }

    const newVideos: VideoClip[] = []
    const newAudios: AudioClip[] = []
    for (const item of resolved) {
      if (item.video && isVideoLane(item.lane)) {
        const source = item.video
        const clone: VideoClip = {
          ...source,
          id: idMap.get(source.id) || uid(),
          lane: item.lane,
          startAt: item.startAt,
          groupId: mappedGroup(source.groupId),
          detachedTrackId: source.detachedTrackId && idMap.has(source.detachedTrackId) ? idMap.get(source.detachedTrackId) || null : null,
        }
        if (source.detachedTrackId && !selectedAudioIds.has(source.detachedTrackId)) {
          const linked = project.audioTracks?.find((track) => track.id === source.detachedTrackId)
          if (linked) {
            const newAudioId = uid()
            newAudios.push({
              ...linked,
              id: newAudioId,
              startAt: Math.max(0, linked.startAt + (item.startAt - source.startAt)),
              linkedClipId: clone.id,
              groupId: mappedGroup(linked.groupId),
            })
            clone.detachedTrackId = newAudioId
          }
        }
        newVideos.push(clone)
      } else if (item.audio && isAudioLane(item.lane)) {
        const source = item.audio
        newAudios.push({
          ...source,
          id: idMap.get(source.id) || uid(),
          lane: item.lane,
          startAt: item.startAt,
          groupId: mappedGroup(source.groupId),
          linkedClipId: source.linkedClipId && idMap.has(source.linkedClipId) ? idMap.get(source.linkedClipId) || null : null,
        })
      }
    }
    project.clips?.push(...newVideos)
    project.audioTracks?.push(...newAudios)
    return true
  })
}

async function commitGrouping(refs: ClipRef[], ungroup: boolean) {
  return saveMutation((project) => {
    const usedVideo = new Set<string>()
    const usedAudio = new Set<string>()
    const groupId = ungroup ? null : `group-${uid()}`
    let changed = 0
    for (const ref of refs) {
      if (ref.kind === 'video') {
        const clip = findVideo(project, ref, usedVideo)
        if (!clip) continue
        usedVideo.add(clip.id)
        clip.groupId = groupId
        changed += 1
      } else {
        const track = findAudio(project, ref, usedAudio)
        if (!track) continue
        usedAudio.add(track.id)
        track.groupId = groupId
        changed += 1
      }
    }
    return changed > 0
  })
}

async function commitDelete(refs: ClipRef[]) {
  return saveMutation((project) => {
    const usedVideo = new Set<string>()
    const usedAudio = new Set<string>()
    const videoIds = new Set<string>()
    const audioIds = new Set<string>()
    refs.forEach((ref) => {
      if (ref.kind === 'video') {
        const clip = findVideo(project, ref, usedVideo)
        if (clip) { usedVideo.add(clip.id); videoIds.add(clip.id) }
      } else {
        const track = findAudio(project, ref, usedAudio)
        if (track) { usedAudio.add(track.id); audioIds.add(track.id) }
      }
    })
    if (!videoIds.size && !audioIds.size) return false
    project.clips = (project.clips || []).filter((clip) => !videoIds.has(clip.id))
    project.audioTracks = (project.audioTracks || []).filter((track) => !audioIds.has(track.id))
    project.clips.forEach((clip) => { if (clip.detachedTrackId && audioIds.has(clip.detachedTrackId)) clip.detachedTrackId = null })
    project.audioTracks.forEach((track) => { if (track.linkedClipId && videoIds.has(track.linkedClipId)) track.linkedClipId = null })
    return true
  })
}

export default function StudioAdvancedTimelineEditPro() {
  const [selectedCount, setSelectedCount] = useState(0)
  const [message, setMessage] = useState('')
  const commands = useRef<Commands>({ group: () => undefined, ungroup: () => undefined, clear: () => undefined })

  useEffect(() => {
    const selected = new Set<HTMLButtonElement>()
    let anchor: HTMLButtonElement | null = null
    let activeCleanup: (() => void) | null = null
    let decorateTimer = 0

    const announce = (text: string) => {
      setMessage(text)
      window.setTimeout(() => setMessage((current) => current === text ? '' : current), 2200)
    }

    const syncClasses = () => {
      document.querySelectorAll<HTMLButtonElement>('button.maghrabi-pro-clip').forEach((button) => {
        const isSelected = selected.has(button)
        button.classList.toggle('maghrabi-multi-selected', isSelected)
        button.setAttribute('aria-selected', isSelected ? 'true' : 'false')
      })
      setSelectedCount(selected.size)
    }

    const clear = () => {
      selected.clear()
      anchor = null
      syncClasses()
    }

    const add = (button: HTMLButtonElement) => {
      if (!button.isConnected) return
      selected.add(button)
      anchor = button
      syncClasses()
    }

    const currentRefs = () => Array.from(selected).filter((button) => button.isConnected).map(clipRef).filter((ref): ref is ClipRef => Boolean(ref))

    const selectGroup = (button: HTMLButtonElement) => {
      const groupId = button.dataset.maghrabiGroup
      if (!groupId) return false
      clear()
      document.querySelectorAll<HTMLButtonElement>(`button.maghrabi-pro-clip[data-maghrabi-group="${CSS.escape(groupId)}"]`).forEach((item) => selected.add(item))
      anchor = button
      syncClasses()
      return selected.size > 1
    }

    const decorateGroups = () => {
      window.clearTimeout(decorateTimer)
      decorateTimer = window.setTimeout(async () => {
        const projectId = getActiveStudioProjectId()
        if (!projectId) return
        const snapshot = await loadStoredVideoProject<ProjectShape>(projectId).catch(() => null)
        if (!snapshot) return
        const project = snapshot.project || {}
        const usedVideo = new Set<string>()
        const usedAudio = new Set<string>()
        document.querySelectorAll<HTMLButtonElement>('button.maghrabi-pro-clip').forEach((button) => {
          const ref = clipRef(button)
          if (!ref) return
          const item = ref.kind === 'video' ? findVideo(project, ref, usedVideo) : findAudio(project, ref, usedAudio)
          if (item) {
            if (ref.kind === 'video') usedVideo.add(item.id)
            else usedAudio.add(item.id)
          }
          const groupId = item?.groupId || ''
          button.dataset.maghrabiGroup = groupId
          button.classList.toggle('maghrabi-is-grouped', Boolean(groupId))
        })
      }, 120)
    }

    const doGroup = () => {
      const refs = currentRefs()
      if (refs.length < 2) { announce('حدد مقطعين أو أكثر لإنشاء Group'); return }
      void commitGrouping(refs, false).then((ok) => {
        announce(ok ? `تم تجميع ${refs.length} مقاطع` : 'تعذر إنشاء Group')
        if (ok) window.setTimeout(decorateGroups, 130)
      })
    }

    const doUngroup = () => {
      const refs = currentRefs()
      if (!refs.length) { announce('حدد المقاطع المراد فك تجميعها'); return }
      void commitGrouping(refs, true).then((ok) => {
        announce(ok ? 'تم فك التجميع' : 'تعذر فك التجميع')
        if (ok) window.setTimeout(decorateGroups, 130)
      })
    }

    commands.current = { group: doGroup, ungroup: doUngroup, clear }

    const startGroupMove = (event: PointerEvent, button: HTMLButtonElement) => {
      const refs = currentRefs()
      const active = clipRef(button)
      if (!active || refs.length < 2) return
      const allSameKind = refs.every((ref) => ref.kind === active.kind)
      const selectedButtons = new Set(refs.map((ref) => ref.element))
      const originals = refs.map((ref) => ({ ref, left: ref.element.style.left, transform: ref.element.style.transform }))
      const pointerId = event.pointerId
      const startX = event.clientX
      const startY = event.clientY
      const rect = button.getBoundingClientRect()
      const grabTime = active.duration * clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1)
      const minStart = Math.min(...refs.map((ref) => ref.startAt))
      let dragging = false
      let delta = 0
      let activeTargetLane = active.lane
      let duplicate = event.altKey

      const badge = document.createElement('div')
      badge.className = 'maghrabi-multi-drag-badge'
      document.body.appendChild(badge)

      const onMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return
        const distance = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY)
        if (!dragging && distance < MOVE_THRESHOLD_PX) return
        if (!dragging) {
          dragging = true
          document.body.classList.add('maghrabi-multi-moving')
          refs.forEach((ref) => ref.element.classList.add('maghrabi-multi-dragging'))
        }
        moveEvent.preventDefault()
        moveEvent.stopPropagation()
        autoScroll(moveEvent.clientX)
        duplicate = moveEvent.altKey
        activeTargetLane = allSameKind && !moveEvent.shiftKey ? laneAtY(active.kind, moveEvent.clientY, active.lane) : active.lane
        const activeSurface = laneSurface(activeTargetLane)
        if (!activeSurface) return
        const laneRect = activeSurface.getBoundingClientRect()
        const desired = Math.max(0, (moveEvent.clientX - laneRect.left) / parseZoom() - grabTime)
        const snapped = snapActiveStart(desired, active, activeTargetLane, selectedButtons, moveEvent.ctrlKey || moveEvent.metaKey)
        delta = snapped.startAt - active.startAt
        if (minStart + delta < 0) delta = -minStart
        showSnapGuide(snapped.clientX)

        refs.forEach((ref) => {
          const targetLane = allSameKind ? compatibleLaneShift(ref.kind, ref.lane, active.lane, activeTargetLane) : ref.lane
          const originSurface = laneSurface(ref.lane)
          const targetSurface = laneSurface(targetLane)
          const topDelta = originSurface && targetSurface ? targetSurface.getBoundingClientRect().top - originSurface.getBoundingClientRect().top : 0
          ref.element.style.left = `${Math.max(0, ref.startAt + delta) * parseZoom()}px`
          ref.element.style.transform = `translateY(${topDelta}px)`
          ref.element.classList.toggle('is-copy', duplicate)
        })

        badge.style.left = `${clamp(moveEvent.clientX + 14, 8, window.innerWidth - 210)}px`
        badge.style.top = `${clamp(moveEvent.clientY - 48, 8, window.innerHeight - 58)}px`
        badge.innerHTML = `<strong>${duplicate ? 'COPY' : 'MOVE'} · ${refs.length} CLIPS</strong><span>${formatTime(Math.max(0, active.startAt + delta))}${snapped.clientX !== null ? ' · SNAP' : ''}</span>`
      }

      const restore = () => originals.forEach(({ ref, left, transform }) => { ref.element.style.left = left; ref.element.style.transform = transform })
      const cleanup = () => {
        window.removeEventListener('pointermove', onMove, true)
        window.removeEventListener('pointerup', onUp, true)
        window.removeEventListener('pointercancel', onCancel, true)
        document.body.classList.remove('maghrabi-multi-moving')
        refs.forEach((ref) => ref.element.classList.remove('maghrabi-multi-dragging', 'is-copy'))
        badge.remove()
        showSnapGuide(null)
        activeCleanup = null
      }
      const onUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return
        if (!dragging) { cleanup(); return }
        upEvent.preventDefault()
        upEvent.stopPropagation()
        const targets: MoveTarget[] = refs.map((ref) => ({
          ref,
          lane: allSameKind ? compatibleLaneShift(ref.kind, ref.lane, active.lane, activeTargetLane) : ref.lane,
          startAt: Math.max(0, ref.startAt + delta),
        }))
        void commitGroupMove(targets, duplicate || upEvent.altKey).then((ok) => {
          if (!ok) restore()
          announce(ok ? `${duplicate || upEvent.altKey ? 'تم نسخ' : 'تم تحريك'} ${refs.length} مقاطع معًا` : 'تعذر حفظ حركة المجموعة')
          clear()
        }).catch(() => {
          restore()
          announce('تعذر حفظ حركة المجموعة')
        }).finally(() => window.setTimeout(cleanup, 100))
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

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target?.closest('.maghrabi-trim-handle')) return
      const button = target?.closest<HTMLButtonElement>('button.maghrabi-pro-clip')
      if (!button) {
        if (!event.ctrlKey && !event.metaKey && !event.shiftKey && selected.size) clear()
        return
      }

      if (event.ctrlKey || event.metaKey) {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        if (selected.has(button)) selected.delete(button)
        else { selected.add(button); anchor = button }
        button.click()
        syncClasses()
        announce(`${selected.size} مقطع محدد`)
        return
      }

      if (event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        const current = clipRef(button)
        const anchorRef = anchor ? clipRef(anchor) : null
        if (current && anchorRef && current.lane === anchorRef.lane) {
          const start = Math.min(current.startAt, anchorRef.startAt)
          const end = Math.max(current.startAt, anchorRef.startAt)
          document.querySelectorAll<HTMLButtonElement>(`button.maghrabi-pro-clip[data-maghrabi-lane="${current.lane}"]`).forEach((item) => {
            const ref = clipRef(item)
            if (ref && ref.startAt >= start - .01 && ref.startAt <= end + .01) selected.add(item)
          })
        } else selected.add(button)
        anchor = button
        button.click()
        syncClasses()
        announce(`${selected.size} مقطع محدد`)
        return
      }

      if (!selected.has(button) && button.dataset.maghrabiGroup) selectGroup(button)
      if (selected.size > 1 && selected.has(button)) {
        startGroupMove(event, button)
        return
      }

      if (selected.size) clear()
      add(button)
    }

    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      const mod = event.ctrlKey || event.metaKey
      if (mod && event.key.toLowerCase() === 'g') {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (event.shiftKey) doUngroup()
        else doGroup()
        return
      }
      if (event.key === 'Escape' && selected.size) {
        event.preventDefault()
        clear()
        return
      }
      if (event.key === 'Delete' && selected.size > 1) {
        event.preventDefault()
        event.stopImmediatePropagation()
        const refs = currentRefs()
        void commitDelete(refs).then((ok) => {
          announce(ok ? `تم حذف ${refs.length} مقاطع` : 'تعذر حذف المقاطع المحددة')
          if (ok) clear()
        })
      }
    }

    const onSnapshot = () => window.setTimeout(decorateGroups, 100)
    const observer = new MutationObserver(() => decorateGroups())
    observer.observe(document.body, { childList: true, subtree: true })
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('maghrabi-project-snapshot-changed', onSnapshot as EventListener)
    window.addEventListener('maghrabi-active-project-changed', onSnapshot)
    decorateGroups()

    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('maghrabi-project-snapshot-changed', onSnapshot as EventListener)
      window.removeEventListener('maghrabi-active-project-changed', onSnapshot)
      observer.disconnect()
      window.clearTimeout(decorateTimer)
      activeCleanup?.()
      selected.forEach((button) => button.classList.remove('maghrabi-multi-selected'))
    }
  }, [])

  return <>
    {selectedCount > 1 && <div className="maghrabi-multi-toolbar" dir="ltr">
      <span className="maghrabi-multi-count"><MoveHorizontal className="h-3.5 w-3.5" />{selectedCount} SELECTED</span>
      <button onClick={() => commands.current.group()} title="Group · Ctrl/Cmd+G"><Layers3 className="h-3.5 w-3.5" />GROUP</button>
      <button onClick={() => commands.current.ungroup()} title="Ungroup · Ctrl/Cmd+Shift+G">UNGROUP</button>
      <button onClick={() => commands.current.clear()} title="Clear selection · Esc"><X className="h-3.5 w-3.5" /></button>
    </div>}
    {message && <div className="maghrabi-advanced-edit-toast" dir="rtl">{message}</div>}
  </>
}
