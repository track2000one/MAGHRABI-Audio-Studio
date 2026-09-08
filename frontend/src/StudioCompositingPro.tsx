import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown, ArrowUp, Eye, EyeOff, Layers3, Plus, Save, Sparkles, Trash2, X } from 'lucide-react'
import { getActiveStudioProjectId } from './lib/projectHubStore'
import {
  activeCompositingSettings,
  createCompositingLayer,
  injectActiveCompositingSettings,
  loadCompositingSettings,
  saveCompositingSettings,
  type CompositingBlendMode,
  type CompositingLayer,
  type CompositingProjectSettings,
} from './lib/compositingProjectSettings'
import './studioCompositingPro.css'

const ROOT = '.maghrabi-studio-pro main'
const BLENDS: Array<{ value: CompositingBlendMode; label: string }> = [
  { value: 'normal', label: 'Normal' },
  { value: 'screen', label: 'Screen' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'add', label: 'Add' },
  { value: 'difference', label: 'Difference' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'darken', label: 'Darken' },
]

const PRESETS: Array<{ name: string; patch: Partial<CompositingLayer> }> = [
  { name: 'CINEMA GLOW', patch: { blendMode: 'screen', opacity: .42, brightness: .03, contrast: 1.06, saturation: .96, glow: .48, vignette: .18 } },
  { name: 'FILM GRAIN', patch: { blendMode: 'overlay', opacity: .36, contrast: 1.03, grain: .42, saturation: .94, vignette: .12 } },
  { name: 'LIGHT LEAK', patch: { blendMode: 'screen', opacity: .34, lightLeak: .65, brightness: .05, saturation: 1.12 } },
  { name: 'DREAM SOFT', patch: { blendMode: 'screen', opacity: .28, blur: .18, glow: .62, saturation: .9 } },
  { name: 'PUNCH', patch: { blendMode: 'overlay', opacity: .48, contrast: 1.22, saturation: 1.16, sharpen: .34 } },
  { name: 'NIGHT LIFT', patch: { blendMode: 'screen', opacity: .32, brightness: .09, contrast: .92, saturation: .82, hue: -8 } },
]

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function playheadTime() {
  const raw = Number(document.documentElement.dataset.maghrabiFrameClockTime)
  return Number.isFinite(raw) ? Math.max(0, raw) : 0
}

function queueUrl(input: RequestInfo | URL) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url
  return String(input)
}

function installQueueManifestBridge() {
  const previous = window.fetch
  const wrapped: typeof window.fetch = async (input, init) => {
    try {
      const url = queueUrl(input)
      if (url.includes('/api/video/v12/queue') && init?.body instanceof FormData) {
        const manifest = init.body.get('manifest')
        if (typeof manifest === 'string' && manifest.trim()) {
          const parsed = JSON.parse(manifest) as Record<string, unknown>
          init.body.set('manifest', JSON.stringify(injectActiveCompositingSettings(parsed)))
        }
      }
    } catch (error) {
      console.warn('[Compositing Pro] manifest injection skipped', error)
    }
    return previous(input, init)
  }
  window.fetch = wrapped
  return () => {
    if (window.fetch === wrapped) window.fetch = previous
  }
}

function programSurface() {
  const labels = Array.from(document.querySelectorAll<HTMLElement>(`${ROOT} p`))
  const label = labels.find((node) => (node.textContent || '').trim().toUpperCase() === 'PROGRAM MONITOR')
  return label?.closest<HTMLElement>('div[class*="rounded-3xl"]')?.querySelector<HTMLElement>('.aspect-video') || null
}

function currentPreviewFilter(settings: CompositingProjectSettings, time: number) {
  const active = settings.layers.filter((layer) => layer.enabled && time >= layer.startAt && time <= layer.endAt)
  if (!active.length) return ''
  let brightness = 1
  let contrast = 1
  let saturation = 1
  let hue = 0
  let blur = 0
  active.forEach((layer) => {
    brightness *= 1 + layer.brightness
    contrast *= layer.contrast
    saturation *= layer.saturation
    hue += layer.hue
    blur = Math.max(blur, layer.blur * 5)
  })
  return `brightness(${clamp(brightness, .45, 1.65)}) contrast(${clamp(contrast, .45, 2.2)}) saturate(${clamp(saturation, 0, 2.6)}) hue-rotate(${clamp(hue, -180, 180)}deg) blur(${clamp(blur, 0, 5)}px)`
}

