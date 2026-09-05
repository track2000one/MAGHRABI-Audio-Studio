import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronLeft,
  ChevronRight,
  Combine,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Square,
} from 'lucide-react'
import { getActiveStudioProjectId } from './lib/projectHubStore'
import { loadStoredVideoProject, saveStoredVideoProject, type StoredVideoProject } from './lib/projectStore'

const ROOT = '.maghrabi-studio-pro main'
const HEADER_WIDTH = 122
const FRAME = 1 / 30

type TimelineClip = {
  id: string
  lane: 'V1' | 'V2' | 'V3'
  startAt: number
  start: number
  end: number
  speed: number
  freezeFrame?: boolean
  freezeDuration?: number
}

type TimelineAudio = {
  id: string
  lane: 'A1' | 'A2' | 'A3'
  startAt: number
  sourceStart: number
  sourceEnd: number
}

type AdjustmentLayer = {
  id: string
  startAt: number
  endAt: number
  [key: string]: unknown
}

type ProjectShape = {
  clips?: TimelineClip[]
  audioTracks?: TimelineAudio[]
  adjustments?: AdjustmentLayer[]
  [key: string]: unknown
}

type ClipBox = {
  start: number
  end: number
}

function parseClock(value: string) {
  const match = value.trim().match(/^(\d+):(\d+(?:\.\d+)?)$/)
  if (!match) return Number.NaN
  return Number(match[1]) * 60 + Number(match[2])
}

function parseZoom() {
  const spans = Array.from(document.querySelectorAll<HTMLSpanElement>(`${ROOT} span`))
  for (const span of spans) {
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
  if (!timeline || !playhead) return 0
  const zoom = parseZoom()
  const t = timeline.getBoundingClientRect()
  const p = playhead.getBoundingClientRect()
  return Math.max(0, (p.left + p.width / 2 - t.left - HEADER_WIDTH) / zoom)
}

function clipTiming(button: HTMLButtonElement) {
  for (const span of Array.from(button.querySelectorAll<HTMLSpanElement>('span'))) {
    const match = (span.textContent || '').match(/(\d+:\d+(?:\.\d+)?)\s*·\s*(\d+:\d+(?:\.\d+)?)/)
    if (!match) continue
    const start = parseClock(match[1])
    const duration = parseClock(match[2])
    if (Number.isFinite(start) && Number.isFinite(duration) && duration > 0) return { start, duration }
  }
  return null
}

function v1Clips(): ClipBox[] {
  const timeline = timelineRoot()
  if (!timeline) return []
  const zoom = parseZoom()
  return Array.from(timeline.querySelectorAll<HTMLButtonElement>('button[style*="left"][style*="width"]'))
    .filter((button) => /^V1\s*·/i.test((button.textContent || '').trim()))
    .map((button) => {
      const timing = clipTiming(button)
      const start = timing?.start ?? Math.max(0, (Number.parseFloat(button.style.left) || 0) / zoom)
      const duration = timing?.duration ?? Math.max(.02, (Number.parseFloat(button.style.width) || button.getBoundingClientRect().width || 0) / zoom)
      return { start, end: start + duration }
    })
    .sort((a, b) => a.start - b.start)
}

function findScrubTarget(timeline: HTMLElement) {
  const adjustmentRow = Array.from(timeline.children).find((child) => child instanceof HTMLElement && child.className.includes('h-[52px]')) as HTMLElement | undefined
  return adjustmentRow?.lastElementChild as HTMLElement | null
}

function jumpToTime(time: number) {
  const timeline = timelineRoot()
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

function programPanel() {
  const labels = Array.from(document.querySelectorAll<HTMLElement>(`${ROOT} p`))
  const label = labels.find((item) => (item.textContent || '').trim().toUpperCase() === 'PROGRAM MONITOR')
  return label?.closest<HTMLElement>('div[class*="rounded-3xl"]') || null
}

function programVideo() {
  return programPanel()?.querySelector<HTMLVideoElement>('.aspect-video > video:not([controls])') || null
}

function nativeTransportButton() {
  const panel = programPanel()
  if (!panel) return null
  return Array.from(panel.querySelectorAll<HTMLButtonElement>('button')).find((button) => /^(PLAY|PAUSE)/i.test((button.textContent || '').trim())) || null
}

function setPlaying(wanted: boolean) {
  const button = nativeTransportButton()
  if (!button || button.disabled) return false
  const text = (button.textContent || '').trim().toUpperCase()
  const currentlyPlaying = /^PAUSE/.test(text)
  if (wanted !== currentlyPlaying) button.click()
  return true
}

function clipDuration(clip: TimelineClip) {
  if (clip.freezeFrame) return Math.max(.2, clip.freezeDuration || 2)
  return Math.max(.02, (clip.end - clip.start) / Math.max(.25, clip.speed || 1))
}

function editorButtons() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(`${ROOT} button`))
}

