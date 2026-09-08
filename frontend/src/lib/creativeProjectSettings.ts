import type {
  SpeedRampPreset,
  TextTrackManifest,
  SubtitleTrackManifest,
  VideoFilter,
  VideoProjectManifestV12,
  VideoTransition,
} from './videoApi'

export type CreativeTab = 'looks' | 'transitions' | 'titles' | 'speed' | 'audio'
export type CreativeLookId =
  | 'none'
  | 'clean-studio'
  | 'cinema-teal'
  | 'golden-hour'
  | 'travel-pop'
  | 'soft-portrait'
  | 'night-neon'
  | 'vintage-film'
  | 'steel-blue'
  | 'noir'
  | 'documentary'
  | 'commercial-crisp'
  | 'desert-luxe'
  | 'emerald-film'
  | 'rose-cinema'
  | 'moody-drama'
  | 'sports-punch'

export type CreativeFontPreset = 'sans' | 'sans-bold' | 'serif' | 'serif-bold' | 'mono' | 'mono-bold'
export type CreativeTextAnimation = 'none' | 'fade' | 'slide-up' | 'slide-left' | 'slide-right' | 'pop'
export type CreativeTextAlign = 'left' | 'center' | 'right'

export type CreativeTitle = {
  id: string
  kind: 'title' | 'subtitle'
  text: string
  startAt: number
  endAt: number
  size: number
  position: 'top' | 'center' | 'bottom'
  color: string
  boxOpacity: number
  fontPreset?: CreativeFontPreset
  align?: CreativeTextAlign
  x?: number
  y?: number
  boxColor?: string
  boxPadding?: number
  borderColor?: string
  borderWidth?: number
  shadowColor?: string
  shadowDistance?: number
  lineSpacing?: number
  animation?: CreativeTextAnimation
}

export type CreativeColorGrade = {
  enabled: boolean
  exposure: number
  contrast: number
  highlights: number
  shadows: number
  whites: number
  blacks: number
  temperature: number
  tint: number
  saturation: number
  vibrance: number
  hue: number
  gamma: number
  curveShadows: number
  curveMidtones: number
  curveHighlights: number
  vignette: number
  sharpen: number
}

export type CreativeProjectSettings = {
  look: CreativeLookId
  lookStrength: number
  transition: VideoTransition
  transitionDuration: number
  speedRamp: SpeedRampPreset
  audioDuckingEnabled: boolean
  duckingStrength: number
  audioFadeIn: number
  audioFadeOut: number
  titles: CreativeTitle[]
  colorGrade: CreativeColorGrade
}

export type CreativeLookPreset = {
  id: CreativeLookId
  name: string
  description: string
  filter: VideoFilter
  brightness: number
  contrast: number
  saturation: number
  temperature: number
  vignette: number
  swatches: [string, string, string]
}

const STORAGE_PREFIX = 'maghrabi-creative-settings-v1:'
const GLOBAL_KEY = 'global'

export const DEFAULT_COLOR_GRADE: CreativeColorGrade = {
  enabled: false,
  exposure: 0,
  contrast: 1,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  temperature: 0,
  tint: 0,
  saturation: 1,
  vibrance: 0,
  hue: 0,
  gamma: 1,
  curveShadows: 0,
  curveMidtones: 0,
  curveHighlights: 0,
  vignette: 0,
  sharpen: 0,
}

