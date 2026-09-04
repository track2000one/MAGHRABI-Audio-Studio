import { useEffect, useState } from 'react'
import { MoveHorizontal, SlidersHorizontal } from 'lucide-react'
import { getActiveStudioProjectId } from './lib/projectHubStore'
import { loadStoredVideoProject, saveStoredVideoProject, type StoredVideoProject } from './lib/projectStore'
import './studioPrecisionEdit.css'

type VideoClip = {
  id: string
  lane: 'V1' | 'V2' | 'V3'
  fileIndex: number
  startAt: number
  start: number
  end: number
  speed: number
  freezeFrame?: boolean
  freezeDuration?: number
}

type AudioClip = {
  id: string
  lane: 'A1' | 'A2' | 'A3'
  fileIndex: number
  startAt: number
  sourceStart: number
  sourceEnd: number
  name?: string
}

type ProjectShape = {
  clips?: VideoClip[]
  audioTracks?: AudioClip[]
  [key: string]: unknown
}

type SelectedRef = {
  kind: 'video' | 'audio'
  lane: string
  startAt: number
  fileIndex: number | null
  element: HTMLButtonElement
}

const FRAME = 1 / 30
const ROOT = '.maghrabi-studio-pro main'

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function parseZoom() {
  const spans = Array.from(document.querySelectorAll<HTMLSpanElement>(`${ROOT} span`))
  for (const span of spans) {
    const match = (span.textContent || '').match(/([\d.]+)\s*px\/s/i)
    if (match) return Math.max(1, Number(match[1]) || 12)
  }
  return 12
}

function clipDuration(clip: VideoClip) {
  if (clip.freezeFrame) return Math.max(.2, clip.freezeDuration || 2)
  return Math.max(.02, (clip.end - clip.start) / Math.max(.25, clip.speed || 1))
}

function videoEnd(clip: VideoClip) { return clip.startAt + clipDuration(clip) }

function selectedElement() {
  const video = document.querySelector<HTMLButtonElement>(`${ROOT} button.border-violet-100[style*="left"]`)
  if (video) return video
  return document.querySelector<HTMLButtonElement>(`${ROOT} button.border-cyan-100[style*="left"]`)
}

function selectedRef(): SelectedRef | null {
  const element = selectedElement()
  if (!element) return null
  const text = (element.textContent || '').trim()
  const laneMatch = text.match(/^(V[123]|A[123])\s*·/)
  if (!laneMatch) return null
  const lane = laneMatch[1]
  const zoom = parseZoom()
  const left = Number.parseFloat(element.style.left || '0') || 0
  const fileMatch = text.match(/·\s*V(\d+)/)
  return {
    kind: lane.startsWith('V') ? 'video' : 'audio',
    lane,
    startAt: Math.max(0, left / zoom),
    fileIndex: fileMatch ? Math.max(0, Number(fileMatch[1]) - 1) : null,
    element,
  }
}

function editorButtons() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(`${ROOT} button`))
}

function clickRestore() {
  const button = editorButtons().find((item) => (item.textContent || '').includes('استعادة'))
  button?.click()
}

async function flushEditorSave() {
  const id = getActiveStudioProjectId()
  if (!id) return null
  const saveButton = editorButtons().find((item) => (item.textContent || '').includes('حفظ'))
  if (!saveButton) return loadStoredVideoProject<ProjectShape>(id)

  const confirmed = new Promise<void>((resolve) => {
    let timer = 0
    const finish = () => {
      window.clearTimeout(timer)
      window.removeEventListener('maghrabi-project-snapshot-changed', onSaved as EventListener)
      resolve()
    }
    const onSaved = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string | null }>).detail
      if (detail?.projectId && detail.projectId !== id) return
      finish()
    }
    window.addEventListener('maghrabi-project-snapshot-changed', onSaved as EventListener)
    timer = window.setTimeout(finish, 1800)
  })
  saveButton.click()
  await confirmed
  return loadStoredVideoProject<ProjectShape>(id)
}

function findVideo(project: ProjectShape, ref: SelectedRef) {
  const clips = Array.isArray(project.clips) ? project.clips : []
  const candidates = clips.filter((clip) => clip?.lane === ref.lane && (ref.fileIndex === null || clip.fileIndex === ref.fileIndex))
  return candidates.sort((a, b) => Math.abs(a.startAt - ref.startAt) - Math.abs(b.startAt - ref.startAt))[0] || null
}

function findAudio(project: ProjectShape, ref: SelectedRef) {
  const tracks = Array.isArray(project.audioTracks) ? project.audioTracks : []
  const candidates = tracks.filter((track) => track?.lane === ref.lane)
  return candidates.sort((a, b) => Math.abs(a.startAt - ref.startAt) - Math.abs(b.startAt - ref.startAt))[0] || null
}