async function flushEditorSave(projectId: string) {
  const saveButton = editorButtons().find((item) => (item.textContent || '').includes('حفظ'))
  if (!saveButton) return loadStoredVideoProject<ProjectShape>(projectId)

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

function clickRestore() {
  editorButtons().find((item) => (item.textContent || '').includes('استعادة'))?.click()
}

function closeOneGap(project: ProjectShape) {
  const clips = Array.isArray(project.clips) ? project.clips : []
  const audio = Array.isArray(project.audioTracks) ? project.audioTracks : []
  const adjustments = Array.isArray(project.adjustments) ? project.adjustments : []
  const v1 = clips.filter((clip) => clip.lane === 'V1').sort((a, b) => a.startAt - b.startAt)
  if (!v1.length) return 0

  let gapStart = 0
  let gapEnd = Math.max(0, v1[0].startAt)
  if (gapEnd <= .025) {
    let found = false
    for (let index = 1; index < v1.length; index += 1) {
      const previousEnd = v1[index - 1].startAt + clipDuration(v1[index - 1])
      if (v1[index].startAt > previousEnd + .025) {
        gapStart = previousEnd
        gapEnd = v1[index].startAt
        found = true
        break
      }
    }
    if (!found) return 0
  }

  const delta = gapEnd - gapStart
  clips.forEach((clip) => {
    if (clip.startAt >= gapEnd - .001) clip.startAt = Math.max(0, clip.startAt - delta)
  })
  audio.forEach((track) => {
    if (track.startAt >= gapEnd - .001) track.startAt = Math.max(0, track.startAt - delta)
  })
  adjustments.forEach((layer) => {
    if (layer.startAt >= gapEnd - .001) {
      layer.startAt = Math.max(0, layer.startAt - delta)
      layer.endAt = Math.max(layer.startAt + .05, layer.endAt - delta)
    } else if (layer.endAt > gapEnd) {
      layer.endAt = Math.max(layer.startAt + .05, layer.endAt - delta)
    }
  })
  return delta
}

async function compactSequence() {
  const projectId = getActiveStudioProjectId()
  if (!projectId) throw new Error('افتح مشروعًا أولًا.')
  const snapshot = await flushEditorSave(projectId)
  if (!snapshot) throw new Error('تعذر قراءة المشروع الحالي.')

  const project = JSON.parse(JSON.stringify(snapshot.project || {})) as ProjectShape
  let closed = 0
  let removedSeconds = 0
  for (let guard = 0; guard < 100; guard += 1) {
    const delta = closeOneGap(project)
    if (delta <= .001) break
    closed += 1
    removedSeconds += delta
  }
  if (!closed) return { closed: 0, removedSeconds: 0 }

  const next: StoredVideoProject<ProjectShape> = {
    ...snapshot,
    project,
    savedAt: new Date().toISOString(),
  }
  await saveStoredVideoProject(next, projectId)
  window.setTimeout(clickRestore, 80)
  return { closed, removedSeconds }
}

function isTyping(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null
  return Boolean(element?.closest('input, textarea, select, [contenteditable="true"]'))
}

export default function StudioTransportPro() {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  const [time, setTime] = useState(0)
  const [playing, setPlayingState] = useState(false)
  const [message, setMessage] = useState('')
  const cuts = useMemo(() => {
    const values = v1Clips().flatMap((clip) => [clip.start, clip.end])
    return Array.from(new Set(values.map((value) => Math.round(value * 1000) / 1000))).sort((a, b) => a - b)
  }, [time])

  const announce = (text: string) => {
    setMessage(text)
    window.setTimeout(() => setMessage((current) => current === text ? '' : current), 2200)
  }

  const previousCut = () => {
    const point = [...cuts].reverse().find((value) => value < time - .02)
    jumpToTime(point ?? 0)
  }

  const nextCut = () => {
    const point = cuts.find((value) => value > time + .02)
    if (point !== undefined) jumpToTime(point)
  }

  const stop = () => {
    setPlaying(false)
    const first = v1Clips()[0]
    jumpToTime(first?.start || 0)
  }

  const compact = async () => {
    try {
      const result = await compactSequence()
      announce(result.closed ? `تم إغلاق ${result.closed} فجوة · اختصار ${result.removedSeconds.toFixed(2)} ثانية` : 'V1 متصل بالفعل — لا توجد فجوات')
    } catch (error) {
      announce(error instanceof Error ? error.message : 'تعذر إغلاق الفجوات.')
    }
  }

  useEffect(() => {
    let observer: MutationObserver | null = null
    const refresh = () => setTarget(programPanel())
    observer = new MutationObserver(refresh)
    observer.observe(document.body, { childList: true, subtree: true })
    refresh()
    return () => observer?.disconnect()
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTime(playheadTime())
      const video = programVideo()
      setPlayingState(Boolean(video && !video.paused && !video.ended))
    }, 120)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target) || event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        jumpToTime(Math.max(0, playheadTime() - (event.shiftKey ? 1 : FRAME)))
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        jumpToTime(playheadTime() + (event.shiftKey ? 1 : FRAME))
      } else if (event.key.toLowerCase() === 'j') {
        event.preventDefault()
        jumpToTime(Math.max(0, playheadTime() - 1))
      } else if (event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPlaying(false)
      } else if (event.key.toLowerCase() === 'l') {
        event.preventDefault()
        setPlaying(true)
      } else if (event.key === 'Home') {
        event.preventDefault()
        jumpToTime(v1Clips()[0]?.start || 0)
      } else if (event.key === 'End') {
        event.preventDefault()
        const clips = v1Clips()
        if (clips.length) jumpToTime(clips[clips.length - 1].end)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!target) return null

  return createPortal(
    <div className="mt-3 border-t border-white/8 pt-3" dir="ltr">
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        <button type="button" onClick={() => jumpToTime(v1Clips()[0]?.start || 0)} className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 bg-white/[.025] text-slate-300 transition hover:border-cyan-300/30 hover:text-cyan-100" title="بداية التسلسل · Home"><SkipBack className="h-3.5 w-3.5" /></button>
        <button type="button" onClick={previousCut} className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 bg-white/[.025] text-slate-300 transition hover:border-cyan-300/30 hover:text-cyan-100" title="القص السابق"><ChevronLeft className="h-3.5 w-3.5" /></button>
        <button type="button" onClick={() => jumpToTime(Math.max(0, playheadTime() - FRAME))} className="rounded-lg border border-white/10 bg-white/[.025] px-2.5 py-2 text-[9px] font-black text-slate-300 transition hover:border-cyan-300/30" title="Frame للخلف · ←">-1F</button>
        <button type="button" onClick={() => setPlaying(!playing)} className="inline-flex h-9 min-w-[82px] items-center justify-center gap-2 rounded-xl bg-cyan-300 px-3 text-[10px] font-black text-slate-950 shadow-lg shadow-cyan-950/30 transition hover:bg-cyan-200" title="تشغيل / إيقاف · Space أو K/L">{playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}{playing ? 'PAUSE' : 'PLAY'}</button>
        <button type="button" onClick={stop} className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 bg-white/[.025] text-slate-300 transition hover:border-rose-300/30 hover:text-rose-200" title="Stop والعودة للبداية"><Square className="h-3.5 w-3.5" /></button>
        <button type="button" onClick={() => jumpToTime(playheadTime() + FRAME)} className="rounded-lg border border-white/10 bg-white/[.025] px-2.5 py-2 text-[9px] font-black text-slate-300 transition hover:border-cyan-300/30" title="Frame للأمام · →">+1F</button>
        <button type="button" onClick={nextCut} className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 bg-white/[.025] text-slate-300 transition hover:border-cyan-300/30 hover:text-cyan-100" title="القص التالي"><ChevronRight className="h-3.5 w-3.5" /></button>
        <button type="button" onClick={() => { const clips = v1Clips(); if (clips.length) jumpToTime(clips[clips.length - 1].end) }} className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 bg-white/[.025] text-slate-300 transition hover:border-cyan-300/30 hover:text-cyan-100" title="نهاية التسلسل · End"><SkipForward className="h-3.5 w-3.5" /></button>
        <span className="mx-1 h-5 w-px bg-white/10" />
        <button type="button" onClick={() => void compact()} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-emerald-300/20 bg-emerald-300/[.05] px-3 text-[9px] font-black text-emerald-100 transition hover:border-emerald-300/45 hover:bg-emerald-300/[.09]" title="إغلاق فجوات V1 بطريقة Ripple مع الحفاظ على تزامن المسارات"><Combine className="h-3.5 w-3.5" />CLOSE GAPS</button>
        <span className="ml-2 rounded-md border border-white/8 bg-black/20 px-2 py-1 text-[9px] font-mono text-slate-500">{time.toFixed(2)}s</span>
      </div>
      <div className="mt-2 flex items-center justify-center gap-3 text-[8px] font-semibold text-slate-600">
        <span>J/K/L Shuttle</span><span>←/→ Frame</span><span>Shift + ←/→ 1s</span><span>Home/End Sequence</span>
      </div>
      {message && <div className="mt-2 rounded-lg border border-cyan-300/15 bg-cyan-300/[.05] px-3 py-2 text-center text-[9px] font-bold text-cyan-100" dir="rtl">{message}</div>}
    </div>,
    target,
  )
}
