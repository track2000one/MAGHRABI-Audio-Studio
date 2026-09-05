import { useEffect, useRef, useState } from 'react'
import {
  Captions,
  Gauge,
  Layers3,
  Palette,
  Plus,
  SlidersHorizontal,
  Trash2,
  Volume2,
  WandSparkles,
  X,
} from 'lucide-react'
import { getActiveStudioProjectId } from './lib/projectHubStore'
import {
  applyCreativeSettingsToManifest,
  CREATIVE_LOOKS,
  CREATIVE_TRANSITIONS,
  loadCreativeSettings,
  saveCreativeSettings,
  type CreativeProjectSettings,
  type CreativeTab,
  type CreativeTitle,
} from './lib/creativeProjectSettings'
import type { SpeedRampPreset, VideoProjectManifestV12 } from './lib/videoApi'

const tabs: Array<{ id: CreativeTab; label: string; icon: typeof Palette }> = [
  { id: 'looks', label: 'LOOKS', icon: Palette },
  { id: 'transitions', label: 'TRANSITIONS', icon: Layers3 },
  { id: 'titles', label: 'TITLES', icon: Captions },
  { id: 'speed', label: 'SPEED', icon: Gauge },
  { id: 'audio', label: 'AUDIO', icon: Volume2 },
]

const speedRamps: Array<{ value: SpeedRampPreset; label: string; detail: string }> = [
  { value: 'off', label: 'Constant', detail: 'بدون Speed Ramp' },
  { value: 'montage', label: 'Montage', detail: 'Slow → Fast → Slow' },
  { value: 'hero', label: 'Hero', detail: 'Slow opening → Fast finish' },
  { value: 'bullet', label: 'Bullet', detail: 'Normal → Slow motion → Normal' },
  { value: 'flash', label: 'Flash', detail: 'Fast → Slow → Fast' },
]

function previewCss(settings: CreativeProjectSettings) {
  const strength = Math.max(0, Math.min(1, settings.lookStrength))
  const preset = CREATIVE_LOOKS.find((item) => item.id === settings.look) || CREATIVE_LOOKS[0]
  if (preset.id === 'none') return 'none'
  const brightness = 1 + preset.brightness * strength
  const contrast = 1 + (preset.contrast - 1) * strength
  const saturation = 1 + (preset.saturation - 1) * strength
  const warm = Math.max(0, preset.temperature) * strength
  const cool = Math.max(0, -preset.temperature) * strength
  const sepia = Math.min(.24, warm * .35)
  const hue = (warm - cool) * -9
  return `brightness(${brightness}) contrast(${contrast}) saturate(${saturation}) sepia(${sepia}) hue-rotate(${hue}deg)`
}

