import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const ROOT = '.maghrabi-studio-pro main'
const HEADER_WIDTH = 122
const FPS = 30
const FRAME = 1 / FPS

type FrameMetadataLite = {
  mediaTime?: number
  presentedFrames?: number
}

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: FrameMetadataLite) => void) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

type TransitionSkipDetail = {
  rightTimelineStart?: number
  timelineSkip?: number
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function quantize(time: number) {
  return Math.max(0, Math.round(Math.max(0, time) / FRAME) * FRAME)
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

function playheadElement() {
  return document.querySelector<HTMLElement>('.maghrabi-playhead')
    || document.querySelector<HTMLElement>('.maghrabi-studio-pro .bg-red-400.pointer-events-none')
}

function readPlayheadTime() {
  const timeline = timelineRoot()
  const playhead = playheadElement()
  if (!timeline || !playhead) return 0
  const zoom = parseZoom()
  const timelineRect = timeline.getBoundingClientRect()
  const playheadRect = playhead.getBoundingClientRect()
  return Math.max(0, (playheadRect.left + playheadRect.width / 2 - timelineRect.left - HEADER_WIDTH) / zoom)
}

function programPanel() {
  const labels = Array.from(document.querySelectorAll<HTMLElement>(`${ROOT} p`))
  const label = labels.find((item) => (item.textContent || '').trim().toUpperCase() === 'PROGRAM MONITOR')
  return label?.closest<HTMLElement>('div[class*="rounded-3xl"]') || null
}

function programVideo() {
  return programPanel()?.querySelector<HTMLVideoElement>('.aspect-video > video:not([controls])') || null
}

function programClockLabel() {
  const panel = programPanel()
  if (!panel) return null
  return Array.from(panel.querySelectorAll<HTMLParagraphElement>('p')).find((item) => /V1\s*Program/i.test(item.textContent || '')) || null
}

function formatTimecode(seconds: number) {
  const totalFrames = Math.max(0, Math.round(Math.max(0, seconds) * FPS))
  const frames = totalFrames % FPS
  const totalSeconds = Math.floor(totalFrames / FPS)
  const secs = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}:${String(frames).padStart(2, '0')}`
}

function formatProgramClock(seconds: number) {
  const safe = Math.max(0, seconds)
  const minutes = Math.floor(safe / 60)
  const secs = safe - minutes * 60
  return `${String(minutes).padStart(2, '0')}:${secs.toFixed(2).padStart(5, '0')}`
}

function v1ClipEndAt(time: number) {
  const timeline = timelineRoot()
  if (!timeline) return Number.POSITIVE_INFINITY
  const zoom = parseZoom()
  const clips = Array.from(timeline.querySelectorAll<HTMLButtonElement>('button[style*="left"][style*="width"]'))
    .filter((button) => /^V1\s*·/i.test((button.textContent || '').trim()))
    .map((button) => {
      const start = Math.max(0, (Number.parseFloat(button.style.left || '0') || 0) / zoom)
      const durationFromData = Number(button.dataset.maghrabiDuration)
      const duration = Number.isFinite(durationFromData) && durationFromData > 0
        ? durationFromData
        : Math.max(FRAME, (Number.parseFloat(button.style.width || '0') || button.getBoundingClientRect().width || 0) / zoom)
      return { start, end: start + duration }
    })
    .sort((a, b) => a.start - b.start)

  const clip = clips.find((item) => time >= item.start - FRAME * 1.5 && time <= item.end + FRAME * 1.5)
  return clip?.end ?? Number.POSITIVE_INFINITY
}

export default function StudioFrameClockPro() {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  const timecodeRef = useRef<HTMLSpanElement>(null)
  const statusRef = useRef<HTMLSpanElement>(null)
  const frameRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let disposed = false
    let currentVideo: FrameVideo | null = null
    let portalTarget: HTMLElement | null = null
    let frameHandle = 0
    let rafHandle = 0
    let idleTimer = 0
    let suspended = false
    let anchorTimeline = 0
    let anchorMedia = 0
    let anchorRate = 1
    let anchorClipEnd = Number.POSITIVE_INFINITY
    let source = 'IDLE'

    const updatePortalTarget = () => {
      const next = programPanel()
      if (next !== portalTarget) {
        portalTarget = next
        setTarget(next)
      }
    }

    const cancelLoop = () => {
      if (currentVideo && frameHandle && currentVideo.cancelVideoFrameCallback) {
        try { currentVideo.cancelVideoFrameCallback(frameHandle) } catch {}
      }
      if (rafHandle) window.cancelAnimationFrame(rafHandle)
      frameHandle = 0
      rafHandle = 0
    }

    const writeClock = (requestedTime: number, clockSource: string, playing: boolean, movePlayhead = true, presentedFrames?: number) => {
      const time = quantize(requestedTime)
      const frame = Math.max(0, Math.round(time * FPS))
      source = clockSource

      if (movePlayhead && !suspended && !document.body.classList.contains('maghrabi-scrubbing')) {
        const playhead = playheadElement()
        if (playhead) playhead.style.left = `${HEADER_WIDTH + time * parseZoom()}px`
      }

      document.documentElement.dataset.maghrabiFrameClockTime = time.toFixed(6)
      document.documentElement.dataset.maghrabiFrameClockFrame = String(frame)
      document.documentElement.dataset.maghrabiFrameClockSource = clockSource
      document.documentElement.dataset.maghrabiFrameClockPlaying = playing ? '1' : '0'

      const clockLabel = programClockLabel()
      if (clockLabel) clockLabel.textContent = `${formatProgramClock(time)} · V1 Program`
      if (timecodeRef.current) timecodeRef.current.textContent = formatTimecode(time)
      if (statusRef.current) statusRef.current.textContent = `FRAME CLOCK · ${clockSource} · ${FPS} FPS`
      if (frameRef.current) frameRef.current.textContent = `F${String(presentedFrames ?? frame).padStart(6, '0')}`

      window.dispatchEvent(new CustomEvent('maghrabi-frame-clock', {
        detail: { time, frame, fps: FPS, source: clockSource, playing, presentedFrames: presentedFrames ?? null },
      }))
      return time
    }

    const anchor = (video: FrameVideo, timelineOverride?: number) => {
      anchorTimeline = quantize(timelineOverride ?? readPlayheadTime())
      anchorMedia = Math.max(0, Number.isFinite(video.currentTime) ? video.currentTime : 0)
      anchorRate = Math.max(.25, Math.abs(Number(video.playbackRate) || 1))
      anchorClipEnd = v1ClipEndAt(anchorTimeline)
    }

    const timelineFromMedia = (video: FrameVideo, mediaTime: number) => {
      const rate = Math.max(.25, anchorRate)
      const elapsed = (mediaTime - anchorMedia) / rate
      const raw = anchorTimeline + elapsed
      return Number.isFinite(anchorClipEnd) ? clamp(raw, 0, anchorClipEnd) : Math.max(0, raw)
    }

    const scheduleLoop = () => {
      cancelLoop()
      const video = currentVideo
      if (!video || video.paused || video.ended || suspended) return

      if (typeof video.requestVideoFrameCallback === 'function') {
        const step = (_now: number, metadata: FrameMetadataLite) => {
          frameHandle = 0
          if (disposed || currentVideo !== video || video.paused || video.ended || suspended) return
          const mediaTime = Number.isFinite(metadata.mediaTime) ? Number(metadata.mediaTime) : video.currentTime
          writeClock(timelineFromMedia(video, mediaTime), 'RVFC', true, true, metadata.presentedFrames)
          frameHandle = video.requestVideoFrameCallback?.(step) || 0
        }
        frameHandle = video.requestVideoFrameCallback(step)
        return
      }

      const step = () => {
        rafHandle = 0
        if (disposed || currentVideo !== video || video.paused || video.ended || suspended) return
        writeClock(timelineFromMedia(video, video.currentTime), 'RAF', true)
        rafHandle = window.requestAnimationFrame(step)
      }
      rafHandle = window.requestAnimationFrame(step)
    }

    const detachVideo = () => {
      cancelLoop()
      if (!currentVideo) return
      currentVideo.removeEventListener('play', onPlay)
      currentVideo.removeEventListener('pause', onPause)
      currentVideo.removeEventListener('ended', onPause)
      currentVideo.removeEventListener('seeking', onSeeking)
      currentVideo.removeEventListener('seeked', onSeeked)
      currentVideo.removeEventListener('ratechange', onRateChange)
      currentVideo = null
    }

    const onPlay = () => {
      if (!currentVideo) return
      anchor(currentVideo)
      writeClock(anchorTimeline, currentVideo.requestVideoFrameCallback ? 'RVFC' : 'RAF', true)
      scheduleLoop()
    }

    const onPause = () => {
      cancelLoop()
      writeClock(readPlayheadTime(), 'PAUSED', false, false)
    }

    const onSeeking = () => cancelLoop()

    const onSeeked = () => {
      if (!currentVideo) return
      anchor(currentVideo)
      if (currentVideo.paused) writeClock(anchorTimeline, 'SEEK', false, false)
      else scheduleLoop()
    }

    const onRateChange = () => {
      if (!currentVideo) return
      const current = timelineFromMedia(currentVideo, currentVideo.currentTime)
      anchor(currentVideo, current)
      if (!currentVideo.paused) scheduleLoop()
    }

    const attachVideo = (next: HTMLVideoElement | null) => {
      if (next === currentVideo) return
      detachVideo()
      if (!next) return
      currentVideo = next as FrameVideo
      currentVideo.addEventListener('play', onPlay)
      currentVideo.addEventListener('pause', onPause)
      currentVideo.addEventListener('ended', onPause)
      currentVideo.addEventListener('seeking', onSeeking)
      currentVideo.addEventListener('seeked', onSeeked)
      currentVideo.addEventListener('ratechange', onRateChange)
      anchor(currentVideo)
      if (!currentVideo.paused && !currentVideo.ended) scheduleLoop()
    }

    const refresh = () => {
      updatePortalTarget()
      attachVideo(programVideo())
    }

    const onPointerDown = (event: PointerEvent) => {
      const targetElement = event.target instanceof Element ? event.target : null
      if (!targetElement?.closest('.maghrabi-playhead, .maghrabi-time-ruler')) return
      suspended = true
      cancelLoop()
    }

    const resumeAfterScrub = () => {
      if (!suspended) return
      suspended = false
      window.requestAnimationFrame(() => {
        refresh()
        if (!currentVideo) {
          writeClock(readPlayheadTime(), 'SCRUB', false, false)
          return
        }
        anchor(currentVideo)
        writeClock(anchorTimeline, 'SCRUB', !currentVideo.paused, false)
        if (!currentVideo.paused && !currentVideo.ended) scheduleLoop()
      })
    }

    const onTransitionSkip = (event: Event) => {
      const detail = (event as CustomEvent<TransitionSkipDetail>).detail || {}
      const start = Number(detail.rightTimelineStart)
      const skip = Math.max(0, Number(detail.timelineSkip) || 0)
      if (!Number.isFinite(start)) return
      const targetTime = quantize(start + skip)
      writeClock(targetTime, 'XFADE', Boolean(currentVideo && !currentVideo.paused), true)
      if (currentVideo) {
        anchor(currentVideo, targetTime)
        if (!currentVideo.paused && !currentVideo.ended) scheduleLoop()
      }
    }

    const observer = new MutationObserver(() => refresh())
    observer.observe(document.body, { childList: true, subtree: true })
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointerup', resumeAfterScrub, true)
    document.addEventListener('pointercancel', resumeAfterScrub, true)
    window.addEventListener('maghrabi-transition-skip-consumed', onTransitionSkip as EventListener)

    refresh()
    idleTimer = window.setInterval(() => {
      refresh()
      if (!currentVideo || currentVideo.paused || currentVideo.ended) {
        writeClock(readPlayheadTime(), source === 'XFADE' ? 'PAUSED' : 'IDLE', false, false)
      }
    }, 90)

    return () => {
      disposed = true
      window.clearInterval(idleTimer)
      observer.disconnect()
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointerup', resumeAfterScrub, true)
      document.removeEventListener('pointercancel', resumeAfterScrub, true)
      window.removeEventListener('maghrabi-transition-skip-consumed', onTransitionSkip as EventListener)
      detachVideo()
      delete document.documentElement.dataset.maghrabiFrameClockTime
      delete document.documentElement.dataset.maghrabiFrameClockFrame
      delete document.documentElement.dataset.maghrabiFrameClockSource
      delete document.documentElement.dataset.maghrabiFrameClockPlaying
    }
  }, [])

  if (!target) return null

  return createPortal(
    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-cyan-300/10 bg-cyan-300/[.035] px-3 py-2" dir="ltr" aria-label="Frame accurate playback clock">
      <span ref={timecodeRef} className="font-mono text-[10px] font-black tracking-[.08em] text-cyan-100">00:00:00:00</span>
      <span ref={statusRef} className="text-[8px] font-black tracking-[.12em] text-cyan-300/70">FRAME CLOCK · IDLE · 30 FPS</span>
      <span ref={frameRef} className="font-mono text-[8px] font-bold text-slate-500">F000000</span>
    </div>,
    target,
  )
}