export const CREATIVE_LOOKS: CreativeLookPreset[] = [
  { id: 'none', name: 'Original', description: 'بدون معالجة لونية إضافية', filter: 'none', brightness: 0, contrast: 1, saturation: 1, temperature: 0, vignette: 0, swatches: ['#1f2937', '#64748b', '#cbd5e1'] },
  { id: 'clean-studio', name: 'Clean Studio', description: 'صورة نظيفة ومتوازنة للمحتوى العام', filter: 'none', brightness: .02, contrast: 1.06, saturation: 1.03, temperature: 0, vignette: .05, swatches: ['#172033', '#b6d8ef', '#eef8ff'] },
  { id: 'cinema-teal', name: 'Cinema Teal', description: 'تباين سينمائي بارد وعمق أقوى', filter: 'cinematic', brightness: -.02, contrast: 1.18, saturation: .92, temperature: -.12, vignette: .30, swatches: ['#0b252d', '#1f6f78', '#d59b67'] },
  { id: 'golden-hour', name: 'Golden Hour', description: 'دفء ذهبي للبشرة والمناظر', filter: 'warm', brightness: .04, contrast: 1.08, saturation: 1.12, temperature: .32, vignette: .12, swatches: ['#5d2e19', '#e79b48', '#ffe0a0'] },
  { id: 'travel-pop', name: 'Travel Pop', description: 'ألوان نابضة للسفر والرياضة', filter: 'vivid', brightness: .03, contrast: 1.12, saturation: 1.22, temperature: .06, vignette: .08, swatches: ['#07455e', '#12b3c7', '#f3c84b'] },
  { id: 'soft-portrait', name: 'Soft Portrait', description: 'بشرة هادئة وتباين ناعم', filter: 'warm', brightness: .05, contrast: .96, saturation: .94, temperature: .12, vignette: .06, swatches: ['#5e4043', '#d5a19d', '#f5ded5'] },
  { id: 'night-neon', name: 'Night Neon', description: 'تباين قوي للمشاهد الليلية', filter: 'cool', brightness: -.04, contrast: 1.28, saturation: 1.25, temperature: -.18, vignette: .35, swatches: ['#090d28', '#683ce8', '#18d7e4'] },
  { id: 'vintage-film', name: 'Vintage Film', description: 'ألوان فيلم قديم ناعمة', filter: 'warm', brightness: -.02, contrast: .92, saturation: .82, temperature: .18, vignette: .32, swatches: ['#51412d', '#a7895e', '#d8c89f'] },
  { id: 'steel-blue', name: 'Steel Blue', description: 'طابع بارد راقٍ للمقابلات والتقنية', filter: 'cool', brightness: -.03, contrast: 1.20, saturation: .88, temperature: -.28, vignette: .22, swatches: ['#12202e', '#47708d', '#b3c7d2'] },
  { id: 'noir', name: 'Noir', description: 'أبيض وأسود بتباين سينمائي', filter: 'mono', brightness: -.04, contrast: 1.35, saturation: 0, temperature: 0, vignette: .40, swatches: ['#050505', '#666666', '#e4e4e4'] },
  { id: 'documentary', name: 'Documentary', description: 'توازن طبيعي وتباين واقعي', filter: 'none', brightness: .01, contrast: 1.10, saturation: .95, temperature: 0, vignette: .08, swatches: ['#253039', '#7d8e8c', '#d8ddd8'] },
  { id: 'commercial-crisp', name: 'Commercial Crisp', description: 'حدة وتباين إعلاني نظيف للمنتجات والمحتوى التجاري', filter: 'vivid', brightness: .02, contrast: 1.14, saturation: 1.08, temperature: 0, vignette: .05, swatches: ['#0b1524', '#42b8d5', '#f8fbff'] },
  { id: 'desert-luxe', name: 'Desert Luxe', description: 'دفء فاخر للمشاهد الصحراوية والذهبية', filter: 'warm', brightness: .03, contrast: 1.10, saturation: 1.05, temperature: .24, vignette: .18, swatches: ['#4e2718', '#c8803d', '#f1c98a'] },
  { id: 'emerald-film', name: 'Emerald Film', description: 'أخضر مزرق هادئ بطابع فيلم حديث', filter: 'cool', brightness: -.02, contrast: 1.16, saturation: .93, temperature: -.06, vignette: .28, swatches: ['#092725', '#367d72', '#c7d8c7'] },
  { id: 'rose-cinema', name: 'Rose Cinema', description: 'دفء وردي ناعم للمقابلات والبورتريه', filter: 'warm', brightness: .03, contrast: 1.05, saturation: .90, temperature: .10, vignette: .16, swatches: ['#43272e', '#b16f76', '#efd0c8'] },
  { id: 'moody-drama', name: 'Moody Drama', description: 'ظلال أعمق وتباين درامي للمشاهد القصصية', filter: 'cinematic', brightness: -.06, contrast: 1.25, saturation: .80, temperature: -.10, vignette: .42, swatches: ['#070a10', '#26323e', '#8b6e5a'] },
  { id: 'sports-punch', name: 'Sports Punch', description: 'ألوان قوية وحيوية للحركة والرياضة', filter: 'vivid', brightness: -.01, contrast: 1.22, saturation: 1.28, temperature: .02, vignette: .14, swatches: ['#071e31', '#00a8d6', '#f6be24'] },
]

