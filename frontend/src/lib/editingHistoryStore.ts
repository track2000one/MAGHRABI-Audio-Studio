import type { StoredVideoProject } from './projectStore'

const DB_NAME = 'maghrabi-studio-edit-history'
const STORE_NAME = 'history'
const DB_VERSION = 1
const MAX_HISTORY = 30

export type EditingHistoryEntry<T = unknown> = {
  id: string
  savedAt: string
  fingerprint: string
  project: T
  outputSize: string
  quality: string
}

type HistoryRecord<T = unknown> = {
  projectId: string
  cursor: number
  entries: EditingHistoryEntry<T>[]
}

export type EditingHistoryState = {
  count: number
  cursor: number
  canUndo: boolean
  canRedo: boolean
}

function openDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('تعذر فتح سجل Undo/Redo.'))
  })
}

async function readRecord<T>(db: IDBDatabase, projectId: string) {
  return await new Promise<HistoryRecord<T>>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const request = tx.objectStore(STORE_NAME).get(projectId)
    request.onsuccess = () => resolve((request.result as HistoryRecord<T> | undefined) || { projectId, cursor: -1, entries: [] })
    request.onerror = () => reject(request.error || new Error('تعذر قراءة سجل التعديلات.'))
  })
}

async function writeRecord<T>(db: IDBDatabase, record: HistoryRecord<T>) {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(record, record.projectId)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error || new Error('تعذر حفظ سجل التعديلات.'))
    tx.onabort = () => reject(tx.error || new Error('تم إيقاف حفظ سجل التعديلات.'))
  })
}

function fingerprint(snapshot: StoredVideoProject<unknown>) {
  return JSON.stringify({ project: snapshot.project, outputSize: snapshot.outputSize, quality: snapshot.quality })
}

function toState(record: HistoryRecord<unknown>): EditingHistoryState {
  return {
    count: record.entries.length,
    cursor: record.cursor,
    canUndo: record.cursor > 0,
    canRedo: record.cursor >= 0 && record.cursor < record.entries.length - 1,
  }
}

export async function pushEditingHistory<T>(projectId: string, snapshot: StoredVideoProject<T>) {
  const db = await openDb()
  try {
    const record = await readRecord<T>(db, projectId)
    const fp = fingerprint(snapshot as StoredVideoProject<unknown>)
    const current = record.entries[record.cursor]
    if (current?.fingerprint === fp) return toState(record as HistoryRecord<unknown>)

    const entries = record.cursor >= 0 ? record.entries.slice(0, record.cursor + 1) : []
    entries.push({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      savedAt: snapshot.savedAt || new Date().toISOString(),
      fingerprint: fp,
      project: snapshot.project,
      outputSize: snapshot.outputSize,
      quality: snapshot.quality,
    })
    if (entries.length > MAX_HISTORY) entries.splice(0, entries.length - MAX_HISTORY)
    const next: HistoryRecord<T> = { projectId, entries, cursor: entries.length - 1 }
    await writeRecord(db, next)
    return toState(next as HistoryRecord<unknown>)
  } finally {
    db.close()
  }
}

export async function getEditingHistoryState(projectId: string) {
  const db = await openDb()
  try {
    return toState(await readRecord(db, projectId))
  } finally {
    db.close()
  }
}

export async function undoEditingHistory<T>(projectId: string) {
  const db = await openDb()
  try {
    const record = await readRecord<T>(db, projectId)
    if (record.cursor <= 0) return { entry: null, state: toState(record as HistoryRecord<unknown>) }
    record.cursor -= 1
    await writeRecord(db, record)
    return { entry: record.entries[record.cursor] || null, state: toState(record as HistoryRecord<unknown>) }
  } finally {
    db.close()
  }
}

export async function redoEditingHistory<T>(projectId: string) {
  const db = await openDb()
  try {
    const record = await readRecord<T>(db, projectId)
    if (record.cursor < 0 || record.cursor >= record.entries.length - 1) return { entry: null, state: toState(record as HistoryRecord<unknown>) }
    record.cursor += 1
    await writeRecord(db, record)
    return { entry: record.entries[record.cursor] || null, state: toState(record as HistoryRecord<unknown>) }
  } finally {
    db.close()
  }
}

export async function clearEditingHistory(projectId: string) {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).delete(projectId)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error || new Error('تعذر مسح سجل التعديلات.'))
    })
  } finally {
    db.close()
  }
}
