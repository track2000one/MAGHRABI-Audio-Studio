import { getActiveStudioProjectId } from './projectHubStore'

export type NestedVideoLane = 'V1' | 'V2' | 'V3'
export type NestedAudioLane = 'A1' | 'A2' | 'A3'

export type NestedVideoClip = {
  id: string
  lane: NestedVideoLane
  startAt: number
  fileIndex: number
  start: number
  end: number
  speed: number
  volume: number
  filter?: string
  linkedAudio?: boolean
  freezeFrame?: boolean
  freezeDuration?: number
  [key: string]: unknown
}

export type NestedAudioClip = {
  id: string
  lane: NestedAudioLane
  name: string
  fileIndex: number
  startAt: number
  sourceStart: number
  sourceEnd: number
  volume: number
  fadeIn?: number
  fadeOut?: number
  [key: string]: unknown
}

export type NestedMixer = {
  video: number
  music: number
  pip: number
  master: number
}

export type NestedSequence = {
  id: string
  name: string
  enabled: boolean
  parentStartAt: number
  duration: number
  videoClips: NestedVideoClip[]
  audioClips: NestedAudioClip[]
  mixer: NestedMixer
  createdAt: string
  updatedAt: string
}

export type NestedSequenceSettings = {
  sequences: NestedSequence[]
}

export type ParentTimelineSnapshot = {
  clips?: Array<Record<string, unknown>>
  audioTracks?: Array<Record<string, unknown>>
  mixer?: Partial<NestedMixer>
  rangeIn?: number | null
  rangeOut?: number | null
}

const STORAGE_PREFIX = 'maghrabi-nested-sequences-v2:'
const MAX_SEQUENCES = 12
const MAX_VIDEO_CLIPS = 120
const MAX_AUDIO_CLIPS = 80
const DEFAULT_MIXER: NestedMixer = { video: 1, music: 1, pip: 1, master: 1 }
const DEFAULT_SETTINGS: NestedSequenceSettings = { sequences: [] }

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function key(projectId?: string | null) {
  return `${STORAGE_PREFIX}${projectId || 'global'}`
}

function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function videoDuration(clip: Record<string, unknown>) {
  if (clip.freezeFrame) return clamp(Number(clip.freezeDuration ?? 2), .1, 12)
  const source = Math.max(.02, Number(clip.end ?? 0) - Number(clip.start ?? 0))
  return source / clamp(Number(clip.speed ?? 1), .25, 4)
}

function audioDuration(clip: Record<string, unknown>) {
  return Math.max(.02, Number(clip.sourceEnd ?? 0) - Number(clip.sourceStart ?? 0))
}

function sanitizeVideo(raw: Record<string, unknown>, index: number): NestedVideoClip {
  const lane = ['V1', 'V2', 'V3'].includes(String(raw.lane)) ? String(raw.lane) as NestedVideoLane : 'V1'
  const start = Math.max(0, Number(raw.start ?? 0))
  const end = Math.max(start + .02, Number(raw.end ?? start + 1))
  return {
    ...raw,
    id: String(raw.id || uid(`nested-video-${index}`)),
    lane,
    startAt: clamp(Number(raw.startAt ?? 0), 0, 86400),
    fileIndex: Math.max(0, Math.floor(Number(raw.fileIndex ?? 0))),
    start,
    end,
    speed: clamp(Number(raw.speed ?? 1), .25, 4),
    volume: clamp(Number(raw.volume ?? 1), 0, 2),
    filter: String(raw.filter || 'none'),
    linkedAudio: raw.linkedAudio !== false,
  }
}

function sanitizeAudio(raw: Record<string, unknown>, index: number): NestedAudioClip {
  const lane = ['A1', 'A2', 'A3'].includes(String(raw.lane)) ? String(raw.lane) as NestedAudioLane : 'A1'
  const sourceStart = Math.max(0, Number(raw.sourceStart ?? 0))
  const sourceEnd = Math.max(sourceStart + .02, Number(raw.sourceEnd ?? sourceStart + 1))
  return {
    ...raw,
    id: String(raw.id || uid(`nested-audio-${index}`)),
    lane,
    name: String(raw.name || `Audio ${index + 1}`).slice(0, 120),
    fileIndex: Math.max(0, Math.floor(Number(raw.fileIndex ?? 0))),
    startAt: clamp(Number(raw.startAt ?? 0), 0, 86400),
    sourceStart,
    sourceEnd,
    volume: clamp(Number(raw.volume ?? .75), 0, 2),
    fadeIn: clamp(Number(raw.fadeIn ?? 0), 0, 10),
    fadeOut: clamp(Number(raw.fadeOut ?? 0), 0, 10),
  }
}

