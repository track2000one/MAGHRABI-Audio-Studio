import { useEffect, useState } from 'react'
import { getActiveStudioProjectId } from './lib/projectHubStore'
import { loadStoredVideoProject, saveStoredVideoProject, type StoredVideoProject } from './lib/projectStore'
import './studioTransitionsPro.css'

type VideoLane = 'V1' | 'V2' | 'V3'
type TransitionType =
  | 'none'
  | 'fade'
  | 'fadeblack'
  | 'fadewhite'
  | 'dissolve'
  | 'wipeleft'
  | 'wiperight'
  | 'slideleft'
  | 'slideright'
  | 'smoothleft'
  | 'smoothright'
  | 'circleopen'
  | 'circleclose'
  | 'pixelize'

type TransitionOut = {
  type: TransitionType
  duration: number
  rightFileIndex?: number
  rightSourceStart?: number
}

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
  transitionOut?: TransitionOut | null
  [key: string]: unknown
}

type ProjectShape = {
  clips?: VideoClip[]
  [key: string]: unknown
}

type ClipRef = {
  lane: VideoLane
  startAt: number
  duration: number
  fileIndex: number | null
  element?: HTMLButtonElement
}

type ActiveCut = {
  left: ClipRef
  right: ClipRef
  type: TransitionType
  duration: number
  x: number
  y: number
}

const ROOT = '.maghrabi-studio-pro main'
const MIN_DURATION = .08
const MAX_DURATION = 1.5
const DEFAULT_DURATION = .4
const CUT_TOLERANCE = .16

const TRANSITIONS: Array<{ value: TransitionType; label: string; short: string }> = [
  { value: 'dissolve', label: 'Dissolve', short: 'DS' },
  { value: 'fade', label: 'Cross Fade', short: 'FD' },
  { value: 'fadeblack', label: 'Fade Black', short: 'BK' },
  { value: 'fadewhite', label: 'Fade White', short: 'WT' },
  { value: 'wipeleft', label: 'Wipe Left', short: 'WL' },
  { value: 'wiperight', label: 'Wipe Right', short: 'WR' },
  { value: 'slideleft', label: 'Slide Left', short: 'SL' },
  { value: 'slideright', label: 'Slide Right', short: 'SR' },
  { value: 'smoothleft', label: 'Smooth Left', short: 'ML' },
  { value: 'smoothright', label: 'Smooth Right', short: 'MR' },
  { value: 'circleopen', label: 'Circle Open', short: 'CO' },
  { value: 'circleclose', label: 'Circle Close', short: 'CC' },
  { value: 'pixelize', label: 'Pixelize', short: 'PX' },
]

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function parseZoom() {
  const spans = Array.from(document.querySelectorAll<HTMLSpanElement>(`${ROOT} span`))
  for (const span of spans) {
    const match = (span.textContent || '').match(/([\d.]+)\s*px\/s/i)
    if (match) return Math.max(1, Number(match[1]) || 12)
  }
  return 12
}

function parseClock(value: string) {
  const match = value.trim().match(/^(\d+):(\d+(?:\.\d+)?)$/)
  if (!match) return Number.NaN
  return Number(match[1]) * 60 + Number(match[2])
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
  return Math.max(1 / 30, width / Math.max(1, zoom))
}

function clipRef(button: HTMLButtonElement): ClipRef | null {
  const label = firstClipLabel(button)
  const laneMatch = label.match(/^(V[123])\s*·/)
  if (!laneMatch) return null
  const lane = laneMatch[1] as VideoLane
  const zoom = parseZoom()
  const fileMatch = label.match(/^V[123]\s*·\s*V(\d+)/)
  return {
    lane,
    startAt: Math.max(0, (Number.parseFloat(button.style.left || '0') || 0) / zoom),
    duration: clipDurationFromButton(button, zoom),
    fileIndex: fileMatch ? Math.max(0, Number(fileMatch[1]) - 1) : null,
    element: button,
  }
}

function v1Surface() {
  return document.querySelector<HTMLElement>('.maghrabi-pro-lane-surface[data-maghrabi-lane="V1"]')
}