async function mutateProject(mutator: (snapshot: StoredVideoProject<ProjectShape>) => boolean) {
  const id = getActiveStudioProjectId()
  if (!id) return false
  const snapshot = await flushEditorSave()
  if (!snapshot) return false
  const project = JSON.parse(JSON.stringify(snapshot.project || {})) as ProjectShape
  const next: StoredVideoProject<ProjectShape> = { ...snapshot, project, savedAt: new Date().toISOString() }
  if (!mutator(next)) return false
  await saveStoredVideoProject(next, id)
  window.setTimeout(clickRestore, 70)
  return true
}

export default function StudioPrecisionEditPro() {
  const [selection, setSelection] = useState<SelectedRef | null>(null)
  const [message, setMessage] = useState('')

  const announce = (text: string) => {
    setMessage(text)
    window.setTimeout(() => setMessage((current) => current === text ? '' : current), 1800)
  }

  const precisionTrim = async (ref: SelectedRef, edge: 'in' | 'out', deltaTimeline: number) => {
    const ok = await mutateProject((snapshot) => {
      const project = snapshot.project
      if (ref.kind === 'video') {
        const clip = findVideo(project, ref)
        if (!clip) return false
        const sourceDuration = snapshot.videoDurations?.[clip.fileIndex] || clip.end
        const speed = Math.max(.25, clip.speed || 1)
        if (edge === 'in') {
          const requested = clip.start + deltaTimeline * speed
          const nextStart = clamp(requested, 0, clip.end - .05)
          const appliedTimeline = (nextStart - clip.start) / speed
          clip.start = nextStart
          clip.startAt = Math.max(0, clip.startAt + appliedTimeline)
        } else {
          clip.end = clamp(clip.end + deltaTimeline * speed, clip.start + .05, sourceDuration)
        }
        return true
      }
      const track = findAudio(project, ref)
      if (!track) return false
      const sourceDuration = snapshot.audioDurations?.[track.fileIndex] || track.sourceEnd
      if (edge === 'in') {
        const nextStart = clamp(track.sourceStart + deltaTimeline, 0, track.sourceEnd - .05)
        const applied = nextStart - track.sourceStart
        track.sourceStart = nextStart
        track.startAt = Math.max(0, track.startAt + applied)
      } else {
        track.sourceEnd = clamp(track.sourceEnd + deltaTimeline, track.sourceStart + .05, sourceDuration)
      }
      return true
    })
    announce(ok ? `${edge === 'in' ? 'TRIM IN' : 'TRIM OUT'} applied` : 'تعذر تنفيذ Trim')
  }

  const slip = async (direction: -1 | 1, frames = 1) => {
    const ref = selectedRef()
    if (!ref || ref.kind !== 'video') { announce('حدد Video Clip أولاً'); return }
    const delta = direction * FRAME * frames
    const ok = await mutateProject((snapshot) => {
      const clip = findVideo(snapshot.project, ref)
      if (!clip) return false
      const sourceDuration = snapshot.videoDurations?.[clip.fileIndex] || clip.end
      const minDelta = -clip.start
      const maxDelta = sourceDuration - clip.end
      const applied = clamp(delta, minDelta, maxDelta)
      if (Math.abs(applied) < .0001) return false
      clip.start += applied
      clip.end += applied
      return true
    })
    announce(ok ? `SLIP ${direction < 0 ? '←' : '→'} ${frames}F` : 'لا توجد مساحة Source كافية للـSlip')
  }

  const slide = async (direction: -1 | 1, frames = 1) => {
    const ref = selectedRef()
    if (!ref || ref.kind !== 'video') { announce('حدد Video Clip أولاً'); return }
    const requested = direction * FRAME * frames
    const ok = await mutateProject((snapshot) => {
      const project = snapshot.project
      const selected = findVideo(project, ref)
      if (!selected) return false
      const lane = (project.clips || []).filter((clip) => clip.lane === selected.lane).sort((a, b) => a.startAt - b.startAt)
      const index = lane.findIndex((clip) => clip.id === selected.id)
      if (index <= 0 || index >= lane.length - 1) return false
      const prev = lane[index - 1]
      const next = lane[index + 1]
      const selectedEnd = videoEnd(selected)
      if (Math.abs(videoEnd(prev) - selected.startAt) > .12 || Math.abs(next.startAt - selectedEnd) > .12) return false

      const prevSpeed = Math.max(.25, prev.speed || 1)
      const nextSpeed = Math.max(.25, next.speed || 1)
      const prevSourceDuration = snapshot.videoDurations?.[prev.fileIndex] || prev.end
      const maxPositive = Math.min(
        Math.max(0, (prevSourceDuration - prev.end) / prevSpeed),
        Math.max(0, (next.end - next.start - .05) / nextSpeed),
      )
      const maxNegative = Math.min(
        Math.max(0, (prev.end - prev.start - .05) / prevSpeed),
        Math.max(0, next.start / nextSpeed),
      )
      const applied = clamp(requested, -maxNegative, maxPositive)
      if (Math.abs(applied) < .0001) return false

      prev.end += applied * prevSpeed
      selected.startAt += applied
      next.startAt += applied
      next.start += applied * nextSpeed
      return true
    })
    announce(ok ? `SLIDE ${direction < 0 ? '←' : '→'} ${frames}F` : 'Slide يحتاج Clip متصل قبله وبعده ومساحة Trim كافية')
  }

  useEffect(() => {
    let cleanupHandles: (() => void) | null = null
    let frame = 0

    const enhance = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        cleanupHandles?.()
        cleanupHandles = null
        const ref = selectedRef()
        setSelection(ref)
        if (!ref) return
        const button = ref.element
        button.querySelectorAll('.maghrabi-trim-handle').forEach((node) => node.remove())

        const listeners: Array<() => void> = []
        const addHandle = (edge: 'in' | 'out') => {
          const handle = document.createElement('span')
          handle.className = `maghrabi-trim-handle is-${edge}`
          handle.title = edge === 'in' ? 'Trim In · اسحب الحافة' : 'Trim Out · اسحب الحافة'
          handle.setAttribute('role', 'slider')
          button.appendChild(handle)

          const onDown = (event: PointerEvent) => {
            if (event.button !== 0) return
            event.preventDefault()
            event.stopPropagation()
            const startX = event.clientX
            const originalLeft = Number.parseFloat(button.style.left || '0') || 0
            const originalWidth = Number.parseFloat(button.style.width || '0') || button.getBoundingClientRect().width
            const zoom = parseZoom()
            document.body.classList.add('maghrabi-precision-trimming')
            handle.classList.add('is-active')

            const onMove = (moveEvent: PointerEvent) => {
              moveEvent.preventDefault()
              const delta = moveEvent.clientX - startX
              if (edge === 'in') {
                const appliedPx = Math.min(originalWidth - 10, delta)
                button.style.left = `${originalLeft + appliedPx}px`
                button.style.width = `${Math.max(10, originalWidth - appliedPx)}px`
              } else {
                button.style.width = `${Math.max(10, originalWidth + delta)}px`
              }
            }
            const finish = (upEvent: PointerEvent) => {
              document.removeEventListener('pointermove', onMove)
              document.removeEventListener('pointerup', finish)
              document.body.classList.remove('maghrabi-precision-trimming')
              handle.classList.remove('is-active')
              const deltaTimeline = (upEvent.clientX - startX) / zoom
              button.style.left = `${originalLeft}px`
              button.style.width = `${originalWidth}px`
              if (Math.abs(deltaTimeline) > .01) void precisionTrim(ref, edge, deltaTimeline)
            }
            document.addEventListener('pointermove', onMove, { passive: false })
            document.addEventListener('pointerup', finish, { once: true })
          }
          handle.addEventListener('pointerdown', onDown)
          listeners.push(() => handle.removeEventListener('pointerdown', onDown))
        }
        addHandle('in')
        addHandle('out')
        cleanupHandles = () => {
          listeners.forEach((remove) => remove())
          button.querySelectorAll('.maghrabi-trim-handle').forEach((node) => node.remove())
        }
      })
    }

    const observer = new MutationObserver(enhance)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    enhance()
    return () => {
      observer.disconnect()
      window.cancelAnimationFrame(frame)
      cleanupHandles?.()
      document.body.classList.remove('maghrabi-precision-trimming')
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target?.closest('input,textarea,select,[contenteditable="true"]')) return
      if (!event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
      event.preventDefault()
      const direction = event.key === 'ArrowLeft' ? -1 : 1
      if (event.shiftKey) void slide(direction, 1)
      else void slip(direction, 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className={`maghrabi-precision-edit${selection?.kind === 'video' ? ' has-video' : selection?.kind === 'audio' ? ' has-audio' : ''}`} dir="ltr">
      <span className="maghrabi-precision-title"><SlidersHorizontal className="h-3.5 w-3.5"/>PRECISION</span>
      {selection?.kind === 'video' ? <>
        <button onClick={() => void slip(-1)} title="Slip source left one frame · Alt+←">SLIP ◀ 1F</button>
        <button onClick={() => void slip(1)} title="Slip source right one frame · Alt+→">SLIP 1F ▶</button>
        <span className="maghrabi-precision-divider"/>
        <button onClick={() => void slide(-1)} title="Slide clip left one frame · Alt+Shift+←"><MoveHorizontal className="h-3 w-3"/>SLIDE ◀</button>
        <button onClick={() => void slide(1)} title="Slide clip right one frame · Alt+Shift+→"><MoveHorizontal className="h-3 w-3"/>SLIDE ▶</button>
      </> : <span className="maghrabi-precision-hint">{selection?.kind === 'audio' ? 'Drag clip edges to trim audio' : 'Select a clip for Trim / Slip / Slide'}</span>}
      {message && <span className="maghrabi-precision-message">{message}</span>}
    </div>
  )
}