export const CREATIVE_TRANSITIONS: Array<{ value: VideoTransition; name: string; family: string }> = [
  { value: 'none', name: 'Cut', family: 'Basic' },
  { value: 'fade', name: 'Cross Fade', family: 'Basic' },
  { value: 'dissolve', name: 'Dissolve', family: 'Basic' },
  { value: 'fadeblack', name: 'Fade Black', family: 'Film' },
  { value: 'fadewhite', name: 'Fade White', family: 'Film' },
  { value: 'wipeleft', name: 'Wipe Left', family: 'Motion' },
  { value: 'wiperight', name: 'Wipe Right', family: 'Motion' },
  { value: 'slideleft', name: 'Slide Left', family: 'Motion' },
  { value: 'slideright', name: 'Slide Right', family: 'Motion' },
  { value: 'smoothleft', name: 'Smooth Left', family: 'Smooth' },
  { value: 'smoothright', name: 'Smooth Right', family: 'Smooth' },
  { value: 'circleopen', name: 'Circle Open', family: 'Stylized' },
  { value: 'circleclose', name: 'Circle Close', family: 'Stylized' },
  { value: 'pixelize', name: 'Pixelize', family: 'Stylized' },
]

export const DEFAULT_CREATIVE_SETTINGS: CreativeProjectSettings = {
  look: 'none',
  lookStrength: .8,
  transition: 'none',
  transitionDuration: .45,
  speedRamp: 'off',
  audioDuckingEnabled: false,
  duckingStrength: .65,
  audioFadeIn: 0,
  audioFadeOut: 0,
  titles: [],
  colorGrade: { ...DEFAULT_COLOR_GRADE },
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function settingsKey(projectId?: string | null) {
  return `${STORAGE_PREFIX}${projectId || GLOBAL_KEY}`
}

function validColor(value: unknown, fallback: string) {
  const text = String(value || '')
  return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback
}

export function sanitizeColorGrade(raw?: Partial<CreativeColorGrade> | null): CreativeColorGrade {
  const value = raw || {}
  return {
    enabled: Boolean(value.enabled),
    exposure: clamp(Number(value.exposure ?? 0), -3, 3),
    contrast: clamp(Number(value.contrast ?? 1), .5, 2),
    highlights: clamp(Number(value.highlights ?? 0), -1, 1),
    shadows: clamp(Number(value.shadows ?? 0), -1, 1),
    whites: clamp(Number(value.whites ?? 0), -1, 1),
    blacks: clamp(Number(value.blacks ?? 0), -1, 1),
    temperature: clamp(Number(value.temperature ?? 0), -1, 1),
    tint: clamp(Number(value.tint ?? 0), -1, 1),
    saturation: clamp(Number(value.saturation ?? 1), 0, 2),
    vibrance: clamp(Number(value.vibrance ?? 0), -1, 1),
    hue: clamp(Number(value.hue ?? 0), -180, 180),
    gamma: clamp(Number(value.gamma ?? 1), .5, 2),
    curveShadows: clamp(Number(value.curveShadows ?? 0), -1, 1),
    curveMidtones: clamp(Number(value.curveMidtones ?? 0), -1, 1),
    curveHighlights: clamp(Number(value.curveHighlights ?? 0), -1, 1),
    vignette: clamp(Number(value.vignette ?? 0), 0, 1),
    sharpen: clamp(Number(value.sharpen ?? 0), 0, 1),
  }
}

function sanitizeTitle(raw: Partial<CreativeTitle>, index: number): CreativeTitle {
  const startAt = clamp(Number(raw.startAt ?? 0), 0, 86400)
  const kind = raw.kind === 'subtitle' ? 'subtitle' : 'title'
  const position = raw.position === 'top' || raw.position === 'center' ? raw.position : 'bottom'
  const defaultY = position === 'top' ? .08 : position === 'center' ? .5 : .92
  const fontPreset: CreativeFontPreset = ['sans', 'sans-bold', 'serif', 'serif-bold', 'mono', 'mono-bold'].includes(String(raw.fontPreset)) ? raw.fontPreset as CreativeFontPreset : 'sans-bold'
  const align: CreativeTextAlign = ['left', 'center', 'right'].includes(String(raw.align)) ? raw.align as CreativeTextAlign : 'center'
  const animation: CreativeTextAnimation = ['none', 'fade', 'slide-up', 'slide-left', 'slide-right', 'pop'].includes(String(raw.animation)) ? raw.animation as CreativeTextAnimation : kind === 'subtitle' ? 'fade' : 'none'
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `title-${Date.now().toString(36)}-${index}`,
    kind,
    text: String(raw.text || '').slice(0, 700),
    startAt,
    endAt: Math.max(startAt + .1, clamp(Number(raw.endAt ?? startAt + 4), 0, 86400)),
    size: clamp(Number(raw.size ?? (kind === 'subtitle' ? 38 : 54)), 18, 140),
    position,
    color: validColor(raw.color, '#ffffff'),
    boxOpacity: clamp(Number(raw.boxOpacity ?? (kind === 'subtitle' ? .48 : .30)), 0, 1),
    fontPreset,
    align,
    x: clamp(Number(raw.x ?? .5), 0, 1),
    y: clamp(Number(raw.y ?? defaultY), 0, 1),
    boxColor: validColor(raw.boxColor, '#000000'),
    boxPadding: clamp(Number(raw.boxPadding ?? (kind === 'subtitle' ? 12 : 14)), 0, 40),
    borderColor: validColor(raw.borderColor, '#000000'),
    borderWidth: clamp(Number(raw.borderWidth ?? (kind === 'subtitle' ? 0 : 1)), 0, 10),
    shadowColor: validColor(raw.shadowColor, '#000000'),
    shadowDistance: clamp(Number(raw.shadowDistance ?? (kind === 'subtitle' ? 2 : 3)), 0, 14),
    lineSpacing: clamp(Number(raw.lineSpacing ?? 4), -10, 40),
    animation,
  }
}

