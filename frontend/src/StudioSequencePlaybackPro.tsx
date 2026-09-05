import { useEffect } from 'react'

const ROOT = '.maghrabi-studio-pro main'
const HEADER_WIDTH = 122

type ClipBox = {
  button: HTMLButtonElement
  start: number
  end: number
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

function v1Clips(): ClipBox[] {
  const zoom = parseZoom()
  const timeline = timelineRoot()
  if (!timeline) return []
  return Array.from(timeline.querySelectorAll<HTMLButtonElement>('button[style*="left"][style*="width"]'))
    .filter((button) => /^V1\s*·/i.test((button.textContent || '').trim()))
    .map((button) => {
      const start = Math.max(0, (Number.parseFloat(button.style.left) || 0) / zoom)
      const duration = Math.max(.02, (Number.parseFloat(button.style.width) || button.getBoundingClientRect().width || 0) / zoom)
      return { button, start, end: start + duration }
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
      next.button.click()
      waitForNextVideo(previous, (nextVideo) => {
        if (!sequenceActive) { advancing = false; return }
        nextVideo.play().then(() => {
          document.documentElement.dataset.maghrabiSequencePlaying = '1'
          advancing = false
        }).catch(() => {
          stop()
        })
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
