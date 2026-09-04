import { useEffect, useMemo, useRef, useState } from 'react'
import { BookmarkPlus, History, Redo2, Save, Undo2 } from 'lucide-react'
import { getActiveStudioProjectId } from './lib/projectHubStore'
import { loadStoredVideoProject, saveStoredVideoProject, type StoredVideoProject } from './lib/projectStore'
import {
  getEditingHistoryState,
  pushEditingHistory,
  redoEditingHistory,
  undoEditingHistory,
  type EditingHistoryEntry,
  type EditingHistoryState,
} from './lib/editingHistoryStore'
import './studioEditingCore.css'

const ROOT = '.maghrabi-studio-pro main'
const HEADER_WIDTH = 122
const MARKER_PREFIX = 'maghrabi-studio-markers-v1:'
const MARKER_COLORS = ['#22d3ee', '#f59e0b', '#a78bfa', '#34d399', '#fb7185', '#60a5fa']

type Marker = {
  id: string
  time: number
  label: string
  color: string
}

type SaveState = 'READY' | 'DIRTY' | 'SAVING' | 'SAVED' | 'ERROR' | 'NO PROJECT'

const emptyHistory: EditingHistoryState = { count: 0, cursor: -1, canUndo: false, canRedo: false }

function wait(ms: number) { return new Promise((resolve) => window.setTimeout(resolve, ms)) }

function editorButtons() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(`${ROOT} button`))
}

function buttonByText(text: string) {
  const wanted = text.trim().toUpperCase()
  return editorButtons().find((button) => (button.textContent || '').trim().toUpperCase().includes(wanted)) || null
}

function clickEditorButton(text: string) {
  const button = buttonByText(text)
  if (!button || button.disabled) return false
  button.click()
  return true
}

function isTypingTarget(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null
  if (!element) return false
  return Boolean(element.closest('input, textarea, select, [contenteditable="true"]'))
}

function isCoreTarget(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null
  return Boolean(element?.closest('.maghrabi-editing-core, .maghrabi-marker'))
}

function parseZoom() {
  const spans = Array.from(document.querySelectorAll<HTMLSpanElement>(`${ROOT} span`))
  for (const span of spans) {
    const match = (span.textContent || '').match(/([\d.]+)\s*px\/s/i)
    if (match) return Math.max(1, Number(match[1]) || 12)
  }
  return 12
}

function findTimeline() {
  const ruler = document.querySelector<HTMLElement>('.maghrabi-time-ruler')
  return ruler?.parentElement as HTMLElement | null
}

function findPlayhead() {
  return document.querySelector<HTMLElement>('.maghrabi-playhead')
}

function findScrubTarget(timeline: HTMLElement) {
  const adjustmentRow = Array.from(timeline.children).find((child) => {
    return child instanceof HTMLElement && child.className.includes('h-[52px]')
  }) as HTMLElement | undefined
  return adjustmentRow?.lastElementChild as HTMLElement | null
}

function currentPlayheadTime() {
  const timeline = findTimeline()
  const playhead = findPlayhead()
  if (!timeline || !playhead) return 0
  const zoom = parseZoom()
  const timelineRect = timeline.getBoundingClientRect()
  const playheadRect = playhead.getBoundingClientRect()
  const center = playheadRect.left + playheadRect.width / 2
  return Math.max(0, (center - timelineRect.left - HEADER_WIDTH) / zoom)
}

function jumpToTime(time: number) {
  const timeline = findTimeline()
  if (!timeline) return
  const target = findScrubTarget(timeline)
  if (!target) return
  const zoom = parseZoom()
  const rect = target.getBoundingClientRect()
  const x = Math.max(rect.left, Math.min(rect.right - 1, rect.left + Math.max(0, time) * zoom))
  target.dispatchEvent(new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: rect.top + rect.height / 2,
    view: window,
  }))
}

