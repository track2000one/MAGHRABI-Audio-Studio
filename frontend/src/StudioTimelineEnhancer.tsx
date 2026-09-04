import { useEffect } from 'react'

const PLAYHEAD_SELECTOR = '.maghrabi-studio-pro .bg-red-400.pointer-events-none'
const HEADER_WIDTH = 122
const SNAP_THRESHOLD_PX = 9
const SNAP_KEY = 'maghrabi-studio-snap-enabled-v1'

function findScrubTarget(playhead: HTMLElement) {
  const timeline = playhead.parentElement
  if (!timeline) return null

  // Locate V12's dedicated adjustment row explicitly. Professional overlay
  // elements are appended after it, so relying on lastElementChild is unsafe.
  const adjustmentRow = Array.from(timeline.children).find((child) => {
    return child instanceof HTMLElement && child.className.includes('h-[52px]')
  }) as HTMLElement | undefined
  const target = adjustmentRow?.lastElementChild as HTMLElement | null
  return target || null
}

function parseZoom(root: ParentNode = document) {
  const spans = Array.from(root.querySelectorAll('span'))
  for (const span of spans) {
    const match = (span.textContent || '').match(/([\d.]+)\s*px\/s/i)
    if (match) return Math.max(1, Number(match[1]) || 12)
  }
  return 12
}

function formatTime(seconds: number) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const whole = Math.floor(safe)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const secs = whole % 60
  if (hours > 0) return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

function majorStepForZoom(zoom: number) {
  if (zoom >= 25) return 2
  if (zoom >= 18) return 5
  if (zoom >= 11) return 10
  if (zoom >= 7) return 20
  return 30
}

function findZoomInput() {
  return document.querySelector<HTMLInputElement>('.maghrabi-studio-pro input[type="range"][min="5"][max="30"]')
}

function findLaneSurface(target: EventTarget | null, timeline: HTMLElement) {
  let node = target instanceof HTMLElement ? target : null
  while (node && node !== timeline) {
    const row = node.parentElement
    if (row?.parentElement === timeline && row.className.includes('h-[66px]') && row.lastElementChild === node) return node
    node = node.parentElement
  }
  return null
}

function collectSnapClientXs(timeline: HTMLElement, playhead: HTMLElement, includePlayhead: boolean, exclude?: HTMLElement | null) {
  const values: number[] = []
  const timelineRect = timeline.getBoundingClientRect()

  timeline.querySelectorAll<HTMLElement>('button[style*="left"][style*="width"]').forEach((element) => {
    if (element === exclude || element.closest('.maghrabi-time-ruler')) return
    const rect = element.getBoundingClientRect()
    if (!rect.width || rect.right < timelineRect.left || rect.left > timelineRect.right) return
    values.push(rect.left, rect.right)
  })

  timeline.querySelectorAll<HTMLElement>('div[style*="left"]').forEach((element) => {
    if (element === playhead || element.closest('.maghrabi-time-ruler')) return
    const rect = element.getBoundingClientRect()
    if (rect.width <= 5 && rect.height > 20) values.push(rect.left + rect.width / 2)
  })

  if (includePlayhead) {
    const rect = playhead.getBoundingClientRect()
    values.push(rect.left + rect.width / 2)
  }

  return values
}

function nearestSnap(clientX: number, candidates: number[]) {
  let best: number | null = null
  let distance = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    const delta = Math.abs(candidate - clientX)
    if (delta < distance) {
      best = candidate
      distance = delta
    }
  }
  return best !== null && distance <= SNAP_THRESHOLD_PX ? best : null
}

