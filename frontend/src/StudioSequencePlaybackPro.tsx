import { useEffect } from 'react'

const ROOT = '.maghrabi-studio-pro main'
const HEADER_WIDTH = 122

type ClipBox = {
  button: HTMLButtonElement
  start: number
  end: number
  fileIndex: number | null
}

type TransitionSkipPlan = {
  type: string
  rightFileIndex: number
  rightTimelineStart: number
  rightSourceStart: number
  sourceSkip: number
  timelineSkip: number
  expiresAt: number
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
  const timelineRect = timeline.getBoundingClientRect()
  const playheadRect = playhead.getBoundingClientRect()
  return Math.max(0, (playheadRect.left + playheadRect.width / 2 - timelineRect.left - HEADER_WIDTH) / zoom)
}

function clipTimingFromLabel(button: HTMLButtonElement) {
  const spans = Array.from(button.querySelectorAll<HTMLSpanElement>('span'))
  for (const span of spans) {
    const match = (span.textContent || '').match(/(\d+:\d+(?:\.\d+)?)\s*·\s*(\d+:\d+(?:\.\d+)?)/)
    if (!match) continue
    const start = parseClock(match[1])
    const duration = parseClock(match[2])
    if (Number.isFinite(start) && Number.isFinite(duration) && duration > 0) return { start, duration }
  }
  return null
}

function clipFileIndex(button: HTMLButtonElement) {
  const match = (button.textContent || '').trim().match(/^V1\s*·\s*V(\d+)/i)
  return match ? Math.max(0, Number(match[1]) - 1) : null
}

function v1Clips(): ClipBox[] {
  const zoom = parseZoom()
  const timeline = timelineRoot()
  if (!timeline) return []
  return Array.from(timeline.querySelectorAll<HTMLButtonElement>('button[style*="left"][style*="width"]'))
    .filter((button) => /^V1\s*·/i.test((button.textContent || '').trim()))
    .map((button) => {
      const labelled = clipTimingFromLabel(button)
      const start = labelled?.start ?? Math.max(0, (Number.parseFloat(button.style.left) || 0) / zoom)
      const duration = labelled?.duration ?? Math.max(.02, (Number.parseFloat(button.style.width) || button.getBoundingClientRect().width || 0) / zoom)
      return { button, start, end: start + duration, fileIndex: clipFileIndex(button) }
    })
    .sort((a, b) => a.start - b.start)
}

function programPanel() {
  const labels = Array.from(document.querySelectorAll<HTMLElement>(`${ROOT} p`))
  const label = labels.find((item) => (item.textContent || '').trim().toUpperCase() === 'PROGRAM MONITOR')
  return label?.closest<HTMLElement>('div[class*="rounded-3xl"]') || null
}

function programVideo() {
  return programPanel()?.querySelector<HTMLVideoElement>('.aspect-video > video:not([controls])') || null
}

function currentAndNext() {
  const time = playheadTime()
  const clips = v1Clips()
  if (!clips.length) return { current: null, next: null, time }
  let currentIndex = clips.findIndex((clip) => time >= clip.start - .06 && time <= clip.end + .12)
  if (currentIndex < 0) currentIndex = clips.findIndex((clip) => clip.start > time)
  if (currentIndex < 0) return { current: clips[clips.length - 1], next: null, time }
  const current = clips[currentIndex]
  const next = clips[currentIndex + 1] || null
  return { current, next, time }
}

function waitForNextVideo(previous: HTMLVideoElement | null, onReady: (video: HTMLVideoElement) => void, attempt = 0) {
  const video = programVideo()
  if (video && video !== previous && video.isConnected) {
    onReady(video)
    return
  }
  if (attempt >= 18) return
  window.setTimeout(() => waitForNextVideo(previous, onReady, attempt + 1), 35)
}

function transitionSkipFor(next: ClipBox): TransitionSkipPlan | null {
  const raw = document.documentElement.dataset.maghrabiTransitionSkip
  if (!raw) return null
  try {
    const plan = JSON.parse(raw) as TransitionSkipPlan
    if (!Number.isFinite(plan.expiresAt) || Date.now() > plan.expiresAt) {
      delete document.documentElement.dataset.maghrabiTransitionSkip
      return null
    }
    if (next.fileIndex !== null && Number(plan.rightFileIndex) !== next.fileIndex) return null
    if (Math.abs(Number(plan.rightTimelineStart) - next.start) > .45) return null
    if (!Number.isFinite(plan.rightSourceStart) || !Number.isFinite(plan.sourceSkip)) return null
    return plan
  } catch {
    delete document.documentElement.dataset.maghrabiTransitionSkip
    return null
  }
}