function markerKey(projectId: string) { return `${MARKER_PREFIX}${projectId}` }

function readMarkers(projectId: string): Marker[] {
  try {
    const raw = localStorage.getItem(markerKey(projectId))
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((marker) => marker && typeof marker.id === 'string' && Number.isFinite(marker.time))
      .map((marker, index) => ({
        id: marker.id,
        time: Math.max(0, Number(marker.time)),
        label: typeof marker.label === 'string' && marker.label.trim() ? marker.label : `Marker ${index + 1}`,
        color: typeof marker.color === 'string' ? marker.color : MARKER_COLORS[index % MARKER_COLORS.length],
      }))
  } catch {
    return []
  }
}

function writeMarkers(projectId: string, markers: Marker[]) {
  localStorage.setItem(markerKey(projectId), JSON.stringify(markers))
  window.dispatchEvent(new CustomEvent('maghrabi-markers-changed', { detail: { projectId } }))
}

async function applyHistoryEntry(projectId: string, entry: EditingHistoryEntry<unknown>) {
  const current = await loadStoredVideoProject<unknown>(projectId)
  if (!current) throw new Error('لا توجد Snapshot حالية لتطبيق Undo/Redo.')
  const next: StoredVideoProject<unknown> = {
    ...current,
    savedAt: new Date().toISOString(),
    project: entry.project,
    outputSize: entry.outputSize,
    quality: entry.quality,
  }
  await saveStoredVideoProject(next, projectId)
  await wait(60)
  if (!clickEditorButton('استعادة')) throw new Error('تعذر تحديث المحرر بعد Undo/Redo.')
}