export function loadCreativeSettings(projectId?: string | null): CreativeProjectSettings {
  if (typeof window === 'undefined') return { ...DEFAULT_CREATIVE_SETTINGS, colorGrade: { ...DEFAULT_COLOR_GRADE } }
  try {
    const raw = window.localStorage.getItem(settingsKey(projectId))
    if (!raw) return { ...DEFAULT_CREATIVE_SETTINGS, colorGrade: { ...DEFAULT_COLOR_GRADE } }
    const parsed = JSON.parse(raw) as Partial<CreativeProjectSettings>
    const look = CREATIVE_LOOKS.some((item) => item.id === parsed.look) ? parsed.look! : 'none'
    const transition = CREATIVE_TRANSITIONS.some((item) => item.value === parsed.transition) ? parsed.transition! : 'none'
    const speedRamp: SpeedRampPreset = ['off', 'montage', 'hero', 'bullet', 'flash'].includes(String(parsed.speedRamp)) ? parsed.speedRamp as SpeedRampPreset : 'off'
    return {
      look,
      lookStrength: clamp(Number(parsed.lookStrength ?? .8), 0, 1),
      transition,
      transitionDuration: clamp(Number(parsed.transitionDuration ?? .45), .1, 1.5),
      speedRamp,
      audioDuckingEnabled: Boolean(parsed.audioDuckingEnabled),
      duckingStrength: clamp(Number(parsed.duckingStrength ?? .65), 0, 1),
      audioFadeIn: clamp(Number(parsed.audioFadeIn ?? 0), 0, 10),
      audioFadeOut: clamp(Number(parsed.audioFadeOut ?? 0), 0, 10),
      titles: Array.isArray(parsed.titles) ? parsed.titles.slice(0, 12).map(sanitizeTitle) : [],
      colorGrade: sanitizeColorGrade(parsed.colorGrade),
    }
  } catch {
    return { ...DEFAULT_CREATIVE_SETTINGS, colorGrade: { ...DEFAULT_COLOR_GRADE } }
  }
}

export function saveCreativeSettings(projectId: string | null | undefined, settings: CreativeProjectSettings) {
  if (typeof window === 'undefined') return
  const normalized = { ...settings, colorGrade: sanitizeColorGrade(settings.colorGrade) }
  window.localStorage.setItem(settingsKey(projectId), JSON.stringify(normalized))
  window.dispatchEvent(new CustomEvent('maghrabi-creative-settings-changed', { detail: { projectId, settings: normalized } }))
}

