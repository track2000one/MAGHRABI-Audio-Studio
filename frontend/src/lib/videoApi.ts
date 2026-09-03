export type VideoFilter = 'none' | 'warm' | 'cool' | 'cinematic' | 'vivid' | 'mono'
export type OutputSize = '720p' | '1080p' | 'portrait' | 'square'
export type RenderQuality = 'draft' | 'standard' | 'high'
export type VideoTransition = 'none' | 'fade' | 'fadeblack' | 'fadewhite' | 'dissolve' | 'wipeleft' | 'wiperight' | 'slideleft' | 'slideright' | 'smoothleft' | 'smoothright' | 'circleopen' | 'circleclose' | 'pixelize'
export type SpeedRampPreset = 'off' | 'montage' | 'hero' | 'bullet' | 'flash'
export type PrivacyEffect = 'none' | 'blur' | 'mosaic'

export type VideoClipManifest = {
  fileIndex: number
  start: number
  end: number
  speed: number
  volume: number
  filter: VideoFilter
  text: string
  textSize: number
  textPosition: 'top' | 'center' | 'bottom'
  rotation?: 0 | 90 | 180 | 270
  fit?: 'contain' | 'cover'
  zoomStart?: number
  zoomEnd?: number
  panXStart?: number
  panXEnd?: number
  panYStart?: number
  panYEnd?: number
  chromaEnabled?: boolean
  chromaColor?: string
  chromaBackground?: string
  chromaSimilarity?: number
  chromaBlend?: number
  brightness?: number
  contrast?: number
  saturation?: number
  temperature?: number
  vignette?: number
  speedRamp?: SpeedRampPreset
  reverse?: boolean
  freezeFrame?: boolean
  freezeDuration?: number
  privacyEffect?: PrivacyEffect
  privacyX?: number
  privacyY?: number
  privacyWidth?: number
  privacyHeight?: number
  privacyIntensity?: number
}

export type TextTrackManifest = {
  text: string
  startAt: number
  endAt: number
  size: number
  position: 'top' | 'center' | 'bottom'
}

export type SubtitleTrackManifest = {
  text: string
  startAt: number
  endAt: number
  size: number
  position: 'top' | 'center' | 'bottom'
  color: string
  boxOpacity: number
}

export type AudioTrackManifest = {
  fileIndex: number
  startAt: number
  sourceStart: number
  sourceEnd: number
  volume: number
  fadeIn: number
  fadeOut: number
}

export type ImageTrackManifest = {
  fileIndex: number
  startAt: number
  endAt: number
  scale: number
  opacity: number
  position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center'
  startX?: number
  startY?: number
  endX?: number
  endY?: number
  scaleStart?: number
  scaleEnd?: number
}

export type VideoOverlayTrackManifest = {
  fileIndex: number
  startAt: number
  endAt: number
  sourceStart: number
  sourceEnd: number
  scale: number
  opacity: number
  x: number
  y: number
  borderRadius?: number
}

export type VideoProjectManifest = {
  clips: VideoClipManifest[]
  transition: VideoTransition
  transitionDuration: number
}

export type VideoProjectManifestV2 = VideoProjectManifest & {
  textTracks: TextTrackManifest[]
  audioTracks: AudioTrackManifest[]
  imageTracks: ImageTrackManifest[]
}

export type VideoProjectManifestV3 = VideoProjectManifestV2 & {
  subtitleTracks: SubtitleTrackManifest[]
}

export type VideoProjectManifestV5 = VideoProjectManifestV3 & {
  videoOverlays: VideoOverlayTrackManifest[]
  audioDuckingEnabled: boolean
  duckingStrength: number
}

export type SilenceInterval = {
  start: number
  end: number
  duration: number
}

export type SilenceDetectionResult = {
  duration: number
  intervals: SilenceInterval[]
  totalSilence: number
  thresholdDb: number
  minDuration: number
}

async function responseError(response: Response) {
  try {
    const payload = await response.json()
    return new Error(payload.detail || 'تعذر تنفيذ عملية الفيديو.')
  } catch {
    return new Error('تعذر تنفيذ عملية الفيديو.')
  }
}

async function renderWithEndpoint(
  endpoint: string,
  videoFiles: File[],
  audioFiles: File[],
  imageFiles: File[],
  manifest: VideoProjectManifestV3 | VideoProjectManifestV5,
  outputSize: OutputSize,
  quality: RenderQuality,
) {
  const form = new FormData()
  videoFiles.forEach((file) => form.append('video_files', file))
  audioFiles.forEach((file) => form.append('audio_files', file))
  imageFiles.forEach((file) => form.append('image_files', file))
  form.append('manifest', JSON.stringify(manifest))
  form.append('output_size', outputSize)
  form.append('quality', quality)
  const response = await fetch(endpoint, { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await responseError(response)
  return response.blob()
}

export async function renderVideoProject(
  files: File[],
  manifest: VideoProjectManifest,
  outputSize: OutputSize,
  quality: RenderQuality,
) {
  const form = new FormData()
  files.forEach((file) => form.append('files', file))
  form.append('manifest', JSON.stringify(manifest))
  form.append('output_size', outputSize)
  form.append('quality', quality)
  const response = await fetch('/api/video/render', { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await responseError(response)
  return response.blob()
}

export function renderVideoProjectV2(
  videoFiles: File[], audioFiles: File[], imageFiles: File[], manifest: VideoProjectManifestV2,
  outputSize: OutputSize, quality: RenderQuality,
) {
  return renderWithEndpoint('/api/video/v2/render', videoFiles, audioFiles, imageFiles, manifest as VideoProjectManifestV3, outputSize, quality)
}

export function renderVideoProjectV3(
  videoFiles: File[], audioFiles: File[], imageFiles: File[], manifest: VideoProjectManifestV3,
  outputSize: OutputSize, quality: RenderQuality,
) {
  return renderWithEndpoint('/api/video/v3/render', videoFiles, audioFiles, imageFiles, manifest, outputSize, quality)
}

export function renderVideoProjectV4(
  videoFiles: File[], audioFiles: File[], imageFiles: File[], manifest: VideoProjectManifestV3,
  outputSize: OutputSize, quality: RenderQuality,
) {
  return renderWithEndpoint('/api/video/v4/render', videoFiles, audioFiles, imageFiles, manifest, outputSize, quality)
}

export function renderVideoProjectV5(
  videoFiles: File[], audioFiles: File[], imageFiles: File[], manifest: VideoProjectManifestV5,
  outputSize: OutputSize, quality: RenderQuality,
) {
  return renderWithEndpoint('/api/video/v5/render', videoFiles, audioFiles, imageFiles, manifest, outputSize, quality)
}

export async function detectVideoSilence(file: File, thresholdDb = -35, minDuration = .5): Promise<SilenceDetectionResult> {
  const form = new FormData()
  form.append('file', file)
  form.append('threshold_db', String(thresholdDb))
  form.append('min_duration', String(minDuration))
  const response = await fetch('/api/video/v4/silence-detect', { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await responseError(response)
  return response.json()
}
