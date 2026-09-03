const DB_NAME = 'maghrabi-media-studio'
const STORE_NAME = 'projects'
const PROJECT_KEY = 'video-v3-current'
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

export async function saveStoredVideoProject<T>(snapshot: StoredVideoProject<T>) {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put(snapshot, PROJECT_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error || new Error('تعذر حفظ المشروع محليًا.'))
      tx.onabort = () => reject(tx.error || new Error('تم إيقاف حفظ المشروع.'))
    })
  } finally {
    db.close()
  }
}

export async function loadStoredVideoProject<T>() {
  const db = await openDb()
  try {
    return await new Promise<StoredVideoProject<T> | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const request = tx.objectStore(STORE_NAME).get(PROJECT_KEY)
      request.onsuccess = () => resolve((request.result as StoredVideoProject<T> | undefined) || null)
      request.onerror = () => reject(request.error || new Error('تعذر استعادة المشروع.'))
    })
  } finally {
    db.close()
  }
}

export async function clearStoredVideoProject() {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).delete(PROJECT_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error || new Error('تعذر حذف المشروع المحفوظ.'))
    })
  } finally {
    db.close()
  }
}
