import { useEffect } from 'react'

const PLAYHEAD_SELECTOR = '.maghrabi-studio-pro .bg-red-400.pointer-events-none'

function findScrubTarget(playhead: HTMLElement) {
  const timeline = playhead.parentElement
  if (!timeline) return null

  // The adjustment lane is the final row in V12 and its timeline surface
  // only updates the playhead, so scrubbing never triggers Razor edits.
  const adjustmentRow = timeline.lastElementChild as HTMLElement | null
  const target = adjustmentRow?.lastElementChild as HTMLElement | null
  return target || null
}

export default function StudioTimelineEnhancer() {
  useEffect(() => {
    let activeCleanup: (() => void) | null = null

    const enhance = () => {
      const playhead = document.querySelector<HTMLElement>(PLAYHEAD_SELECTOR)
      if (!playhead || playhead.dataset.maghrabiDraggable === '1') return

      playhead.dataset.maghrabiDraggable = '1'
      playhead.classList.add('maghrabi-playhead')
      playhead.style.pointerEvents = 'auto'
      playhead.setAttribute('role', 'slider')
      playhead.setAttribute('aria-label', 'Timeline playhead — اسحب لتغيير موضع التشغيل')
      playhead.title = 'اسحب المؤشر لتغيير موضع التشغيل'

      const onPointerDown = (event: PointerEvent) => {
        if (event.button !== 0) return
        const target = findScrubTarget(playhead)
        if (!target) return

        event.preventDefault()
        event.stopPropagation()
        playhead.classList.add('maghrabi-playhead--dragging')
        document.body.classList.add('maghrabi-scrubbing')

        const scrub = (clientX: number) => {
          const rect = target.getBoundingClientRect()
          if (!rect.width) return
          const x = Math.min(Math.max(clientX, rect.left), rect.right - 1)
          target.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: rect.top + rect.height / 2,
            view: window,
          }))
        }

        scrub(event.clientX)

        const onMove = (moveEvent: PointerEvent) => {
          moveEvent.preventDefault()
          scrub(moveEvent.clientX)
        }

        const finish = () => {
          document.removeEventListener('pointermove', onMove)
          document.removeEventListener('pointerup', finish)
          document.removeEventListener('pointercancel', finish)
          playhead.classList.remove('maghrabi-playhead--dragging')
          document.body.classList.remove('maghrabi-scrubbing')
          activeCleanup = null
        }

        activeCleanup = finish
        document.addEventListener('pointermove', onMove, { passive: false })
        document.addEventListener('pointerup', finish, { once: true })
        document.addEventListener('pointercancel', finish, { once: true })
      }

      playhead.addEventListener('pointerdown', onPointerDown)
    }

    enhance()
    const observer = new MutationObserver(enhance)
    observer.observe(document.body, { childList: true, subtree: true })

    return () => {
      observer.disconnect()
      activeCleanup?.()
      document.body.classList.remove('maghrabi-scrubbing')
    }
  }, [])

  return null
}
