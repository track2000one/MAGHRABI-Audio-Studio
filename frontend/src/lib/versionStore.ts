const DB_NAME = 'maghrabi-media-studio-v13'
const STORE_NAME = 'versions'
const DB_VERSION = 1
const MAX_VERSIONS = 12

export type ProjectVersion<T> = {
  id: string
  savedAt: string
  label: string
  automatic: boolean
  project: T
  outputSize: string
  quality: string
  fps: number
}

function openDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('savedAt', 'savedAt')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('تعذر فتح سجل نسخ المشروع.'))
  })
}

async function readAll<T>(db: IDBDatabase) {
  return new Promise<ProjectVersion<T>[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const request = tx.objectStore(STORE_NAME).getAll()
    request.onsuccess = () => resolve((request.result as ProjectVersion<T>[]).sort((a, b) => b.savedAt.localeCompare(a.savedAt)))
    request.onerror = () => reject(request.error || new Error('تعذر قراءة نسخ المشروع.'))
  })
}

export async function saveProjectVersion<T>(version: ProjectVersion<T>) {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put(version)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error || new Error('تعذر حفظ نسخة المشروع.'))
      tx.onabort = () => reject(tx.error || new Error('تم إيقاف حفظ النسخة.'))
    })
    const versions = await readAll<T>(db)
    const stale = versions.slice(MAX_VERSIONS)
    if (stale.length) {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        const store = tx.objectStore(STORE_NAME)
        stale.forEach((item) => store.delete(item.id))
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error || new Error('تعذر تنظيف نسخ المشروع القديمة.'))
      })
    }
  } finally {
    db.close()
  }
}

export async function listProjectVersions<T>() {
  const db = await openDb()
  try {
    return await readAll<T>(db)
  } finally {
    db.close()
  }
}

export async function loadProjectVersion<T>(id: string) {
  const db = await openDb()
  try {
    return await new Promise<ProjectVersion<T> | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const request = tx.objectStore(STORE_NAME).get(id)
      request.onsuccess = () => resolve((request.result as ProjectVersion<T> | undefined) || null)
      request.onerror = () => reject(request.error || new Error('تعذر استعادة نسخة المشروع.'))
    })
  } finally {
    db.close()
  }
}

export async function deleteProjectVersion(id: string) {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).delete(id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error || new Error('تعذر حذف نسخة المشروع.'))
    })
  } finally {
    db.close()
  }
}
