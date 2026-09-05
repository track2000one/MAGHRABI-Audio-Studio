import type { VideoProjectManifestV12 } from './videoApi'

export type AudioMixerLane = 'A1' | 'A2' | 'A3'

export type AudioMixerChannelSettings = {
  gainDb: number
  pan: number
  muted: boolean
  solo: boolean
}

export type AudioMixerMasterSettings = {
  gainDb: number
  limiterEnabled: boolean
  limiterCeilingDb: number
  normalizeEnabled: boolean
  targetLufs: number
}

export type AudioMixerSettings = {
  channels: Record<AudioMixerLane, AudioMixerChannelSettings>
  master: AudioMixerMasterSettings
}

const STORAGE_PREFIX = 'maghrabi-audio-mixer-v1:'
const GLOBAL_KEY = 'global'

const defaultChannel = (): AudioMixerChannelSettings => ({
  gainDb: 0,
  pan: 0,
  muted: false,
  solo: false,
})

export const DEFAULT_AUDIO_MIXER_SETTINGS: AudioMixerSettings = {
  channels: {
    A1: defaultChannel(),
    A2: defaultChannel(),
    A3: defaultChannel(),
  },
  master: {
    gainDb: 0,
    limiterEnabled: true,
    limiterCeilingDb: -1,
    normalizeEnabled: false,
    targetLufs: -14,
  },
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function storageKey(projectId?: string | null) {
  return `${STORAGE_PREFIX}${projectId || GLOBAL_KEY}`
}

function sanitizeChannel(raw: Partial<AudioMixerChannelSettings> | undefined): AudioMixerChannelSettings {
  return {
    gainDb: clamp(Number(raw?.gainDb ?? 0), -60, 12),
    pan: clamp(Number(raw?.pan ?? 0), -1, 1),
    muted: Boolean(raw?.muted),
    solo: Boolean(raw?.solo),
  }
}

export function sanitizeAudioMixerSettings(raw: Partial<AudioMixerSettings> | undefined): AudioMixerSettings {
  return {
    channels: {
      A1: sanitizeChannel(raw?.channels?.A1),
      A2: sanitizeChannel(raw?.channels?.A2),
      A3: sanitizeChannel(raw?.channels?.A3),
    },
    master: {
      gainDb: clamp(Number(raw?.master?.gainDb ?? 0), -24, 12),
      limiterEnabled: raw?.master?.limiterEnabled !== false,
      limiterCeilingDb: clamp(Number(raw?.master?.limiterCeilingDb ?? -1), -12, -.1),
      normalizeEnabled: Boolean(raw?.master?.normalizeEnabled),
      targetLufs: clamp(Number(raw?.master?.targetLufs ?? -14), -24, -9),
    },
  }
}

export function loadAudioMixerSettings(projectId?: string | null): AudioMixerSettings {
  if (typeof window === 'undefined') return sanitizeAudioMixerSettings(DEFAULT_AUDIO_MIXER_SETTINGS)
  try {
    const raw = window.localStorage.getItem(storageKey(projectId))
    if (!raw) return sanitizeAudioMixerSettings(DEFAULT_AUDIO_MIXER_SETTINGS)
    return sanitizeAudioMixerSettings(JSON.parse(raw) as Partial<AudioMixerSettings>)
  } catch {
    return sanitizeAudioMixerSettings(DEFAULT_AUDIO_MIXER_SETTINGS)
  }
}

export function saveAudioMixerSettings(projectId: string | null | undefined, settings: AudioMixerSettings) {
  if (typeof window === 'undefined') return
  const safe = sanitizeAudioMixerSettings(settings)
  window.localStorage.setItem(storageKey(projectId), JSON.stringify(safe))
  window.dispatchEvent(new CustomEvent('maghrabi-audio-mixer-settings-changed', { detail: { projectId, settings: safe } }))
}

export function dbToLinear(db: number) {
  const safe = clamp(db, -60, 24)
  if (safe <= -59.9) return 0
  return Math.pow(10, safe / 20)
}

export function linearToDb(value: number) {
  if (!Number.isFinite(value) || value <= .000001) return -60
  return clamp(20 * Math.log10(value), -60, 24)
}

export function applyAudioMixerMasterToManifest(
  manifest: VideoProjectManifestV12,
  settings: AudioMixerSettings,
): VideoProjectManifestV12 {
  const safe = sanitizeAudioMixerSettings(settings)
  return {
    ...manifest,
    audioMasterGain: dbToLinear(safe.master.gainDb),
    audioLimiterEnabled: safe.master.limiterEnabled,
    audioLimiterCeilingDb: safe.master.limiterCeilingDb,
    audioNormalizeEnabled: safe.master.normalizeEnabled,
    audioTargetLufs: safe.master.targetLufs,
  } as VideoProjectManifestV12
}
