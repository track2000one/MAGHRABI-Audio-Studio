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
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function settingsKey(projectId?: string | null) {
  return `${STORAGE_PREFIX}${projectId || GLOBAL_KEY}`
}

function sanitizeTitle(raw: Partial<CreativeTitle>, index: number): CreativeTitle {
  const startAt = clamp(Number(raw.startAt ?? 0), 0, 86400)
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `title-${Date.now().toString(36)}-${index}`,
    kind: raw.kind === 'subtitle' ? 'subtitle' : 'title',
    text: String(raw.text || '').slice(0, 700),
    startAt,
    endAt: Math.max(startAt + .1, clamp(Number(raw.endAt ?? startAt + 4), 0, 86400)),
    size: clamp(Number(raw.size ?? (raw.kind === 'subtitle' ? 38 : 54)), 18, 120),
    position: raw.position === 'top' || raw.position === 'center' ? raw.position : 'bottom',
    color: /^#[0-9a-f]{6}$/i.test(String(raw.color || '')) ? String(raw.color) : '#ffffff',
    boxOpacity: clamp(Number(raw.boxOpacity ?? .48), 0, 1),
  }
}

export function loadCreativeSettings(projectId?: string | null): CreativeProjectSettings {
  if (typeof window === 'undefined') return { ...DEFAULT_CREATIVE_SETTINGS }
  try {
    const raw = window.localStorage.getItem(settingsKey(projectId))
    if (!raw) return { ...DEFAULT_CREATIVE_SETTINGS }
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
    }
  } catch {
    return { ...DEFAULT_CREATIVE_SETTINGS }
  }
}

export function saveCreativeSettings(projectId: string | null | undefined, settings: CreativeProjectSettings) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(settingsKey(projectId), JSON.stringify(settings))
  window.dispatchEvent(new CustomEvent('maghrabi-creative-settings-changed', { detail: { projectId, settings } }))
}

function titleTrack(title: CreativeTitle): TextTrackManifest {
  return { text: title.text, startAt: title.startAt, endAt: title.endAt, size: title.size, position: title.position }
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
  }
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
    next.speedRamp = settings.speedRamp
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

  return {
    ...manifest,
    clips,
    transition: settings.transition,
    transitionDuration: clamp(settings.transitionDuration, .1, 1.5),
    textTracks: [...existingText, ...titles],
    subtitleTracks: [...existingSubs, ...subtitles],
    audioTracks,
    audioDuckingEnabled: settings.audioDuckingEnabled,
    duckingStrength: clamp(settings.duckingStrength, 0, 1),
  }
}