function markTransitionSkipConsumed(plan: TransitionSkipPlan) {
  delete document.documentElement.dataset.maghrabiTransitionSkip
  window.dispatchEvent(new CustomEvent('maghrabi-transition-skip-consumed', { detail: plan }))
}

function seekAfterTransition(video: HTMLVideoElement, plan: TransitionSkipPlan, done: () => void) {
  let finished = false
  let fallback = 0
  const finish = () => {
    if (finished) return
    finished = true
    window.clearTimeout(fallback)
    video.removeEventListener('loadedmetadata', apply)
    done()
  }
  const apply = () => {
    const requested = Math.max(0, Number(plan.rightSourceStart) + Math.max(0, Number(plan.sourceSkip)))
    const target = Number.isFinite(video.duration) && video.duration > .05
      ? Math.min(requested, Math.max(0, video.duration - .02))
      : requested
    try { video.currentTime = target } catch {}
    markTransitionSkipConsumed(plan)
    finish()
  }

  if (video.readyState >= 1) apply()
  else {
    video.addEventListener('loadedmetadata', apply, { once: true })
    fallback = window.setTimeout(apply, 500)
  }
}

export default function StudioSequencePlaybackPro() {
  useEffect(() => {
    let sequenceActive = false
    let advancing = false
    let attachedVideo: HTMLVideoElement | null = null
    let observer: MutationObserver | null = null

    const stop = () => {
      sequenceActive = false
      advancing = false
      document.documentElement.dataset.maghrabiSequencePlaying = '0'
      delete document.documentElement.dataset.maghrabiTransitionSkip
    }

    const advance = (video: HTMLVideoElement) => {
      if (!sequenceActive || advancing) return
      const { current, next, time } = currentAndNext()
      if (!current || time < current.end - .16) return
      if (!next) { stop(); return }

      // Keep intentional gaps visible instead of silently skipping them.
      const gap = Math.max(0, next.start - current.end)
      if (gap > .35) { stop(); return }

      advancing = true
      const previous = video
      const skipPlan = transitionSkipFor(next)
      next.button.click()
      waitForNextVideo(previous, (nextVideo) => {
        if (!sequenceActive) { advancing = false; return }

        const resume = () => {
          nextVideo.play().then(() => {
            document.documentElement.dataset.maghrabiSequencePlaying = '1'
            advancing = false
          }).catch(() => {
            stop()
          })
        }

        if (skipPlan) seekAfterTransition(nextVideo, skipPlan, resume)
        else resume()
      })
    }

    const attach = () => {
      const next = programVideo()
      if (!next || next === attachedVideo) return
      if (attachedVideo) attachedVideo.removeEventListener('pause', onPause)
      attachedVideo = next
      attachedVideo.addEventListener('pause', onPause)
    }

    function onPause(this: HTMLVideoElement) {
      if (!sequenceActive || advancing) return
      window.setTimeout(() => advance(this), 20)
    }

    const onClick = (event: MouseEvent) => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(`${ROOT} button`) : null
      if (!button || button.disabled) return
      const text = (button.textContent || '').trim().toUpperCase()
      if (/^PLAY/.test(text)) {
        sequenceActive = true
        document.documentElement.dataset.maghrabiSequencePlaying = '1'
        window.setTimeout(attach, 20)
      } else if (/^PAUSE/.test(text)) {
        stop()
      }
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.maghrabi-playhead, .maghrabi-time-ruler')) stop()
    }

    document.addEventListener('click', onClick, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    const root = document.querySelector(ROOT)
    if (root) {
      observer = new MutationObserver(() => attach())
      observer.observe(root, { childList: true, subtree: true })
    }
    attach()

    return () => {
      stop()
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      attachedVideo?.removeEventListener('pause', onPause)
      observer?.disconnect()
      delete document.documentElement.dataset.maghrabiSequencePlaying
    }
  }, [])

  return <div className="maghrabi-sequence-playback-indicator" aria-hidden="true">SEQUENCE PLAYBACK</div>
}
