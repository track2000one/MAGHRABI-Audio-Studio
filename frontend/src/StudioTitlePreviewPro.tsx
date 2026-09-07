import { useEffect, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { getActiveStudioProjectId } from './lib/projectHubStore'
import { loadCreativeSettings, type CreativeProjectSettings, type CreativeTitle } from './lib/creativeProjectSettings'

const HEADER_WIDTH = 122

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function parseZoom() {
  const spans = Array.from(document.querySelectorAll<HTMLSpanElement>('.maghrabi-studio-pro main span'))
  for (const span of spans) {
    const match = (span.textContent || '').match(/([\d.]+)\s*px\/s/i)
    if (match) return Math.max(1, Number(match[1]) || 12)
  }
  return 12
}

function currentTime() {
  const dataClock = Number(document.documentElement.dataset.maghrabiFrameClockTime)
  if (Number.isFinite(dataClock)) return Math.max(0, dataClock)
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

function rgba(hex: string | undefined, opacity: number) {
  const value = /^#[0-9a-f]{6}$/i.test(String(hex || '')) ? String(hex) : '#000000'
  const r = Number.parseInt(value.slice(1, 3), 16)
  const g = Number.parseInt(value.slice(3, 5), 16)
  const b = Number.parseInt(value.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${clamp(opacity, 0, 1)})`
}

function fontFamily(title: CreativeTitle) {
  if (title.fontPreset?.startsWith('serif')) return 'Georgia, "Times New Roman", serif'
  if (title.fontPreset?.startsWith('mono')) return '"Cascadia Mono", "Courier New", monospace'
  return 'Inter, Arial, sans-serif'
}

function motion(title: CreativeTitle, time: number) {
  const animation = title.animation || 'none'
  if (animation === 'none') return { opacity: 1, dx: 0, dy: 0, scale: 1 }
  const enterDuration = animation === 'pop' ? .22 : .36
  const exitDuration = .26
  const enter = clamp((time - title.startAt) / enterDuration, 0, 1)
  const exit = clamp((title.endAt - time) / exitDuration, 0, 1)
  const opacity = Math.min(enter, exit)
  if (animation === 'slide-up') return { opacity, dx: 0, dy: (1 - enter) * 46, scale: 1 }
  if (animation === 'slide-left') return { opacity, dx: (1 - enter) * 130, dy: 0, scale: 1 }
  if (animation === 'slide-right') return { opacity, dx: -(1 - enter) * 130, dy: 0, scale: 1 }
  if (animation === 'pop') return { opacity, dx: 0, dy: (1 - enter) * 20, scale: .82 + enter * .18 }
  return { opacity, dx: 0, dy: 0, scale: 1 }
}

function styleFor(title: CreativeTitle, time: number): CSSProperties {
  const x = clamp(Number(title.x ?? .5), 0, 1)
  const defaultY = title.position === 'top' ? .08 : title.position === 'center' ? .5 : .92
  const y = clamp(Number(title.y ?? defaultY), 0, 1)
  const effect = motion(title, time)
  const borderWidth = clamp(Number(title.borderWidth ?? 0), 0, 10)
  const shadowDistance = clamp(Number(title.shadowDistance ?? 2), 0, 14)
  const fontPreset = title.fontPreset || 'sans-bold'
  const fontWeight = fontPreset.endsWith('bold') ? 800 : 500
  return {
    position: 'absolute',
    left: `${x * 100}%`,
    top: `${y * 100}%`,
    transform: `translate(-50%, -50%) translate(${effect.dx}px, ${effect.dy}px) scale(${effect.scale})`,
    opacity: effect.opacity,
    fontSize: `clamp(14px, ${Math.max(18, title.size) / 18}vw, ${Math.max(18, title.size)}px)`,
    fontFamily: fontFamily(title),
    fontWeight,
    lineHeight: 1.18,
    color: title.color || '#ffffff',
    background: rgba(title.boxColor, Number(title.boxOpacity ?? 0)),
    padding: `${Math.max(0, Number(title.boxPadding ?? 12)) * .45}px ${Math.max(0, Number(title.boxPadding ?? 12)) * .72}px`,
    borderRadius: '10px',
    textAlign: title.align || 'center',
    whiteSpace: 'pre-wrap',
    maxWidth: '88%',
    width: 'max-content',
    textShadow: shadowDistance > 0 ? `${shadowDistance}px ${shadowDistance}px ${Math.max(2, shadowDistance * 1.5)}px ${title.shadowColor || '#000000'}` : 'none',
    WebkitTextStroke: borderWidth > 0 ? `${Math.max(.5, borderWidth * .55)}px ${title.borderColor || '#000000'}` : undefined,
    transition: 'opacity 70ms linear, transform 70ms linear',
    pointerEvents: 'none',
  }
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
    }, 70)
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
      {active.map((item) => <span key={item.id} dir="auto" style={styleFor(item, time)}>{item.text}</span>)}
    </div>,
    target,
  )
}