function setNativeInputValue(input: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
  descriptor?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function setSelectedClipSpeed(value: number) {
  const labels = Array.from(document.querySelectorAll<HTMLLabelElement>('.maghrabi-studio-pro main label'))
  const label = labels.find((item) => (item.textContent || '').trim().toUpperCase().startsWith('SPEED'))
  const input = label?.querySelector<HTMLInputElement>('input[type="number"]')
  if (!input) return false
  setNativeInputValue(input, String(value))
  input.focus({ preventScroll: true })
  return true
}

function applyPreview(settings: CreativeProjectSettings) {
  const value = previewCss(settings)
  document.querySelectorAll<HTMLVideoElement>('.maghrabi-studio-pro video:not([controls])').forEach((video) => {
    video.style.filter = value
    video.style.transition = 'filter 180ms ease'
  })
}

function createTitle(kind: CreativeTitle['kind'], index: number): CreativeTitle {
  return {
    id: `creative-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    text: kind === 'subtitle' ? 'اكتب الترجمة هنا' : 'عنوان جديد',
    startAt: 0,
    endAt: kind === 'subtitle' ? 3 : 4,
    size: kind === 'subtitle' ? 38 : 58,
    position: 'bottom',
    color: '#ffffff',
    boxOpacity: kind === 'subtitle' ? .48 : .36,
  }
}

export default function StudioCreativeSuite() {
  const initialProject = getActiveStudioProjectId()
  const [projectId, setProjectId] = useState<string | null>(initialProject)
  const projectRef = useRef<string | null>(initialProject)
  const [settings, setSettings] = useState<CreativeProjectSettings>(() => loadCreativeSettings(initialProject))
  const settingsRef = useRef(settings)
  const [open, setOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<CreativeTab>('looks')
  const [speedMessage, setSpeedMessage] = useState('')

  const update = (changes: Partial<CreativeProjectSettings>) => {
    setSettings((current) => ({ ...current, ...changes }))
  }

  const updateTitle = (id: string, changes: Partial<CreativeTitle>) => {
    setSettings((current) => ({
      ...current,
      titles: current.titles.map((item) => item.id === id ? { ...item, ...changes } : item),
    }))
  }

  useEffect(() => {
    settingsRef.current = settings
    saveCreativeSettings(projectRef.current, settings)
    applyPreview(settings)
  }, [settings])

  useEffect(() => {
    const reload = () => {
      const id = getActiveStudioProjectId()
      projectRef.current = id
      setProjectId(id)
      const next = loadCreativeSettings(id)
      settingsRef.current = next
      setSettings(next)
      window.setTimeout(() => applyPreview(next), 60)
    }
    const openSuite = (event: Event) => {
      const detail = (event as CustomEvent<{ tab?: CreativeTab }>).detail
      if (detail?.tab && tabs.some((item) => item.id === detail.tab)) setActiveTab(detail.tab)
      setOpen(true)
    }
    window.addEventListener('maghrabi-active-project-changed', reload)
    window.addEventListener('maghrabi-open-creative-suite', openSuite as EventListener)
    return () => {
      window.removeEventListener('maghrabi-active-project-changed', reload)
      window.removeEventListener('maghrabi-open-creative-suite', openSuite as EventListener)
    }
  }, [])

  useEffect(() => {
    const observer = new MutationObserver(() => applyPreview(settingsRef.current))
    const root = document.querySelector('.maghrabi-studio-pro')
    if (root) observer.observe(root, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const originalFetch = window.fetch
    const wrappedFetch: typeof window.fetch = async (input, init) => {
      try {
        const rawUrl = typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString()
        const url = new URL(rawUrl, window.location.href)
        const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
        if (url.pathname === '/api/video/v12/queue' && method === 'POST' && init?.body instanceof FormData) {
          const originalForm = init.body
          const rawManifest = originalForm.get('manifest')
          if (typeof rawManifest === 'string') {
            const parsed = JSON.parse(rawManifest) as VideoProjectManifestV12
            const enhanced = applyCreativeSettingsToManifest(parsed, settingsRef.current)
            const nextForm = new FormData()
            originalForm.forEach((value, key) => nextForm.append(key, value))
            nextForm.set('manifest', JSON.stringify(enhanced))
            return originalFetch(input, { ...init, body: nextForm })
          }
        }
      } catch (error) {
        console.warn('[MAGHRABI Creative Suite] Manifest enhancement skipped:', error)
      }
      return originalFetch(input, init)
    }
    window.fetch = wrappedFetch
    return () => {
      if (window.fetch === wrappedFetch) window.fetch = originalFetch
    }
  }, [])

  const addTitle = (kind: CreativeTitle['kind']) => {
    if (settings.titles.length >= 12) return
    update({ titles: [...settings.titles, createTitle(kind, settings.titles.length)] })
  }

  const quickSpeed = (value: number) => {
    const ok = setSelectedClipSpeed(value)
    setSpeedMessage(ok ? `تم ضبط المقطع المحدد على ${value}x` : 'حدد Clip فيديو من Timeline أولًا')
    window.setTimeout(() => setSpeedMessage(''), 2200)
  }

  return (
    <>
      <button
        type="button"
        className="maghrabi-creative-launcher"
        onClick={() => setOpen(true)}
        title="Creative Suite — Looks, Transitions, Titles, Speed, Audio"
      >
        <WandSparkles size={16} />
        <span>CREATIVE</span>
      </button>

      {open && (
        <div className="maghrabi-creative-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) setOpen(false) }}>
          <aside className="maghrabi-creative-suite" dir="ltr" aria-label="MAGHRABI Creative Suite">
            <header className="maghrabi-creative-head">
              <div>
                <div className="maghrabi-creative-kicker">MAGHRABI CREATIVE SUITE</div>
                <strong>Professional Editing Controls</strong>
                <small>{projectId ? 'محفوظة تلقائيًا لهذا المشروع' : 'إعدادات عامة مؤقتة'}</small>
              </div>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close"><X size={18} /></button>
            </header>

            <nav className="maghrabi-creative-tabs">
              {tabs.map(({ id, label, icon: Icon }) => (
                <button key={id} type="button" className={activeTab === id ? 'is-active' : ''} onClick={() => setActiveTab(id)}>
                  <Icon size={14} /><span>{label}</span>
                </button>
              ))}
            </nav>

            <div className="maghrabi-creative-body">
              {activeTab === 'looks' && (
                <section>
                  <div className="maghrabi-creative-section-head">
                    <div><strong>Professional Looks</strong><small>تظهر معاينة تقريبية فورًا، وFFmpeg يطبق النتيجة النهائية.</small></div>
                    <span>{Math.round(settings.lookStrength * 100)}%</span>
                  </div>
                  <input className="maghrabi-creative-range" type="range" min="0" max="1" step=".05" value={settings.lookStrength} onChange={(event) => update({ lookStrength: Number(event.target.value) })} />
                  <div className="maghrabi-look-grid">
                    {CREATIVE_LOOKS.map((look) => (
                      <button key={look.id} type="button" className={`maghrabi-look-card${settings.look === look.id ? ' is-selected' : ''}`} onClick={() => update({ look: look.id })}>
                        <span className="maghrabi-look-swatches">{look.swatches.map((color) => <i key={color} style={{ background: color }} />)}</span>
                        <strong>{look.name}</strong><small>{look.description}</small>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {activeTab === 'transitions' && (
                <section>
                  <div className="maghrabi-creative-section-head">
                    <div><strong>Transitions</strong><small>FFmpeg XFade + Audio Crossfade بين مقاطع V1.</small></div>
                    <span>{settings.transitionDuration.toFixed(2)}s</span>
                  </div>
                  <input className="maghrabi-creative-range" type="range" min=".1" max="1.5" step=".05" value={settings.transitionDuration} onChange={(event) => update({ transitionDuration: Number(event.target.value) })} />
                  <div className="maghrabi-transition-grid">
                    {CREATIVE_TRANSITIONS.map((item) => (
                      <button key={item.value} type="button" className={`maghrabi-transition-card${settings.transition === item.value ? ' is-selected' : ''}`} onClick={() => update({ transition: item.value })}>
                        <span className={`maghrabi-transition-demo transition-${item.value}`}><i /><b /></span>
                        <strong>{item.name}</strong><small>{item.family}</small>
                      </button>
                    ))}
                  </div>
                  <p className="maghrabi-creative-note">الفاصل المحدد يطبّق على الوصلات المتتابعة في V1 أثناء التصدير النهائي.</p>
                </section>
              )}

              {activeTab === 'titles' && (
                <section>
                  <div className="maghrabi-creative-section-head">
                    <div><strong>Titles & Captions</strong><small>عناوين وترجمة مؤقتة بزمن بداية ونهاية.</small></div>
                    <span>{settings.titles.length}/12</span>
                  </div>
                  <div className="maghrabi-title-actions">
                    <button type="button" onClick={() => addTitle('title')}><Plus size={14} /> ADD TITLE</button>
                    <button type="button" onClick={() => addTitle('subtitle')}><Plus size={14} /> ADD SUBTITLE</button>
                  </div>
                  <div className="maghrabi-title-list">
                    {settings.titles.map((title, index) => (
                      <article key={title.id} className="maghrabi-title-card">
                        <div className="maghrabi-title-card-head"><span>{title.kind === 'subtitle' ? 'SUBTITLE' : 'TITLE'} {index + 1}</span><button type="button" onClick={() => update({ titles: settings.titles.filter((item) => item.id !== title.id) })}><Trash2 size={14} /></button></div>
                        <textarea value={title.text} onChange={(event) => updateTitle(title.id, { text: event.target.value })} rows={2} />
                        <div className="maghrabi-title-fields">
                          <label>START<input type="number" min="0" step=".1" value={title.startAt} onChange={(event) => updateTitle(title.id, { startAt: Math.max(0, Number(event.target.value) || 0) })} /></label>
                          <label>END<input type="number" min=".1" step=".1" value={title.endAt} onChange={(event) => updateTitle(title.id, { endAt: Math.max(title.startAt + .1, Number(event.target.value) || title.startAt + .1) })} /></label>
                          <label>SIZE<input type="number" min="18" max="120" value={title.size} onChange={(event) => updateTitle(title.id, { size: Math.max(18, Math.min(120, Number(event.target.value) || 38)) })} /></label>
                          <label>POSITION<select value={title.position} onChange={(event) => updateTitle(title.id, { position: event.target.value as CreativeTitle['position'] })}><option value="top">Top</option><option value="center">Center</option><option value="bottom">Bottom</option></select></label>
                        </div>
                        {title.kind === 'subtitle' && <div className="maghrabi-title-fields two"><label>COLOR<input type="color" value={title.color} onChange={(event) => updateTitle(title.id, { color: event.target.value })} /></label><label>BOX {Math.round(title.boxOpacity * 100)}%<input type="range" min="0" max="1" step=".05" value={title.boxOpacity} onChange={(event) => updateTitle(title.id, { boxOpacity: Number(event.target.value) })} /></label></div>}
                      </article>
                    ))}
                    {!settings.titles.length && <div className="maghrabi-creative-empty"><Captions size={24} /><span>أضف عنوانًا أو ترجمة ليتم تضمينها في التصدير.</span></div>}
                  </div>
                  <p className="maghrabi-creative-note">العنوان النهائي يُرسم بواسطة FFmpeg أثناء Render؛ معاينة النص المتقدمة ستكون في المرحلة التالية.</p>
                </section>
              )}

              {activeTab === 'speed' && (
                <section>
                  <div className="maghrabi-creative-section-head"><div><strong>Speed & Time</strong><small>Quick Speed للمقطع المحدد + Speed Ramp للمشروع.</small></div><Gauge size={18} /></div>
                  <div className="maghrabi-speed-buttons">{[.5, 1, 1.5, 2, 4].map((value) => <button type="button" key={value} onClick={() => quickSpeed(value)}>{value}x</button>)}</div>
                  {speedMessage && <div className="maghrabi-speed-message">{speedMessage}</div>}
                  <div className="maghrabi-ramp-list">
                    {speedRamps.map((item) => <button type="button" key={item.value} className={settings.speedRamp === item.value ? 'is-selected' : ''} onClick={() => update({ speedRamp: item.value })}><SlidersHorizontal size={15} /><span><strong>{item.label}</strong><small>{item.detail}</small></span></button>)}
                  </div>
                  <p className="maghrabi-creative-note">Quick Speed يغيّر المقطع المحدد فعليًا في V12. Speed Ramp يطبّق على مقاطع V1 أثناء التصدير.</p>
                </section>
              )}

              {activeTab === 'audio' && (
                <section>
                  <div className="maghrabi-creative-section-head"><div><strong>Audio Finishing</strong><small>Ducking + Fades تُنفذ في V9 Audio Engine.</small></div><Volume2 size={18} /></div>
                  <label className="maghrabi-toggle-row"><span><strong>Dialogue Ducking</strong><small>اخفض الموسيقى تلقائيًا عندما يكون صوت الفيديو موجودًا.</small></span><input type="checkbox" checked={settings.audioDuckingEnabled} onChange={(event) => update({ audioDuckingEnabled: event.target.checked })} /></label>
                  <label className="maghrabi-control-row"><span>DUCKING STRENGTH <b>{Math.round(settings.duckingStrength * 100)}%</b></span><input type="range" min="0" max="1" step=".05" value={settings.duckingStrength} onChange={(event) => update({ duckingStrength: Number(event.target.value) })} /></label>
                  <div className="maghrabi-audio-grid">
                    <label>DEFAULT FADE IN<input type="number" min="0" max="10" step=".1" value={settings.audioFadeIn} onChange={(event) => update({ audioFadeIn: Math.max(0, Math.min(10, Number(event.target.value) || 0)) })} /><span>seconds</span></label>
                    <label>DEFAULT FADE OUT<input type="number" min="0" max="10" step=".1" value={settings.audioFadeOut} onChange={(event) => update({ audioFadeOut: Math.max(0, Math.min(10, Number(event.target.value) || 0)) })} /><span>seconds</span></label>
                  </div>
                  <p className="maghrabi-creative-note">يمكنك رفع WAV/MP3 من Media أو فتح Audio Studio للمعالجة المتقدمة وفصل الأصوات.</p>
                </section>
              )}
            </div>
          </aside>
        </div>
      )}
    </>
  )
}