function sanitizeMixer(raw?: Partial<NestedMixer>): NestedMixer {
  return {
    video: clamp(Number(raw?.video ?? 1), 0, 2),
    music: clamp(Number(raw?.music ?? 1), 0, 2),
    pip: clamp(Number(raw?.pip ?? 1), 0, 2),
    master: clamp(Number(raw?.master ?? 1), 0, 2),
  }
}

export function sanitizeNestedSequence(raw: Partial<NestedSequence>, index = 0): NestedSequence {
  const createdAt = String(raw.createdAt || new Date().toISOString())
  const duration = clamp(Number(raw.duration ?? 5), .1, 900)
  return {
    id: String(raw.id || uid(`nested-${index}`)),
    name: String(raw.name || `Compound ${index + 1}`).slice(0, 80),
    enabled: raw.enabled !== false,
    parentStartAt: clamp(Number(raw.parentStartAt ?? 0), 0, 86400),
    duration,
    videoClips: Array.isArray(raw.videoClips) ? raw.videoClips.slice(0, MAX_VIDEO_CLIPS).map((item, itemIndex) => sanitizeVideo(item as Record<string, unknown>, itemIndex)) : [],
    audioClips: Array.isArray(raw.audioClips) ? raw.audioClips.slice(0, MAX_AUDIO_CLIPS).map((item, itemIndex) => sanitizeAudio(item as Record<string, unknown>, itemIndex)) : [],
    mixer: sanitizeMixer(raw.mixer),
    createdAt,
    updatedAt: String(raw.updatedAt || createdAt),
  }
}