export default function StudioEditingCorePro() {
  const [projectId, setProjectId] = useState(() => getActiveStudioProjectId())
  const [saveState, setSaveState] = useState<SaveState>(projectId ? 'READY' : 'NO PROJECT')
  const [history, setHistory] = useState<EditingHistoryState>(emptyHistory)
  const [markers, setMarkers] = useState<Marker[]>(() => projectId ? readMarkers(projectId) : [])
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null)
  const dirtyRef = useRef(false)
  const autosaveTimer = useRef<number | null>(null)
  const historyApplying = useRef(false)
  const saveInFlight = useRef(false)

  const historyLabel = useMemo(() => history.count ? `${history.cursor + 1}/${history.count}` : '0/0', [history])

  const refreshHistory = async (id = projectId) => {
    if (!id) { setHistory(emptyHistory); return }
    try { setHistory(await getEditingHistoryState(id)) }
    catch { setHistory(emptyHistory) }
  }

  const captureSnapshot = async (id: string) => {
    const snapshot = await loadStoredVideoProject<unknown>(id)
    if (!snapshot) return
    setHistory(await pushEditingHistory(id, snapshot))
    setLastSavedAt(snapshot.savedAt || new Date().toISOString())
  }

  const performSave = async (manual = false) => {
    const id = getActiveStudioProjectId()
    if (!id || saveInFlight.current) return false
    const saveButton = buttonByText('حفظ')
    if (!saveButton || saveButton.disabled) return false

    saveInFlight.current = true
    setSaveState('SAVING')
    try {
      const completed = new Promise<boolean>((resolve) => {
        let timeout = 0
        const finish = (ok: boolean) => {
          window.clearTimeout(timeout)
          window.removeEventListener('maghrabi-project-snapshot-changed', onSaved as EventListener)
          resolve(ok)
        }
        const onSaved = (event: Event) => {
          const detail = (event as CustomEvent<{ projectId?: string | null }>).detail
          if (detail?.projectId && detail.projectId !== id) return
          finish(true)
        }
        window.addEventListener('maghrabi-project-snapshot-changed', onSaved as EventListener)
        timeout = window.setTimeout(() => finish(false), 3500)
      })
      saveButton.click()
      const ok = await completed
      if (!ok) throw new Error('لم يصل تأكيد الحفظ من المحرر.')
      if (!historyApplying.current) await captureSnapshot(id)
      dirtyRef.current = false
      setSaveState('SAVED')
      window.setTimeout(() => setSaveState((state) => state === 'SAVED' ? 'READY' : state), manual ? 2200 : 1200)
      return true
    } catch {
      setSaveState('ERROR')
      return false
    } finally {
      saveInFlight.current = false
    }
  }

  const scheduleAutosave = () => {
    dirtyRef.current = true
    setSaveState('DIRTY')
    if (autosaveTimer.current) window.clearTimeout(autosaveTimer.current)
    autosaveTimer.current = window.setTimeout(() => {
      autosaveTimer.current = null
      void performSave(false)
    }, 1100)
  }

  const doUndo = async () => {
    const id = getActiveStudioProjectId()
    if (!id) return
    if (dirtyRef.current) await performSave(false)
    historyApplying.current = true
    try {
      const result = await undoEditingHistory(id)
      setHistory(result.state)
      if (!result.entry) return
      await applyHistoryEntry(id, result.entry)
      dirtyRef.current = false
      setSaveState('READY')
    } finally {
      window.setTimeout(() => { historyApplying.current = false }, 250)
    }
  }

  const doRedo = async () => {
    const id = getActiveStudioProjectId()
    if (!id || dirtyRef.current) return
    historyApplying.current = true
    try {
      const result = await redoEditingHistory(id)
      setHistory(result.state)
      if (!result.entry) return
      await applyHistoryEntry(id, result.entry)
      setSaveState('READY')
    } finally {
      window.setTimeout(() => { historyApplying.current = false }, 250)
    }
  }

  const addMarker = (askLabel = false) => {
    const id = getActiveStudioProjectId()
    if (!id) return
    const existing = readMarkers(id)
    const time = currentPlayheadTime()
    const label = askLabel ? (window.prompt('اسم العلامة:', `Marker ${existing.length + 1}`) || `Marker ${existing.length + 1}`) : `Marker ${existing.length + 1}`
    const marker: Marker = {
      id: `marker-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      time,
      label,
      color: MARKER_COLORS[existing.length % MARKER_COLORS.length],
    }
    const next = [...existing, marker].sort((a, b) => a.time - b.time)
    writeMarkers(id, next)
    setMarkers(next)
  }

  useEffect(() => {
    const onProject = () => {
      const id = getActiveStudioProjectId()
      setProjectId(id)
      setSaveState(id ? 'READY' : 'NO PROJECT')
      setMarkers(id ? readMarkers(id) : [])
      dirtyRef.current = false
      void refreshHistory(id)
      if (id) window.setTimeout(() => void captureSnapshot(id), 850)
    }
    window.addEventListener('maghrabi-active-project-changed', onProject)
    onProject()
    return () => window.removeEventListener('maghrabi-active-project-changed', onProject)
  }, [])

  useEffect(() => {
    const onSaved = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string | null; savedAt?: string | null }>).detail
      const id = getActiveStudioProjectId()
      if (!id || (detail?.projectId && detail.projectId !== id)) return
      if (detail?.savedAt) setLastSavedAt(detail.savedAt)
      if (!historyApplying.current && !saveInFlight.current) void captureSnapshot(id)
      dirtyRef.current = false
      setSaveState('SAVED')
      window.setTimeout(() => setSaveState((state) => state === 'SAVED' ? 'READY' : state), 1000)
    }
    window.addEventListener('maghrabi-project-snapshot-changed', onSaved as EventListener)
    return () => window.removeEventListener('maghrabi-project-snapshot-changed', onSaved as EventListener)
  }, [])

  useEffect(() => {
    const markDirty = (event: Event) => {
      if (historyApplying.current || isCoreTarget(event.target)) return
      const element = event.target instanceof HTMLElement ? event.target : null
      if (!element?.closest(ROOT)) return
      const text = (element.closest('button')?.textContent || '').trim()
      if (text.includes('حفظ') || text.includes('استعادة')) return
      scheduleAutosave()
    }
    document.addEventListener('change', markDirty, true)
    document.addEventListener('drop', markDirty, true)
    document.addEventListener('pointerup', markDirty, true)
    return () => {
      document.removeEventListener('change', markDirty, true)
      document.removeEventListener('drop', markDirty, true)
      document.removeEventListener('pointerup', markDirty, true)
      if (autosaveTimer.current) window.clearTimeout(autosaveTimer.current)
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return
      const mod = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()

      if (mod && key === 's') {
        event.preventDefault()
        void performSave(true)
        return
      }
      if (mod && key === 'z') {
        event.preventDefault()
        if (event.shiftKey) void doRedo()
        else void doUndo()
        return
      }
      if (mod && key === 'y') {
        event.preventDefault()
        void doRedo()
        return
      }
      if (key === 'm') {
        event.preventDefault()
        addMarker(event.shiftKey)
        return
      }
      if (key === 'v') { clickEditorButton('SELECT'); return }
      if (key === 'c') { clickEditorButton('RAZOR'); return }
      if (key === 'i') { clickEditorButton('TIMELINE IN'); return }
      if (key === 'o') { clickEditorButton('TIMELINE OUT'); return }
      if (key === 'q') { clickEditorButton('LIFT'); return }
      if (key === 'w') { clickEditorButton('EXTRACT'); return }
      if (event.key === 'Delete' && event.shiftKey) {
        event.preventDefault()
        clickEditorButton('EXTRACT')
        return
      }
      if (event.code === 'Space') {
        const play = editorButtons().find((button) => /^(PLAY|PAUSE)/i.test((button.textContent || '').trim()))
        if (play && !play.disabled) { event.preventDefault(); play.click() }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    let markerLayer: HTMLElement | null = null
    let resizeObserver: ResizeObserver | null = null
    let mutationObserver: MutationObserver | null = null
    let cleanupDrag: (() => void) | null = null

    const render = () => {
      const id = getActiveStudioProjectId()
      const timeline = findTimeline()
      if (!id || !timeline) return
      const currentMarkers = readMarkers(id)
      setMarkers(currentMarkers)
      const zoom = parseZoom()

      if (!markerLayer || markerLayer.parentElement !== timeline) {
        markerLayer?.remove()
        markerLayer = document.createElement('div')
        markerLayer.className = 'maghrabi-marker-layer'
        timeline.appendChild(markerLayer)
      }
      markerLayer.replaceChildren()

      currentMarkers.forEach((marker) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'maghrabi-marker'
        button.style.left = `${HEADER_WIDTH + marker.time * zoom}px`
        button.style.setProperty('--marker-color', marker.color)
        button.title = `${marker.label} · ${marker.time.toFixed(2)}s · Double click rename · Right click delete`
        button.dataset.label = marker.label

        button.addEventListener('click', (event) => {
          event.stopPropagation()
          jumpToTime(marker.time)
        })
        button.addEventListener('dblclick', (event) => {
          event.preventDefault()
          event.stopPropagation()
          const label = window.prompt('اسم العلامة:', marker.label)
          if (label === null) return
          const next = readMarkers(id).map((item) => item.id === marker.id ? { ...item, label: label.trim() || item.label } : item)
          writeMarkers(id, next)
          render()
        })
        button.addEventListener('contextmenu', (event) => {
          event.preventDefault()
          event.stopPropagation()
          const next = readMarkers(id).filter((item) => item.id !== marker.id)
          writeMarkers(id, next)
          render()
        })
        button.addEventListener('pointerdown', (event) => {
          if (event.button !== 0) return
          event.preventDefault()
          event.stopPropagation()
          const timelineRect = timeline.getBoundingClientRect()
          const onMove = (moveEvent: PointerEvent) => {
            const time = Math.max(0, (moveEvent.clientX - timelineRect.left - HEADER_WIDTH) / parseZoom())
            button.style.left = `${HEADER_WIDTH + time * parseZoom()}px`
            jumpToTime(time)
          }
          const finish = (upEvent: PointerEvent) => {
            document.removeEventListener('pointermove', onMove)
            document.removeEventListener('pointerup', finish)
            const time = Math.max(0, (upEvent.clientX - timelineRect.left - HEADER_WIDTH) / parseZoom())
            const next = readMarkers(id).map((item) => item.id === marker.id ? { ...item, time } : item).sort((a, b) => a.time - b.time)
            writeMarkers(id, next)
            cleanupDrag = null
            render()
          }
          cleanupDrag = () => {
            document.removeEventListener('pointermove', onMove)
            document.removeEventListener('pointerup', finish)
          }
          document.addEventListener('pointermove', onMove)
          document.addEventListener('pointerup', finish, { once: true })
        })
        markerLayer?.appendChild(button)
      })
    }

    const install = () => {
      const timeline = findTimeline()
      if (!timeline) return
      render()
      resizeObserver?.disconnect()
      resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(render) : null
      resizeObserver?.observe(timeline)
    }

    const onMarkers = () => render()
    const onProject = () => install()
    window.addEventListener('maghrabi-markers-changed', onMarkers)
    window.addEventListener('maghrabi-active-project-changed', onProject)
    mutationObserver = new MutationObserver(() => {
      if (!markerLayer?.isConnected || markerLayer?.parentElement !== findTimeline()) install()
    })
    mutationObserver.observe(document.body, { childList: true, subtree: true })
    window.setTimeout(install, 100)

    return () => {
      window.removeEventListener('maghrabi-markers-changed', onMarkers)
      window.removeEventListener('maghrabi-active-project-changed', onProject)
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
      cleanupDrag?.()
      markerLayer?.remove()
    }
  }, [])

  return (
    <div className="maghrabi-editing-core" dir="ltr">
      <button className="maghrabi-core-button" onClick={() => void doUndo()} disabled={!history.canUndo} title="Undo · Ctrl/Cmd+Z">
        <Undo2 className="h-3.5 w-3.5" /><span>UNDO</span>
      </button>
      <button className="maghrabi-core-button" onClick={() => void doRedo()} disabled={!history.canRedo || dirtyRef.current} title="Redo · Ctrl/Cmd+Shift+Z">
        <Redo2 className="h-3.5 w-3.5" /><span>REDO</span>
      </button>
      <span className="maghrabi-history-count" title="Persistent edit history"><History className="h-3 w-3" />{historyLabel}</span>
      <span className="maghrabi-core-divider" />
      <button className="maghrabi-core-button" onClick={() => addMarker(false)} disabled={!projectId} title="Add marker · M"><BookmarkPlus className="h-3.5 w-3.5"/><span>MARKER</span></button>
      <button className="maghrabi-core-button is-ripple" onClick={() => clickEditorButton('EXTRACT')} title="Ripple Delete · W / Shift+Delete"><span>RIPPLE</span></button>
      <span className="maghrabi-core-divider" />
      <button className="maghrabi-save-state" onClick={() => void performSave(true)} disabled={!projectId} title={lastSavedAt ? `Last saved ${new Date(lastSavedAt).toLocaleTimeString()}` : 'Autosave'}>
        <Save className="h-3 w-3" />
        <span>{saveState === 'DIRTY' ? 'UNSAVED' : saveState === 'SAVING' ? 'SAVING…' : saveState === 'ERROR' ? 'SAVE ERROR' : saveState === 'NO PROJECT' ? 'NO PROJECT' : 'AUTOSAVE'}</span>
        <i className={`maghrabi-save-dot state-${saveState.toLowerCase().replace(' ', '-')}`} />
      </button>
    </div>
  )
}