function professionalFields(title: CreativeTitle) {
  return {
    fontPreset: title.fontPreset || 'sans-bold',
    align: title.align || 'center',
    x: clamp(Number(title.x ?? .5), 0, 1),
    y: clamp(Number(title.y ?? (title.position === 'top' ? .08 : title.position === 'center' ? .5 : .92)), 0, 1),
    boxColor: validColor(title.boxColor, '#000000'),
    boxPadding: clamp(Number(title.boxPadding ?? 12), 0, 40),
    borderColor: validColor(title.borderColor, '#000000'),
    borderWidth: clamp(Number(title.borderWidth ?? 0), 0, 10),
    shadowColor: validColor(title.shadowColor, '#000000'),
    shadowDistance: clamp(Number(title.shadowDistance ?? 2), 0, 14),
    lineSpacing: clamp(Number(title.lineSpacing ?? 4), -10, 40),
    animation: title.animation || 'none',
  }
}

function titleTrack(title: CreativeTitle): TextTrackManifest {
  return {
    text: title.text,
    startAt: title.startAt,
    endAt: title.endAt,
    size: title.size,
    position: title.position,
    color: title.color,
    boxOpacity: title.boxOpacity,
    ...professionalFields(title),
  } as TextTrackManifest
}

function subtitleTrack(title: CreativeTitle): SubtitleTrackManifest {
  return {
    text: title.text,
    startAt: title.startAt,
    endAt: title.endAt,
    size: title.size,
    position: title.position,
    color: title.color,
    boxOpacity: title.boxOpacity,
    ...professionalFields(title),
  } as SubtitleTrackManifest
}

export function applyCreativeSettingsToManifest(
  manifest: VideoProjectManifestV12,
  settings: CreativeProjectSettings,
): VideoProjectManifestV12 {
  const strength = clamp(settings.lookStrength, 0, 1)
  const preset = CREATIVE_LOOKS.find((item) => item.id === settings.look) || CREATIVE_LOOKS[0]
  const clips = (manifest.clips || []).map((clip) => {
    const next = { ...clip }
    if (preset.id !== 'none') {
      next.filter = preset.filter
      next.brightness = clamp(Number(next.brightness ?? 0) + preset.brightness * strength, -.6, .6)
      next.contrast = clamp(Number(next.contrast ?? 1) * (1 + (preset.contrast - 1) * strength), .5, 2)
      next.saturation = clamp(Number(next.saturation ?? 1) * (1 + (preset.saturation - 1) * strength), 0, 3)
      next.temperature = clamp(Number(next.temperature ?? 0) + preset.temperature * strength, -1, 1)
      next.vignette = clamp(Math.max(Number(next.vignette ?? 0), preset.vignette * strength), 0, 1)
    }
    if (settings.speedRamp !== 'off') next.speedRamp = settings.speedRamp
    else next.speedRamp = next.speedRamp || 'off'
    next.audioFadeIn = Math.max(Number(next.audioFadeIn || 0), settings.audioFadeIn)
    next.audioFadeOut = Math.max(Number(next.audioFadeOut || 0), settings.audioFadeOut)
    return next
  })

  const existingText = Array.isArray(manifest.textTracks) ? manifest.textTracks : []
  const existingSubs = Array.isArray(manifest.subtitleTracks) ? manifest.subtitleTracks : []
  const titles = settings.titles.filter((item) => item.kind === 'title' && item.text.trim()).map(titleTrack)
  const subtitles = settings.titles.filter((item) => item.kind === 'subtitle' && item.text.trim()).map(subtitleTrack)
  const audioTracks = (manifest.audioTracks || []).map((track) => ({
    ...track,
    fadeIn: Math.max(Number(track.fadeIn || 0), settings.audioFadeIn),
    fadeOut: Math.max(Number(track.fadeOut || 0), settings.audioFadeOut),
  }))

  const enhanced = {
    ...manifest,
    clips,
    transition: settings.transition,
    transitionDuration: clamp(settings.transitionDuration, .1, 1.5),
    textTracks: [...existingText, ...titles],
    subtitleTracks: [...existingSubs, ...subtitles],
    audioTracks,
    audioDuckingEnabled: settings.audioDuckingEnabled,
    duckingStrength: clamp(settings.duckingStrength, 0, 1),
    colorGrade: sanitizeColorGrade(settings.colorGrade),
  }
  return enhanced as VideoProjectManifestV12
}