function editorButtons() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(`${ROOT} button`))
}

function clickRestore() {
  editorButtons().find((button) => (button.textContent || '').includes('استعادة'))?.click()
}

function transitionShort(type: TransitionType) {
  return TRANSITIONS.find((item) => item.value === type)?.short || 'TR'
}

function formatDuration(seconds: number) {
  return `${clamp(seconds, MIN_DURATION, MAX_DURATION).toFixed(2)}s`
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

function findVideo(project: ProjectShape, ref: ClipRef, used = new Set<string>()) {
  const clips = Array.isArray(project.clips) ? project.clips : []
  const sameLane = clips.filter((clip) => !used.has(clip.id) && clip.lane === ref.lane)
  const sameFile = ref.fileIndex === null ? sameLane : sameLane.filter((clip) => clip.fileIndex === ref.fileIndex)
  const candidates = sameFile.length ? sameFile : sameLane
  return candidates.sort((a, b) => Math.abs(a.startAt - ref.startAt) - Math.abs(b.startAt - ref.startAt))[0] || null
}

function transitionMatchesRight(transition: TransitionOut | null | undefined, right: VideoClip) {
  if (!transition || transition.type === 'none') return false
  if (transition.rightFileIndex !== undefined && transition.rightFileIndex !== right.fileIndex) return false
  if (transition.rightSourceStart !== undefined && Math.abs(transition.rightSourceStart - right.start) > .5) return false
  return true
}

async function commitTransition(leftRef: ClipRef, rightRef: ClipRef, type: TransitionType, requestedDuration: number) {
  const projectId = getActiveStudioProjectId()
  if (!projectId) return false
  const snapshot = await flushEditorSave(projectId)
  if (!snapshot) return false

  const project = JSON.parse(JSON.stringify(snapshot.project || {})) as ProjectShape
  project.clips = Array.isArray(project.clips) ? project.clips : []
  const used = new Set<string>()
  const left = findVideo(project, leftRef, used)
  if (!left) return false
  used.add(left.id)
  const right = findVideo(project, rightRef, used)
  if (!right || left.lane !== 'V1' || right.lane !== 'V1') return false

  if (type === 'none') {
    delete left.transitionOut
  } else {
    left.transitionOut = {
      type,
      duration: clamp(requestedDuration, MIN_DURATION, MAX_DURATION),
      rightFileIndex: right.fileIndex,
      rightSourceStart: right.start,
    }
  }

  const next: StoredVideoProject<ProjectShape> = {
    ...snapshot,
    project,
    savedAt: new Date().toISOString(),
  }
  await saveStoredVideoProject(next, projectId)
  window.dispatchEvent(new CustomEvent('maghrabi-transition-changed', { detail: { projectId } }))
  window.setTimeout(clickRestore, 70)
  return true
}

function refFromDataset(handle: HTMLElement, side: 'left' | 'right'): ClipRef | null {
  const prefix = side === 'left' ? 'left' : 'right'
  const startAt = Number(handle.dataset[`${prefix}Start`])
  const duration = Number(handle.dataset[`${prefix}Duration`])
  const fileRaw = handle.dataset[`${prefix}File`]
  if (!Number.isFinite(startAt) || !Number.isFinite(duration)) return null
  return {
    lane: 'V1',
    startAt,
    duration,
    fileIndex: fileRaw === undefined || fileRaw === '' ? null : Number(fileRaw),
  }
}

export default function StudioTransitionsPro() {
  const [editor, setEditor] = useState<ActiveCut | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let observer: MutationObserver | null = null
    let decorateTimer = 0
    let activeCleanup: (() => void) | null = null
    let disposed = false

    const announce = (text: string) => {
      setMessage(text)
      window.setTimeout(() => setMessage((current) => current === text ? '' : current), 2200)
    }

    const scheduleDecorate = (delay = 80) => {
      window.clearTimeout(decorateTimer)
      decorateTimer = window.setTimeout(() => { void decorate() }, delay)
    }

    const decorate = async () => {
      if (disposed || document.body.classList.contains('maghrabi-direct-moving') || document.body.classList.contains('maghrabi-advanced-trimming')) return
      const surface = v1Surface()
      if (!surface) return
      const zoom = parseZoom()
      const buttons = Array.from(surface.querySelectorAll<HTMLButtonElement>('button.maghrabi-pro-clip'))
      const refs = buttons
        .map(clipRef)
        .filter((ref): ref is ClipRef => ref !== null && ref.lane === 'V1')
        .sort((a, b) => a.startAt - b.startAt)

      let layer = surface.querySelector<HTMLElement>(':scope > .maghrabi-transition-layer')
      if (!layer) {
        layer = document.createElement('div')
        layer.className = 'maghrabi-transition-layer'
        surface.appendChild(layer)
      }
      layer.replaceChildren()
      if (refs.length < 2) return

      const projectId = getActiveStudioProjectId()
      const snapshot = projectId ? await loadStoredVideoProject<ProjectShape>(projectId).catch(() => null) : null
      if (disposed || !surface.isConnected || !layer.isConnected) return
      const project = snapshot?.project || {}
      const used = new Set<string>()
      const resolved = refs.map((ref) => {
        const clip = findVideo(project, ref, used)
        if (clip) used.add(clip.id)
        return { ref, clip }
      })

      for (let index = 0; index < resolved.length - 1; index++) {
        const left = resolved[index]
        const right = resolved[index + 1]
        const cutAt = left.ref.startAt + left.ref.duration
        if (Math.abs(right.ref.startAt - cutAt) > CUT_TOLERANCE) continue

        const stored = left.clip && right.clip && transitionMatchesRight(left.clip.transitionOut, right.clip)
          ? left.clip.transitionOut || null
          : null
        const type = stored?.type || 'none'
        const duration = clamp(stored?.duration || DEFAULT_DURATION, MIN_DURATION, MAX_DURATION)
        const handle = document.createElement('button')
        handle.type = 'button'
        handle.className = `maghrabi-transition-cut-handle${type !== 'none' ? ' is-active' : ''}`
        handle.style.left = `${cutAt * zoom}px`
        handle.style.setProperty('--maghrabi-transition-span', `${Math.max(14, duration * zoom)}px`)
        handle.dataset.transitionType = type
        handle.dataset.duration = String(duration)
        handle.dataset.short = type === 'none' ? '+' : transitionShort(type)
        handle.dataset.leftStart = String(left.ref.startAt)
        handle.dataset.leftDuration = String(left.ref.duration)
        handle.dataset.leftFile = left.ref.fileIndex === null ? '' : String(left.ref.fileIndex)
        handle.dataset.rightStart = String(right.ref.startAt)
        handle.dataset.rightDuration = String(right.ref.duration)
        handle.dataset.rightFile = right.ref.fileIndex === null ? '' : String(right.ref.fileIndex)
        handle.setAttribute('aria-label', type === 'none' ? 'إضافة انتقال عند نقطة القطع' : `${type} ${formatDuration(duration)}`)
        handle.title = type === 'none'
          ? 'Transition · انقر لاختيار انتقال أو اسحب أفقياً لإنشاء Dissolve'
          : `${type} · ${formatDuration(duration)} · Click settings · Drag duration`
        const badge = document.createElement('span')
        badge.textContent = handle.dataset.short
        handle.appendChild(badge)
        layer.appendChild(handle)
      }
    }

    const openEditor = (handle: HTMLElement) => {
      const left = refFromDataset(handle, 'left')
      const right = refFromDataset(handle, 'right')
      if (!left || !right) return
      const rect = handle.getBoundingClientRect()
      const rawType = (handle.dataset.transitionType || 'none') as TransitionType
      const type = rawType === 'none' ? 'dissolve' : rawType
      setEditor({
        left,
        right,
        type,
        duration: clamp(Number(handle.dataset.duration) || DEFAULT_DURATION, MIN_DURATION, MAX_DURATION),
        x: clamp(rect.left + rect.width / 2, 190, window.innerWidth - 190),
        y: Math.max(310, rect.top - 10),
      })
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      const handle = target?.closest<HTMLElement>('.maghrabi-transition-cut-handle')
      if (!handle || event.button !== 0) return
      const left = refFromDataset(handle, 'left')
      const right = refFromDataset(handle, 'right')
      if (!left || !right) return

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      activeCleanup?.()

      const pointerId = event.pointerId
      const startX = event.clientX
      const startDuration = clamp(Number(handle.dataset.duration) || DEFAULT_DURATION, MIN_DURATION, MAX_DURATION)
      const existingType = (handle.dataset.transitionType || 'none') as TransitionType
      let nextDuration = startDuration
      let dragging = false

      const badge = document.createElement('div')
      badge.className = 'maghrabi-transition-drag-badge'
      badge.innerHTML = `<strong>${existingType === 'none' ? 'NEW DISSOLVE' : transitionShort(existingType)}</strong><span>${formatDuration(startDuration)}</span>`
      document.body.appendChild(badge)

      const onMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return
        const delta = moveEvent.clientX - startX
        if (!dragging && Math.abs(delta) < 4) return
        dragging = true
        moveEvent.preventDefault()
        moveEvent.stopPropagation()
        document.body.classList.add('maghrabi-transition-dragging')
        handle.classList.add('is-dragging', 'is-active')
        nextDuration = clamp(startDuration + delta / Math.max(1, parseZoom()), MIN_DURATION, MAX_DURATION)
        handle.style.setProperty('--maghrabi-transition-span', `${Math.max(14, nextDuration * parseZoom())}px`)
        badge.style.left = `${clamp(moveEvent.clientX + 14, 8, window.innerWidth - 158)}px`
        badge.style.top = `${clamp(moveEvent.clientY - 42, 8, window.innerHeight - 48)}px`
        const strong = badge.querySelector('strong')
        const span = badge.querySelector('span')
        if (strong) strong.textContent = existingType === 'none' ? 'NEW DISSOLVE' : transitionShort(existingType)
        if (span) span.textContent = formatDuration(nextDuration)
      }

      const cleanup = () => {
        window.removeEventListener('pointermove', onMove, true)
        window.removeEventListener('pointerup', onUp, true)
        window.removeEventListener('pointercancel', onCancel, true)
        document.body.classList.remove('maghrabi-transition-dragging')
        handle.classList.remove('is-dragging')
        badge.remove()
        activeCleanup = null
      }

      const onUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return
        upEvent.preventDefault()
        upEvent.stopPropagation()
        upEvent.stopImmediatePropagation()
        if (!dragging) {
          cleanup()
          openEditor(handle)
          return
        }
        const type = existingType === 'none' ? 'dissolve' : existingType
        void commitTransition(left, right, type, nextDuration)
          .then((ok) => announce(ok ? `${transitionShort(type)} · ${formatDuration(nextDuration)} تم تطبيق الانتقال` : 'تعذر حفظ الانتقال'))
          .catch(() => announce('تعذر حفظ الانتقال'))
          .finally(() => { cleanup(); scheduleDecorate(180) })
      }

      const onCancel = (cancelEvent: PointerEvent) => {
        if (cancelEvent.pointerId !== pointerId) return
        cleanup()
        scheduleDecorate(40)
      }

      activeCleanup = cleanup
      window.addEventListener('pointermove', onMove, true)
      window.addEventListener('pointerup', onUp, true)
      window.addEventListener('pointercancel', onCancel, true)
    }

    const onProject = () => { setEditor(null); scheduleDecorate(180) }
    const onTransition = () => scheduleDecorate(180)
    const onResize = () => scheduleDecorate(80)
    const onZoom = () => scheduleDecorate(30)

    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('maghrabi-active-project-changed', onProject)
    window.addEventListener('maghrabi-project-snapshot-changed', onProject)
    window.addEventListener('maghrabi-transition-changed', onTransition)
    window.addEventListener('resize', onResize)
    document.querySelector<HTMLInputElement>('.maghrabi-studio-pro input[type="range"][min="5"][max="30"]')?.addEventListener('input', onZoom)

    observer = new MutationObserver((mutations) => {
      const meaningful = mutations.some((mutation) => {
        const target = mutation.target instanceof HTMLElement ? mutation.target : null
        if (target?.closest('.maghrabi-transition-layer')) return false
        return mutation.type === 'childList' || mutation.type === 'attributes'
      })
      if (meaningful) scheduleDecorate(90)
    })
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    scheduleDecorate(160)

    return () => {
      disposed = true
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('maghrabi-active-project-changed', onProject)
      window.removeEventListener('maghrabi-project-snapshot-changed', onProject)
      window.removeEventListener('maghrabi-transition-changed', onTransition)
      window.removeEventListener('resize', onResize)
      document.querySelector<HTMLInputElement>('.maghrabi-studio-pro input[type="range"][min="5"][max="30"]')?.removeEventListener('input', onZoom)
      observer?.disconnect()
      activeCleanup?.()
      window.clearTimeout(decorateTimer)
      document.querySelectorAll('.maghrabi-transition-layer').forEach((node) => node.remove())
      document.querySelectorAll('.maghrabi-transition-drag-badge').forEach((node) => node.remove())
      document.body.classList.remove('maghrabi-transition-dragging')
    }
  }, [])

  const applyEditor = async (type: TransitionType) => {
    if (!editor || busy) return
    setBusy(true)
    try {
      const ok = await commitTransition(editor.left, editor.right, type, editor.duration)
      if (ok) {
        setMessage(type === 'none' ? 'تم حذف الانتقال من نقطة القطع' : `${transitionShort(type)} · ${formatDuration(editor.duration)} تم حفظه في المشروع`)
        setEditor(null)
      } else setMessage('تعذر تحديث الانتقال')
    } catch {
      setMessage('تعذر تحديث الانتقال')
    } finally {
      setBusy(false)
      window.setTimeout(() => setMessage(''), 2200)
    }
  }

  return (
    <>
      {editor && (
        <div
          className="maghrabi-transition-panel"
          dir="rtl"
          style={{ left: editor.x, top: editor.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="maghrabi-transition-panel-head">
            <div>
              <strong>PER-CUT TRANSITION</strong>
              <span>انتقال مستقل عند نقطة القطع · V1</span>
            </div>
            <button type="button" onClick={() => setEditor(null)} aria-label="إغلاق">×</button>
          </div>

          <div className="maghrabi-transition-grid">
            {TRANSITIONS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={editor.type === item.value ? 'is-selected' : ''}
                onClick={() => setEditor((current) => current ? { ...current, type: item.value } : current)}
              >
                <b>{item.short}</b>
                <span>{item.label}</span>
              </button>
            ))}
          </div>

          <div className="maghrabi-transition-duration-row">
            <label htmlFor="maghrabi-transition-duration">DURATION</label>
            <input
              id="maghrabi-transition-duration"
              type="range"
              min={MIN_DURATION}
              max={MAX_DURATION}
              step="0.01"
              value={editor.duration}
              onChange={(event) => setEditor((current) => current ? { ...current, duration: Number(event.target.value) } : current)}
            />
            <input
              type="number"
              min={MIN_DURATION}
              max={MAX_DURATION}
              step="0.01"
              value={editor.duration.toFixed(2)}
              onChange={(event) => setEditor((current) => current ? { ...current, duration: clamp(Number(event.target.value), MIN_DURATION, MAX_DURATION) } : current)}
            />
          </div>

          <div className="maghrabi-transition-actions">
            <button type="button" className="is-remove" disabled={busy} onClick={() => void applyEditor('none')}>REMOVE</button>
            <button type="button" className="is-apply" disabled={busy} onClick={() => void applyEditor(editor.type)}>{busy ? 'SAVING...' : 'APPLY TRANSITION'}</button>
          </div>
          <small>Click = Settings · Horizontal Drag = Duration · Render = FFmpeg xfade + audio crossfade</small>
        </div>
      )}
      {message && <div className="maghrabi-transition-toast" dir="rtl">{message}</div>}
    </>
  )
}
