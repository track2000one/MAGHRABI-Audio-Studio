import { getActiveStudioProjectId, touchStudioProject } from './projectHubStore'

const DB_NAME = 'maghrabi-media-studio'
const STORE_NAME = 'projects'
const LEGACY_PROJECT_KEY = 'video-v3-current'
const LEGACY_MIGRATION_KEY = 'maghrabi-legacy-project-migrated-v1'
const PROJECT_PREFIX = 'video-project:'
const DB_VERSION = 1

export type StoredVideoProject<T> = {
  version: 3
  savedAt: string
  project: T
  videos: File[]
  videoDurations: number[]
  audios: File[]
  audioDurations: number[]
  images: File[]
  outputSize: string
  quality: string
}

export type StoredProjectInfo = {
  exists: boolean
  savedAt: string | null
  videoCount: number
  audioCount: number
  outputSize: string | null
  quality: string | null
}

function openDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('تعذر فتح مساحة حفظ المشروع.'))
  })
}

function projectKey(projectId?: string | null) {
  const id = projectId || getActiveStudioProjectId()
  return id ? `${PROJECT_PREFIX}${id}` : LEGACY_PROJECT_KEY
}

async function readSnapshot<T>(db: IDBDatabase, key: string) {
  return await new Promise<StoredVideoProject<T> | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const request = tx.objectStore(STORE_NAME).get(key)
    request.onsuccess = () => resolve((request.result as StoredVideoProject<T> | undefined) || null)
    request.onerror = () => reject(request.error || new Error('تعذر استعادة المشروع.'))
  })
}

async function writeSnapshot<T>(db: IDBDatabase, key: string, snapshot: StoredVideoProject<T>) {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(snapshot, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error || new Error('تعذر حفظ المشروع محليًا.'))
    tx.onabort = () => reject(tx.error || new Error('تم إيقاف حفظ المشروع.'))
  })
}

function emitSnapshotChanged(projectId: string | null, savedAt: string | null) {
  window.dispatchEvent(new CustomEvent('maghrabi-project-snapshot-changed', { detail: { projectId, savedAt } }))
}

export async function saveStoredVideoProject<T>(snapshot: StoredVideoProject<T>, projectId?: string | null) {
  const db = await openDb()
  const activeId = projectId || getActiveStudioProjectId()
  try {
    await writeSnapshot(db, projectKey(activeId), snapshot)
    if (activeId) touchStudioProject(activeId)
    emitSnapshotChanged(activeId, snapshot.savedAt)
  } finally {
    db.close()
  }
}

export async function loadStoredVideoProject<T>(projectId?: string | null) {
  const db = await openDb()
  const activeId = projectId || getActiveStudioProjectId()
  const key = projectKey(activeId)
  try {
    const snapshot = await readSnapshot<T>(db, key)
    if (snapshot) return snapshot

    // One-time compatibility path. The historical single-project snapshot may
    // be adopted by the first named Studio project only, never cloned again.
    const migrationDone = localStorage.getItem(LEGACY_MIGRATION_KEY) === '1'
    if (activeId && key !== LEGACY_PROJECT_KEY && !migrationDone) {
      const legacy = await readSnapshot<T>(db, LEGACY_PROJECT_KEY)
      if (legacy) {
        await writeSnapshot(db, key, legacy)
        localStorage.setItem(LEGACY_MIGRATION_KEY, '1')
        touchStudioProject(activeId)
        emitSnapshotChanged(activeId, legacy.savedAt)
        return legacy
      }
      localStorage.setItem(LEGACY_MIGRATION_KEY, '1')
    }
    return null
  } finally {
    db.close()
  }
}

export async function hasStoredVideoProject(projectId?: string | null) {
  const db = await openDb()
  try {
    return Boolean(await readSnapshot(db, projectKey(projectId)))
  } finally {
    db.close()
  }
}

export async function getStoredVideoProjectInfo(projectId?: string | null): Promise<StoredProjectInfo> {
  const db = await openDb()
  try {
    const snapshot = await readSnapshot<unknown>(db, projectKey(projectId))
    if (!snapshot) return { exists: false, savedAt: null, videoCount: 0, audioCount: 0, outputSize: null, quality: null }
    return {
      exists: true,
      savedAt: snapshot.savedAt || null,
      videoCount: snapshot.videos?.length || 0,
      audioCount: snapshot.audios?.length || 0,
      outputSize: snapshot.outputSize || null,
      quality: snapshot.quality || null,
    }
  } finally {
    db.close()
  }
}

export async function clearStoredVideoProject(projectId?: string | null) {
  const activeId = projectId || getActiveStudioProjectId()
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).delete(projectKey(activeId))
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error || new Error('تعذر حذف المشروع المحفوظ.'))
    })
    emitSnapshotChanged(activeId, null)
  } finally {
    db.close()
  }
}
