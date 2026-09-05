import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { getActiveStudioProjectId } from './lib/projectHubStore'
import { loadCreativeSettings, type CreativeProjectSettings } from './lib/creativeProjectSettings'

const HEADER_WIDTH = 122

function parseZoom() {
  const spans = Array.from(document.querySelectorAll<HTMLSpanElement>('.maghrabi-studio-pro main span'))
  for (const span of spans) {
    const match = (span.textContent || '').match(/([\d.]+)\s*px\/s/i)
    if (match) return Math.max(1, Number(match[1]) || 12)
  }
  return 12
}

function currentTime() {
  const ruler = document.querySelector<HTMLElement>('.maghrabi-time-ruler')
  const timeline = ruler?.parentElement
  const playhead = document.querySelector<HTMLElement>('.maghrabi-playhead')
  if (!timeline || !playhead) return 0
  const zoom = parseZoom()
  const t = timeline.getBoundingClientRect()
  const p = playhead.getBoundingClientRect()
  return Math.max(0, (p.left + p.width / 2 - t.left - HEADER_WIDTH) / zoom)
}

function previewTarget() {
  const labels = Array.from(document.querySelectorAll<HTMLElement>('.maghrabi-studio-pro main p'))
  const label = labels.find((item) => (item.textContent || '').trim().toUpperCase() === 'PROGRAM MONITOR')
  const panel = label?.closest<HTMLElement>('div[class*="rounded-3xl"]')
  return panel?.querySelector<HTMLElement>('.aspect-video') || null
}

export default function StudioTitlePreviewPro() {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  const [time, setTime] = useState(0)
  const [settings, setSettings] = useState<CreativeProjectSettings>(() => loadCreativeSettings(getActiveStudioProjectId()))

  useEffect(() => {
    let timer = 0
    let observer: MutationObserver | null = null
    const refreshTarget = () => setTarget((current) => previewTarget() || current)
    timer = window.setInterval(() => {
      setTime(currentTime())
      refreshTarget()
    }, 90)
    observer = new MutationObserver(refreshTarget)
    observer.observe(document.body, { childList: true, subtree: true })
    refreshTarget()
    return () => {
      window.clearInterval(timer)
      observer?.disconnect()
    }
  }, [])

  useEffect(() => {
    const reload = () => setSettings(loadCreativeSettings(getActiveStudioProjectId()))
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ settings?: CreativeProjectSettings }>).detail
      if (detail?.settings) setSettings(detail.settings)
      else reload()
    }
    window.addEventListener('maghrabi-active-project-changed', reload)
    window.addEventListener('maghrabi-creative-settings-changed', changed as EventListener)
    return () => {
      window.removeEventListener('maghrabi-active-project-changed', reload)
      window.removeEventListener('maghrabi-creative-settings-changed', changed as EventListener)
    }
  }, [])

  if (!target) return null
  const active = settings.titles.filter((item) => item.text.trim() && time >= item.startAt && time <= item.endAt)

  return createPortal(
    <div className="maghrabi-title-preview-layer" aria-hidden="true">
      {active.map((item) => (
        <div key={item.id} className={`maghrabi-title-preview is-${item.position} is-${item.kind}`}>
          <span
            dir="auto"
            style={{
              fontSize: `clamp(14px, ${Math.max(18, item.size) / 18}vw, ${Math.max(18, item.size)}px)`,
              color: item.kind === 'subtitle' ? item.color : '#ffffff',
              background: `rgba(0,0,0,${item.kind === 'subtitle' ? item.boxOpacity : Math.min(.42, item.boxOpacity)})`,
            }}
          >
            {item.text}
          </span>
        </div>
      ))}
    </div>,
    target,
  )
}