export default function StudioCompositingPro() {
  const [open, setOpen] = useState(false)
  const [projectId, setProjectId] = useState<string | null>(() => getActiveStudioProjectId())
  const [settings, setSettings] = useState<CompositingProjectSettings>(() => loadCompositingSettings(getActiveStudioProjectId()))
  const [selectedId, setSelectedId] = useState<string | null>(() => activeCompositingSettings().layers[0]?.id || null)
  const [previewEnabled, setPreviewEnabled] = useState(true)
  const previewTimer = useRef<number | null>(null)

  const selected = useMemo(() => settings.layers.find((layer) => layer.id === selectedId) || settings.layers[0] || null, [settings.layers, selectedId])

  useEffect(() => installQueueManifestBridge(), [])

  useEffect(() => {
    const onProject = () => {
      const nextId = getActiveStudioProjectId()
      const next = loadCompositingSettings(nextId)
      setProjectId(nextId)
      setSettings(next)
      setSelectedId(next.layers[0]?.id || null)
    }
    window.addEventListener('maghrabi-active-project-changed', onProject)
    return () => window.removeEventListener('maghrabi-active-project-changed', onProject)
  }, [])

  useEffect(() => {
    if (!previewEnabled) {
      const surface = programSurface()
      if (surface) surface.style.filter = ''
      return
    }
    const refresh = () => {
      const surface = programSurface()
      if (surface) surface.style.filter = currentPreviewFilter(settings, playheadTime())
    }
    refresh()
    previewTimer.current = window.setInterval(refresh, 160)
    return () => {
      if (previewTimer.current) window.clearInterval(previewTimer.current)
      const surface = programSurface()
      if (surface) surface.style.filter = ''
    }
  }, [settings, previewEnabled])

  const commit = (next: CompositingProjectSettings) => {
    setSettings(next)
    saveCompositingSettings(projectId, next)
  }

  const patchLayer = (id: string, patch: Partial<CompositingLayer>) => {
    commit({ ...settings, layers: settings.layers.map((layer) => layer.id === id ? { ...layer, ...patch } : layer) })
  }

  const addLayer = () => {
    const startAt = playheadTime()
    const next = createCompositingLayer(settings.layers.length, startAt, startAt + 6)
    commit({ ...settings, layers: [...settings.layers, next].slice(0, 12) })
    setSelectedId(next.id)
    setOpen(true)
  }

  const removeLayer = (id: string) => {
    const layers = settings.layers.filter((layer) => layer.id !== id)
    commit({ ...settings, layers })
    setSelectedId(layers[0]?.id || null)
  }

  const moveLayer = (id: string, delta: number) => {
    const index = settings.layers.findIndex((layer) => layer.id === id)
    const target = index + delta
    if (index < 0 || target < 0 || target >= settings.layers.length) return
    const layers = [...settings.layers]
    const [layer] = layers.splice(index, 1)
    layers.splice(target, 0, layer)
    commit({ ...settings, layers })
  }

  const addOpacityKeyframe = () => {
    if (!selected) return
    const relative = clamp((playheadTime() - selected.startAt) / Math.max(.1, selected.endAt - selected.startAt), 0, 1)
    const point = { time: relative, opacity: selected.opacity, easing: 'ease-in-out' as const }
    const points = [...selected.opacityKeyframes.filter((item) => Math.abs(item.time - relative) > .005), point]
      .sort((a, b) => a.time - b.time)
      .slice(0, 16)
    patchLayer(selected.id, { opacityKeyframes: points })
  }

  const addCompound = () => {
    const startAt = selected?.startAt ?? playheadTime()
    const endAt = selected?.endAt ?? startAt + 5
    const group = {
      id: `compound-${Date.now().toString(36)}`,
      name: `Compound ${settings.compoundGroups.length + 1}`,
      startAt,
      endAt,
      collapsed: true,
    }
    commit({ ...settings, compoundGroups: [...settings.compoundGroups, group].slice(0, 12) })
  }

  const body = (
    <>
      <button onClick={() => setOpen(true)} className="maghrabi-compositing-launcher" title="Advanced Compositing Pro">
        <Layers3 className="h-4 w-4" />
        <span>COMPOSITE</span>
        {!!settings.layers.length && <b>{settings.layers.length}</b>}
      </button>

      {open && <div className="maghrabi-compositing-backdrop" dir="ltr">
        <section className="maghrabi-compositing-panel">
          <header className="maghrabi-compositing-header">
            <div>
              <p>ADVANCED COMPOSITING PRO</p>
              <h2>Adjustment Layers · Blend Modes · Effects Stack</h2>
              <span>Final render: FFmpeg compositing before LUT / grading / text.</span>
            </div>
            <div className="maghrabi-compositing-header-actions">
              <button onClick={() => setPreviewEnabled((value) => !value)}>{previewEnabled ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}{previewEnabled ? 'LIVE PREVIEW' : 'PREVIEW OFF'}</button>
              <button onClick={() => saveCompositingSettings(projectId, settings)}><Save className="h-4 w-4" />SAVE</button>
              <button onClick={() => setOpen(false)} aria-label="Close"><X className="h-5 w-5" /></button>
            </div>
          </header>

          <div className="maghrabi-compositing-grid">
            <aside className="maghrabi-compositing-layers">
              <div className="maghrabi-compositing-section-title"><span>LAYERS</span><button onClick={addLayer}><Plus className="h-3.5 w-3.5" />ADD</button></div>
              <div className="maghrabi-compositing-layer-list">
                {settings.layers.map((layer, index) => <button key={layer.id} onClick={() => setSelectedId(layer.id)} className={selected?.id === layer.id ? 'active' : ''}>
                  <span className="maghrabi-compositing-layer-index">{String(index + 1).padStart(2, '0')}</span>
                  <span className="maghrabi-compositing-layer-copy"><strong>{layer.name}</strong><small>{layer.blendMode.toUpperCase()} · {layer.startAt.toFixed(1)}–{layer.endAt.toFixed(1)}s</small></span>
                  <span className={layer.enabled ? 'on' : 'off'}>{layer.enabled ? 'ON' : 'OFF'}</span>
                </button>)}
                {!settings.layers.length && <div className="maghrabi-compositing-empty">أضف Adjustment Pro Layer لبدء الـCompositing.</div>}
              </div>
              <button onClick={addCompound} className="maghrabi-compound-button"><Layers3 className="h-3.5 w-3.5" />CREATE COMPOUND RANGE</button>
              {!!settings.compoundGroups.length && <div className="maghrabi-compound-list">{settings.compoundGroups.map((group) => <div key={group.id}><span>{group.name}</span><small>{group.startAt.toFixed(1)}–{group.endAt.toFixed(1)}s</small></div>)}</div>}
            </aside>

            <main className="maghrabi-compositing-controls">
              {selected ? <>
                <div className="maghrabi-compositing-toolbar">
                  <input value={selected.name} onChange={(event) => patchLayer(selected.id, { name: event.target.value })} />
                  <button onClick={() => patchLayer(selected.id, { enabled: !selected.enabled })}>{selected.enabled ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}</button>
                  <button onClick={() => moveLayer(selected.id, -1)}><ArrowUp className="h-4 w-4" /></button>
                  <button onClick={() => moveLayer(selected.id, 1)}><ArrowDown className="h-4 w-4" /></button>
                  <button className="danger" onClick={() => removeLayer(selected.id)}><Trash2 className="h-4 w-4" /></button>
                </div>

                <div className="maghrabi-compositing-presets">
                  {PRESETS.map((preset) => <button key={preset.name} onClick={() => patchLayer(selected.id, preset.patch)}><Sparkles className="h-3 w-3" />{preset.name}</button>)}
                </div>

                <div className="maghrabi-compositing-card-grid">
                  <div className="maghrabi-compositing-card">
                    <h3>COMPOSITE</h3>
                    <label>BLEND MODE<select value={selected.blendMode} onChange={(event) => patchLayer(selected.id, { blendMode: event.target.value as CompositingBlendMode })}>{BLENDS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
                    <Range label="OPACITY" value={selected.opacity} min={0} max={1} step={.01} onChange={(value) => patchLayer(selected.id, { opacity: value })} suffix={`${Math.round(selected.opacity * 100)}%`} />
                    <div className="maghrabi-compositing-two"><NumberBox label="START" value={selected.startAt} onChange={(value) => patchLayer(selected.id, { startAt: Math.max(0, Math.min(value, selected.endAt - .1)) })} /><NumberBox label="END" value={selected.endAt} onChange={(value) => patchLayer(selected.id, { endAt: Math.max(selected.startAt + .1, value) })} /></div>
                    <button onClick={addOpacityKeyframe} className="maghrabi-keyframe-button">+ OPACITY KEYFRAME @ PLAYHEAD</button>
                    <div className="maghrabi-keyframe-dots">{selected.opacityKeyframes.map((point, index) => <button key={`${point.time}-${index}`} title={`${Math.round(point.time * 100)}% · ${Math.round(point.opacity * 100)}%`} onClick={() => patchLayer(selected.id, { opacityKeyframes: selected.opacityKeyframes.filter((_, itemIndex) => itemIndex !== index) })} style={{ left: `${point.time * 100}%` }} />)}</div>
                  </div>

                  <div className="maghrabi-compositing-card">
                    <h3>PRIMARY</h3>
                    <Range label="BRIGHTNESS" value={selected.brightness} min={-.5} max={.5} step={.01} onChange={(value) => patchLayer(selected.id, { brightness: value })} />
                    <Range label="CONTRAST" value={selected.contrast} min={.5} max={2} step={.01} onChange={(value) => patchLayer(selected.id, { contrast: value })} />
                    <Range label="SATURATION" value={selected.saturation} min={0} max={2.5} step={.01} onChange={(value) => patchLayer(selected.id, { saturation: value })} />
                    <Range label="HUE" value={selected.hue} min={-180} max={180} step={1} onChange={(value) => patchLayer(selected.id, { hue: value })} suffix={`${Math.round(selected.hue)}°`} />
                  </div>

                  <div className="maghrabi-compositing-card">
                    <h3>EFFECTS STACK</h3>
                    <Range label="BLUR" value={selected.blur} min={0} max={1} step={.01} onChange={(value) => patchLayer(selected.id, { blur: value })} />
                    <Range label="SHARPEN" value={selected.sharpen} min={0} max={1} step={.01} onChange={(value) => patchLayer(selected.id, { sharpen: value })} />
                    <Range label="VIGNETTE" value={selected.vignette} min={0} max={1} step={.01} onChange={(value) => patchLayer(selected.id, { vignette: value })} />
                    <Range label="FILM GRAIN" value={selected.grain} min={0} max={1} step={.01} onChange={(value) => patchLayer(selected.id, { grain: value })} />
                    <Range label="GLOW" value={selected.glow} min={0} max={1} step={.01} onChange={(value) => patchLayer(selected.id, { glow: value })} />
                    <Range label="LIGHT LEAK" value={selected.lightLeak} min={0} max={1} step={.01} onChange={(value) => patchLayer(selected.id, { lightLeak: value })} />
                  </div>

                  <div className="maghrabi-compositing-card">
                    <h3>LAYER TRANSFORM</h3>
                    <Range label="ZOOM" value={selected.zoom} min={1} max={2.5} step={.01} onChange={(value) => patchLayer(selected.id, { zoom: value })} suffix={`${selected.zoom.toFixed(2)}×`} />
                    <Range label="PAN X" value={selected.panX} min={-1} max={1} step={.01} onChange={(value) => patchLayer(selected.id, { panX: value })} />
                    <Range label="PAN Y" value={selected.panY} min={-1} max={1} step={.01} onChange={(value) => patchLayer(selected.id, { panY: value })} />
                    <p className="maghrabi-compositing-note">Layer order is top-to-bottom in the list. Final FFmpeg evaluates opacity keyframes and Blend Mode on the fully composed Program image.</p>
                  </div>
                </div>
              </> : <div className="maghrabi-compositing-empty large"><Layers3 className="h-8 w-8" />No Compositing Layer selected.</div>}
            </main>
          </div>
        </section>
      </div>}
    </>
  )

  return createPortal(body, document.body)
}

function Range({ label, value, min, max, step, suffix, onChange }: { label: string; value: number; min: number; max: number; step: number; suffix?: string; onChange: (value: number) => void }) {
  return <label className="maghrabi-compositing-range"><span>{label}<b>{suffix || value.toFixed(step < .1 ? 2 : 0)}</b></span><input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>
}

function NumberBox({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <label>{label}<input type="number" min="0" step=".1" value={Number(value.toFixed(2))} onChange={(event) => onChange(Number(event.target.value) || 0)} /></label>
}