export function loadNestedSequenceSettings(projectId?: string | null): NestedSequenceSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key(projectId)) || '{}') as Partial<NestedSequenceSettings>
    return {
      sequences: Array.isArray(parsed.sequences) ? parsed.sequences.slice(0, MAX_SEQUENCES).map(sanitizeNestedSequence) : [],
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveNestedSequenceSettings(projectId: string | null | undefined, settings: NestedSequenceSettings) {
  if (typeof window === 'undefined') return
  const normalized = {
    sequences: settings.sequences.slice(0, MAX_SEQUENCES).map((item, index) => sanitizeNestedSequence(item, index)),
  }
  window.localStorage.setItem(key(projectId), JSON.stringify(normalized))
  window.dispatchEvent(new CustomEvent('maghrabi-nested-sequences-changed', { detail: { projectId, settings: normalized } }))
}

function trimVideoToRange(raw: Record<string, unknown>, rangeStart: number, rangeEnd: number): NestedVideoClip | null {
  const clipStart = Number(raw.startAt ?? 0)
  const clipEnd = clipStart + videoDuration(raw)
  const overlapStart = Math.max(rangeStart, clipStart)
  const overlapEnd = Math.min(rangeEnd, clipEnd)
  if (overlapEnd <= overlapStart + .015) return null
  const speed = clamp(Number(raw.speed ?? 1), .25, 4)
  const copy: Record<string, unknown> = { ...raw, id: uid('nested-video'), startAt: overlapStart - rangeStart }
  if (raw.freezeFrame) {
    copy.freezeDuration = overlapEnd - overlapStart
  } else {
    const sourceStart = Number(raw.start ?? 0) + (overlapStart - clipStart) * speed
    const sourceEnd = Number(raw.start ?? 0) + (overlapEnd - clipStart) * speed
    copy.start = sourceStart
    copy.end = Math.max(sourceStart + .02, sourceEnd)
  }
  return sanitizeVideo(copy, 0)
}

function trimAudioToRange(raw: Record<string, unknown>, rangeStart: number, rangeEnd: number): NestedAudioClip | null {
  const clipStart = Number(raw.startAt ?? 0)
  const clipEnd = clipStart + audioDuration(raw)
  const overlapStart = Math.max(rangeStart, clipStart)
  const overlapEnd = Math.min(rangeEnd, clipEnd)
  if (overlapEnd <= overlapStart + .015) return null
  const sourceStart = Number(raw.sourceStart ?? 0) + (overlapStart - clipStart)
  const copy: Record<string, unknown> = {
    ...raw,
    id: uid('nested-audio'),
    startAt: overlapStart - rangeStart,
    sourceStart,
    sourceEnd: sourceStart + (overlapEnd - overlapStart),
  }
  return sanitizeAudio(copy, 0)
}

export function captureNestedSequence(
  project: ParentTimelineSnapshot,
  requestedStart: number,
  requestedEnd: number,
  name?: string,
): NestedSequence {
  const clips = Array.isArray(project.clips) ? project.clips : []
  const main = clips.filter((clip) => String(clip.lane || 'V1') === 'V1')
  const candidates = main.filter((clip) => {
    const start = Number(clip.startAt ?? 0)
    const end = start + videoDuration(clip)
    return end > requestedStart + .015 && start < requestedEnd - .015
  })
  if (!candidates.length) throw new Error('لا يوجد Clip على V1 داخل النطاق المطلوب لإنشاء Compound Sequence.')

  // Snap to complete V1 clip boundaries. This prevents partial Speed Ramp
  // extraction and gives the backend deterministic replacement boundaries.
  const rangeStart = Math.min(...candidates.map((clip) => Number(clip.startAt ?? 0)))
  const rangeEnd = Math.max(...candidates.map((clip) => Number(clip.startAt ?? 0) + videoDuration(clip)))
  const videoClips = clips.map((clip) => trimVideoToRange(clip, rangeStart, rangeEnd)).filter(Boolean) as NestedVideoClip[]
  const audioClips = (Array.isArray(project.audioTracks) ? project.audioTracks : []).map((clip) => trimAudioToRange(clip, rangeStart, rangeEnd)).filter(Boolean) as NestedAudioClip[]
  const now = new Date().toISOString()
  return sanitizeNestedSequence({
    id: uid('nested-sequence'),
    name: name || `Compound ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`,
    enabled: true,
    parentStartAt: rangeStart,
    duration: rangeEnd - rangeStart,
    videoClips,
    audioClips,
    mixer: sanitizeMixer(project.mixer),
    createdAt: now,
    updatedAt: now,
  })
}

export function nestedSequenceToManifest(sequence: NestedSequence) {
  const master = sequence.mixer.master
  const main = sequence.videoClips
    .filter((clip) => clip.lane === 'V1')
    .sort((a, b) => a.startAt - b.startAt)
    .map((clip) => {
      const { id: _id, lane: _lane, startAt, linkedAudio: _linkedAudio, ...rest } = clip
      return {
        ...rest,
        timelineStartAt: startAt,
        volume: clamp(Number(clip.volume ?? 1) * sequence.mixer.video * master, 0, 2),
      }
    })
  const overlays = sequence.videoClips
    .filter((clip) => clip.lane !== 'V1')
    .map((clip) => ({
      fileIndex: clip.fileIndex,
      startAt: clip.startAt,
      endAt: Math.min(sequence.duration, clip.startAt + videoDuration(clip)),
      sourceStart: clip.start,
      sourceEnd: clip.end,
      scale: clip.lane === 'V2' ? .42 : .3,
      opacity: 1,
      x: clip.lane === 'V2' ? .55 : .05,
      y: clip.lane === 'V2' ? .53 : .06,
      borderRadius: .035,
      audioEnabled: clip.linkedAudio !== false,
      audioVolume: clamp(Number(clip.volume ?? 1) * sequence.mixer.pip * master, 0, 2),
    }))
  const audioTracks = sequence.audioClips.map((clip) => {
    const { id: _id, lane: _lane, name: _name, ...rest } = clip
    return { ...rest, volume: clamp(clip.volume * sequence.mixer.music * master, 0, 2) }
  })
  return {
    clips: main,
    textTracks: [],
    subtitleTracks: [],
    imageTracks: [],
    videoOverlays: overlays,
    audioTracks,
    transition: 'none',
    transitionDuration: .1,
    audioDuckingEnabled: false,
    duckingStrength: .65,
    magneticSnap: true,
  }
}

export function activeNestedSequenceSettings() {
  return loadNestedSequenceSettings(getActiveStudioProjectId())
}

export function injectActiveNestedSequences(manifest: Record<string, unknown>) {
  const settings = activeNestedSequenceSettings()
  const compoundSequences = settings.sequences
    .filter((sequence) => sequence.enabled && sequence.videoClips.some((clip) => clip.lane === 'V1'))
    .map((sequence) => ({
      id: sequence.id,
      name: sequence.name,
      enabled: sequence.enabled,
      parentStartAt: sequence.parentStartAt,
      duration: sequence.duration,
      manifest: nestedSequenceToManifest(sequence),
    }))
  return { ...manifest, compoundSequences }
}

export function rangesOverlap(a: NestedSequence, b: NestedSequence) {
  return a.parentStartAt < b.parentStartAt + b.duration - .015 && b.parentStartAt < a.parentStartAt + a.duration - .015
}