export default function StudioTimelineEnhancer() {
  useEffect(() => {
    let activeCleanup: (() => void) | null = null
    let enhancementCleanup: (() => void) | null = null
    let scheduled = 0
    let snapEnabled = localStorage.getItem(SNAP_KEY) !== '0'
    const syntheticDrops = new WeakSet<Event>()

    const enhance = () => {
      const playhead = document.querySelector<HTMLElement>(PLAYHEAD_SELECTOR)
      if (!playhead) return
      const timeline = playhead.parentElement as HTMLElement | null
      if (!timeline) return
      if (playhead.dataset.maghrabiProfessionalTimeline === '1') return

      enhancementCleanup?.()
      playhead.dataset.maghrabiProfessionalTimeline = '1'
      playhead.dataset.maghrabiDraggable = '1'
      playhead.classList.add('maghrabi-playhead')
      playhead.style.pointerEvents = 'auto'
      playhead.setAttribute('role', 'slider')
      playhead.setAttribute('aria-label', 'Timeline playhead — اسحب لتغيير موضع التشغيل')
      playhead.title = 'اسحب المؤشر لتغيير موضع التشغيل'

      const ruler = document.createElement('div')
      ruler.className = 'maghrabi-time-ruler'
      ruler.setAttribute('aria-label', 'Timeline time ruler')
      ruler.title = 'انقر أو اسحب لتحريك Playhead · Ctrl/Cmd + Wheel للتكبير'
      timeline.insertBefore(ruler, timeline.firstChild)

      const snapGuide = document.createElement('div')
      snapGuide.className = 'maghrabi-snap-guide'
      timeline.appendChild(snapGuide)

      const hoverGuide = document.createElement('div')
      hoverGuide.className = 'maghrabi-hover-guide'
      timeline.appendChild(hoverGuide)

      const hoverBadge = document.createElement('div')
      hoverBadge.className = 'maghrabi-hover-time'
      timeline.appendChild(hoverBadge)

      const showSnapGuide = (clientX: number, label = 'SNAP') => {
        const rect = timeline.getBoundingClientRect()
        snapGuide.style.left = `${clientX - rect.left}px`
        snapGuide.dataset.label = label
        snapGuide.classList.add('is-visible')
      }
      const hideSnapGuide = () => snapGuide.classList.remove('is-visible')

      const renderRuler = (rulerElement: HTMLElement, timelineElement: HTMLElement) => {
        const zoom = parseZoom()
        const signature = `${zoom}:${timelineElement.offsetWidth}:${snapEnabled}`
        if (rulerElement.dataset.signature === signature) return
        rulerElement.dataset.signature = signature
        rulerElement.replaceChildren()

        const corner = document.createElement('div')
        corner.className = 'maghrabi-ruler-corner'
        const title = document.createElement('span')
        title.textContent = 'TIME'
        corner.appendChild(title)
        const snapToggle = document.createElement('button')
        snapToggle.type = 'button'
        snapToggle.className = `maghrabi-snap-toggle${snapEnabled ? ' is-on' : ''}`
        snapToggle.textContent = snapEnabled ? 'SNAP ON' : 'SNAP OFF'
        snapToggle.title = 'Magnetic Snap · اضغط Alt أثناء السحب لتعطيله مؤقتًا'
        snapToggle.addEventListener('pointerdown', (event) => event.stopPropagation())
        snapToggle.addEventListener('click', (event) => {
          event.stopPropagation()
          snapEnabled = !snapEnabled
          localStorage.setItem(SNAP_KEY, snapEnabled ? '1' : '0')
          rulerElement.dataset.signature = ''
          renderRuler(rulerElement, timelineElement)
          hideSnapGuide()
        })
        corner.appendChild(snapToggle)
        rulerElement.appendChild(corner)

        const major = majorStepForZoom(zoom)
        const minor = major / 5
        const totalSeconds = Math.max(0, (timelineElement.offsetWidth - HEADER_WIDTH) / zoom)
        const maxTicks = 600
        const count = Math.min(maxTicks, Math.ceil(totalSeconds / minor) + 1)
        const fragment = document.createDocumentFragment()
        for (let index = 0; index < count; index++) {
          const time = index * minor
          const isMajor = Math.abs((time / major) - Math.round(time / major)) < 0.001
          const tick = document.createElement('div')
          tick.className = `maghrabi-ruler-tick${isMajor ? ' is-major' : ''}`
          tick.style.left = `${HEADER_WIDTH + time * zoom}px`
          if (isMajor) {
            const label = document.createElement('span')
            label.textContent = formatTime(time)
            tick.appendChild(label)
          }
          fragment.appendChild(tick)
        }
        rulerElement.appendChild(fragment)
      }

      const scrub = (clientX: number, bypassSnap = false) => {
        const target = findScrubTarget(playhead)
        if (!target) return
        let x = clientX
        if (snapEnabled && !bypassSnap) {
          const snap = nearestSnap(x, collectSnapClientXs(timeline, playhead, false))
          if (snap !== null) {
            x = snap
            showSnapGuide(snap)
          } else hideSnapGuide()
        } else hideSnapGuide()

        const rect = target.getBoundingClientRect()
        if (!rect.width) return
        x = Math.min(Math.max(x, rect.left), rect.right - 1)
        target.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: rect.top + rect.height / 2,
          view: window,
        }))
      }

      const beginScrub = (event: PointerEvent, origin: HTMLElement) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        origin.setPointerCapture?.(event.pointerId)
        playhead.classList.add('maghrabi-playhead--dragging')
        document.body.classList.add('maghrabi-scrubbing')
        scrub(event.clientX, event.altKey)

        const onMove = (moveEvent: PointerEvent) => {
          moveEvent.preventDefault()
          scrub(moveEvent.clientX, moveEvent.altKey)
        }
        const finish = () => {
          document.removeEventListener('pointermove', onMove)
          document.removeEventListener('pointerup', finish)
          document.removeEventListener('pointercancel', finish)
          playhead.classList.remove('maghrabi-playhead--dragging')
          document.body.classList.remove('maghrabi-scrubbing')
          hideSnapGuide()
          activeCleanup = null
        }
        activeCleanup = finish
        document.addEventListener('pointermove', onMove, { passive: false })
        document.addEventListener('pointerup', finish, { once: true })
        document.addEventListener('pointercancel', finish, { once: true })
      }

      const onPlayheadDown = (event: PointerEvent) => beginScrub(event, playhead)
      const onRulerDown = (event: PointerEvent) => {
        const target = event.target as HTMLElement | null
        if (target?.closest('.maghrabi-snap-toggle')) return
        beginScrub(event, ruler)
      }

      const onTimelineMove = (event: PointerEvent) => {
        if (document.body.classList.contains('maghrabi-scrubbing')) return
        const rect = timeline.getBoundingClientRect()
        const contentLeft = rect.left + HEADER_WIDTH
        if (event.clientX < contentLeft || event.clientX > rect.right) {
          hoverGuide.classList.remove('is-visible')
          hoverBadge.classList.remove('is-visible')
          return
        }
        const zoom = parseZoom()
        let x = event.clientX
        let snapped = false
        if (snapEnabled && !event.altKey) {
          const snap = nearestSnap(x, collectSnapClientXs(timeline, playhead, true))
          if (snap !== null) {
            x = snap
            snapped = true
          }
        }
        const relative = Math.max(HEADER_WIDTH, Math.min(timeline.offsetWidth, x - rect.left))
        const time = Math.max(0, (relative - HEADER_WIDTH) / zoom)
        hoverGuide.style.left = `${relative}px`
        hoverGuide.classList.toggle('is-snapped', snapped)
        hoverGuide.classList.add('is-visible')
        hoverBadge.style.left = `${relative}px`
        hoverBadge.textContent = `${snapped ? 'SNAP · ' : ''}${formatTime(time)}`
        hoverBadge.classList.toggle('is-snapped', snapped)
        hoverBadge.classList.add('is-visible')
      }
      const onTimelineLeave = () => {
        if (!document.body.classList.contains('maghrabi-scrubbing')) {
          hoverGuide.classList.remove('is-visible')
          hoverBadge.classList.remove('is-visible')
          hideSnapGuide()
        }
      }

      let activeDragged: HTMLElement | null = null
      const onDragStart = (event: DragEvent) => {
        const element = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('button[draggable="true"]') : null
        activeDragged = element
      }
      const onDragEnd = () => {
        activeDragged = null
        hideSnapGuide()
      }
      const onDragOverCapture = (event: DragEvent) => {
        if (!snapEnabled || event.altKey || event.clientX <= timeline.getBoundingClientRect().left + HEADER_WIDTH) {
          hideSnapGuide()
          return
        }
        const snap = nearestSnap(event.clientX, collectSnapClientXs(timeline, playhead, true, activeDragged))
        if (snap !== null) showSnapGuide(snap, 'MAGNETIC SNAP')
        else hideSnapGuide()
      }
      const onDropCapture = (event: DragEvent) => {
        if (syntheticDrops.has(event) || !snapEnabled || event.altKey) return
        const laneSurface = findLaneSurface(event.target, timeline)
        if (!laneSurface) return
        const snap = nearestSnap(event.clientX, collectSnapClientXs(timeline, playhead, true, activeDragged))
        if (snap === null || Math.abs(snap - event.clientX) < 0.5) return

        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        const synthetic = new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          clientX: snap,
          clientY: event.clientY,
        })
        syntheticDrops.add(synthetic)
        laneSurface.dispatchEvent(synthetic)
        hideSnapGuide()
      }

      const scroller = timeline.parentElement as HTMLElement | null
      const zoomInput = findZoomInput()
      const onZoomInput = () => {
        ruler.dataset.signature = ''
        requestAnimationFrame(() => renderRuler(ruler, timeline))
      }
      zoomInput?.addEventListener('input', onZoomInput)

      const resizeObserver = typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            ruler.dataset.signature = ''
            renderRuler(ruler, timeline)
          })
        : null
      resizeObserver?.observe(timeline)

      const onWheel = (event: WheelEvent) => {
        if (!(event.ctrlKey || event.metaKey) || !scroller || !zoomInput) return
        event.preventDefault()
        const current = Number(zoomInput.value) || 12
        const min = Number(zoomInput.min) || 5
        const max = Number(zoomInput.max) || 30
        const next = Math.min(max, Math.max(min, current + (event.deltaY < 0 ? 2 : -2)))
        if (next === current) return

        const rect = scroller.getBoundingClientRect()
        const localX = event.clientX - rect.left
        const anchorContentX = scroller.scrollLeft + localX
        const anchorTime = Math.max(0, (anchorContentX - HEADER_WIDTH) / current)
        zoomInput.value = String(next)
        zoomInput.dispatchEvent(new Event('input', { bubbles: true }))
        zoomInput.dispatchEvent(new Event('change', { bubbles: true }))
        requestAnimationFrame(() => {
          scroller.scrollLeft = Math.max(0, HEADER_WIDTH + anchorTime * next - localX)
          ruler.dataset.signature = ''
          renderRuler(ruler, timeline)
        })
      }

      ruler.addEventListener('pointerdown', onRulerDown)
      playhead.addEventListener('pointerdown', onPlayheadDown)
      timeline.addEventListener('pointermove', onTimelineMove)
      timeline.addEventListener('pointerleave', onTimelineLeave)
      document.addEventListener('dragstart', onDragStart, true)
      document.addEventListener('dragend', onDragEnd, true)
      timeline.addEventListener('dragover', onDragOverCapture, true)
      timeline.addEventListener('drop', onDropCapture, true)
      scroller?.addEventListener('wheel', onWheel, { passive: false })
      renderRuler(ruler, timeline)

      enhancementCleanup = () => {
        activeCleanup?.()
        ruler.removeEventListener('pointerdown', onRulerDown)
        playhead.removeEventListener('pointerdown', onPlayheadDown)
        timeline.removeEventListener('pointermove', onTimelineMove)
        timeline.removeEventListener('pointerleave', onTimelineLeave)
        document.removeEventListener('dragstart', onDragStart, true)
        document.removeEventListener('dragend', onDragEnd, true)
        timeline.removeEventListener('dragover', onDragOverCapture, true)
        timeline.removeEventListener('drop', onDropCapture, true)
        scroller?.removeEventListener('wheel', onWheel)
        zoomInput?.removeEventListener('input', onZoomInput)
        resizeObserver?.disconnect()
        ruler.remove()
        snapGuide.remove()
        hoverGuide.remove()
        hoverBadge.remove()
        document.body.classList.remove('maghrabi-scrubbing')
      }
    }

    const scheduleEnhance = () => {
      if (scheduled) cancelAnimationFrame(scheduled)
      scheduled = requestAnimationFrame(() => {
        scheduled = 0
        enhance()
      })
    }

    scheduleEnhance()
    const observer = new MutationObserver(scheduleEnhance)
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })

    return () => {
      observer.disconnect()
      if (scheduled) cancelAnimationFrame(scheduled)
      enhancementCleanup?.()
      activeCleanup?.()
      document.body.classList.remove('maghrabi-scrubbing')
    }
  }, [])

  return null
}
