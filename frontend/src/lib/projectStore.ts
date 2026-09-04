import { getActiveStudioProjectId, touchStudioProject } from './projectHubStore'

const DB_NAME = 'maghrabi-media-studio'
const STORE_NAME = 'projects'
const LEGACY_PROJECT_KEY = 'video-v3-current'
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

export async function saveStoredVideoProject<T>(snapshot: StoredVideoProject<T>, projectId?: string | null) {
  const db = await openDb()
  const activeId = projectId || getActiveStudioProjectId()
  try {
    await writeSnapshot(db, projectKey(activeId), snapshot)
    if (activeId) touchStudioProject(activeId)
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

    // One-time compatibility path: when opening the first named project,
    // copy the historical single-project snapshot into that project.
    if (activeId && key !== LEGACY_PROJECT_KEY) {
      const legacy = await readSnapshot<T>(db, LEGACY_PROJECT_KEY)
      if (legacy) {
        await writeSnapshot(db, key, legacy)
        touchStudioProject(activeId)
        return legacy
      }
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

export async function clearStoredVideoProject(projectId?: string | null) {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).delete(projectKey(projectId))
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error || new Error('تعذر حذف المشروع المحفوظ.'))
    })
  } finally {
    db.close()
  }
}
