import { getActiveStudioProjectId } from './projectHubStore'

export type CompositingBlendMode = 'normal' | 'screen' | 'multiply' | 'overlay' | 'add' | 'difference' | 'lighten' | 'darken'
export type CompositingEasing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'hold'

export type CompositingOpacityKeyframe = {
  time: number
  opacity: number
  easing: CompositingEasing
}

export type CompositingLayer = {
  id: string
  name: string
  enabled: boolean
  startAt: number
  endAt: number
  blendMode: CompositingBlendMode
  opacity: number
  opacityKeyframes: CompositingOpacityKeyframe[]
  brightness: number
  contrast: number
  saturation: number
  hue: number
  blur: number
  sharpen: number
  vignette: number
  grain: number
  glow: number
  lightLeak: number
  zoom: number
  panX: number
  panY: number
}

export type CompoundGroup = {
  id: string
  name: string
  startAt: number
  endAt: number
  collapsed: boolean
}

export type CompositingProjectSettings = {
  layers: CompositingLayer[]
  compoundGroups: CompoundGroup[]
}

const STORAGE_PREFIX = 'maghrabi-compositing-pro-v1:'
const MAX_LAYERS = 12
const MAX_KEYFRAMES = 16
const MAX_GROUPS = 12

const DEFAULT_SETTINGS: CompositingProjectSettings = { layers: [], compoundGroups: [] }

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function key(projectId?: string | null) {
  return `${STORAGE_PREFIX}${projectId || 'global'}`
}

function validBlend(value: unknown): CompositingBlendMode {
  const text = String(value || 'normal')
  return ['normal', 'screen', 'multiply', 'overlay', 'add', 'difference', 'lighten', 'darken'].includes(text)
    ? text as CompositingBlendMode
    : 'normal'
}

function validEasing(value: unknown): CompositingEasing {
  const text = String(value || 'ease-in-out')
  return ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold'].includes(text)
    ? text as CompositingEasing
    : 'ease-in-out'
}

export function createCompositingLayer(index = 0, startAt = 0, endAt = 6): CompositingLayer {
  const safeStart = Math.max(0, startAt)
  return {
    id: `comp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: `Adjustment Pro ${index + 1}`,
    enabled: true,
    startAt: safeStart,
    endAt: Math.max(safeStart + .1, endAt),
    blendMode: 'normal',
    opacity: 1,
    opacityKeyframes: [],
    brightness: 0,
    contrast: 1,
    saturation: 1,
    hue: 0,
    blur: 0,
    sharpen: 0,
    vignette: 0,
    grain: 0,
    glow: 0,
    lightLeak: 0,
    zoom: 1,
    panX: 0,
    panY: 0,
  }
}

export function sanitizeCompositingLayer(raw: Partial<CompositingLayer>, index = 0): CompositingLayer {
  const startAt = clamp(Number(raw.startAt ?? 0), 0, 86400)
  const endAt = Math.max(startAt + .1, clamp(Number(raw.endAt ?? startAt + 6), 0, 86400))
  const opacityKeyframes = Array.isArray(raw.opacityKeyframes)
    ? raw.opacityKeyframes.slice(0, MAX_KEYFRAMES).map((point) => ({
      time: clamp(Number(point?.time ?? 0), 0, 1),
      opacity: clamp(Number(point?.opacity ?? 1), 0, 1),
      easing: validEasing(point?.easing),
    })).sort((a, b) => a.time - b.time)
    : []
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `comp-${Date.now().toString(36)}-${index}`,
    name: String(raw.name || `Adjustment Pro ${index + 1}`).slice(0, 80),
    enabled: raw.enabled !== false,
    startAt,
    endAt,
    blendMode: validBlend(raw.blendMode),
    opacity: clamp(Number(raw.opacity ?? 1), 0, 1),
    opacityKeyframes,
    brightness: clamp(Number(raw.brightness ?? 0), -.5, .5),
    contrast: clamp(Number(raw.contrast ?? 1), .5, 2),
    saturation: clamp(Number(raw.saturation ?? 1), 0, 2.5),
    hue: clamp(Number(raw.hue ?? 0), -180, 180),
    blur: clamp(Number(raw.blur ?? 0), 0, 1),
    sharpen: clamp(Number(raw.sharpen ?? 0), 0, 1),
    vignette: clamp(Number(raw.vignette ?? 0), 0, 1),
    grain: clamp(Number(raw.grain ?? 0), 0, 1),
    glow: clamp(Number(raw.glow ?? 0), 0, 1),
    lightLeak: clamp(Number(raw.lightLeak ?? 0), 0, 1),
    zoom: clamp(Number(raw.zoom ?? 1), 1, 2.5),
    panX: clamp(Number(raw.panX ?? 0), -1, 1),
    panY: clamp(Number(raw.panY ?? 0), -1, 1),
  }
}

function sanitizeGroup(raw: Partial<CompoundGroup>, index = 0): CompoundGroup {
  const startAt = clamp(Number(raw.startAt ?? 0), 0, 86400)
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `compound-${Date.now().toString(36)}-${index}`,
    name: String(raw.name || `Compound ${index + 1}`).slice(0, 80),
    startAt,
    endAt: Math.max(startAt + .1, clamp(Number(raw.endAt ?? startAt + 5), 0, 86400)),
    collapsed: Boolean(raw.collapsed),
  }
}

export function loadCompositingSettings(projectId?: string | null): CompositingProjectSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key(projectId)) || '{}') as Partial<CompositingProjectSettings>
    return {
      layers: Array.isArray(parsed.layers) ? parsed.layers.slice(0, MAX_LAYERS).map(sanitizeCompositingLayer) : [],
      compoundGroups: Array.isArray(parsed.compoundGroups) ? parsed.compoundGroups.slice(0, MAX_GROUPS).map(sanitizeGroup) : [],
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveCompositingSettings(projectId: string | null | undefined, settings: CompositingProjectSettings) {
  if (typeof window === 'undefined') return
  const normalized: CompositingProjectSettings = {
    layers: settings.layers.slice(0, MAX_LAYERS).map(sanitizeCompositingLayer),
    compoundGroups: settings.compoundGroups.slice(0, MAX_GROUPS).map(sanitizeGroup),
  }
  window.localStorage.setItem(key(projectId), JSON.stringify(normalized))
  window.dispatchEvent(new CustomEvent('maghrabi-compositing-settings-changed', { detail: { projectId, settings: normalized } }))
}

export function activeCompositingSettings() {
  return loadCompositingSettings(getActiveStudioProjectId())
}

export function injectActiveCompositingSettings(manifest: Record<string, unknown>) {
  const settings = activeCompositingSettings()
  return {
    ...manifest,
    adjustmentLayers: settings.layers,
    compoundGroups: settings.compoundGroups,
  }
}
