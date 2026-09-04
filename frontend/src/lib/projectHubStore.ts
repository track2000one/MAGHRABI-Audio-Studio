export type StudioProjectTemplate = 'blank' | 'youtube' | 'reel' | 'podcast' | 'cinematic'

export type StudioProjectMeta = {
  id: string
  name: string
  template: StudioProjectTemplate
  createdAt: string
  updatedAt: string
  lastOpenedAt: string
  archived: boolean
}

const INDEX_KEY = 'maghrabi-studio-project-index-v1'
const ACTIVE_KEY = 'maghrabi-studio-active-project-v1'

function now() { return new Date().toISOString() }
function uid() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function readIndex(): StudioProjectMeta[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is StudioProjectMeta => Boolean(item && typeof item.id === 'string' && typeof item.name === 'string'))
  } catch {
    return []
  }
}

function writeIndex(projects: StudioProjectMeta[]) {
  localStorage.setItem(INDEX_KEY, JSON.stringify(projects))
  window.dispatchEvent(new CustomEvent('maghrabi-project-index-changed'))
}

export function listStudioProjects(includeArchived = false) {
  return readIndex()
    .filter((project) => includeArchived || !project.archived)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}

export function getActiveStudioProjectId() {
  return localStorage.getItem(ACTIVE_KEY)
}

export function setActiveStudioProjectId(id: string | null) {
  if (id) localStorage.setItem(ACTIVE_KEY, id)
  else localStorage.removeItem(ACTIVE_KEY)
  window.dispatchEvent(new CustomEvent('maghrabi-active-project-changed', { detail: id }))
}

export function createStudioProject(name: string, template: StudioProjectTemplate = 'blank') {
  const timestamp = now()
  const project: StudioProjectMeta = {
    id: uid(),
    name: name.trim() || 'Untitled Project',
    template,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastOpenedAt: timestamp,
    archived: false,
  }
  writeIndex([project, ...readIndex()])
  setActiveStudioProjectId(project.id)
  return project
}

export function touchStudioProject(id: string, changes: Partial<Pick<StudioProjectMeta, 'name' | 'template' | 'archived'>> = {}) {
  const timestamp = now()
  const projects = readIndex()
  const next = projects.map((project) => project.id === id ? { ...project, ...changes, updatedAt: timestamp, lastOpenedAt: timestamp } : project)
  writeIndex(next)
  return next.find((project) => project.id === id) || null
}

export function renameStudioProject(id: string, name: string) {
  return touchStudioProject(id, { name: name.trim() || 'Untitled Project' })
}

export function archiveStudioProject(id: string, archived = true) {
  const projects = readIndex()
  const timestamp = now()
  writeIndex(projects.map((project) => project.id === id ? { ...project, archived, updatedAt: timestamp } : project))
  if (archived && getActiveStudioProjectId() === id) setActiveStudioProjectId(null)
}

export function deleteStudioProjectMeta(id: string) {
  writeIndex(readIndex().filter((project) => project.id !== id))
  if (getActiveStudioProjectId() === id) setActiveStudioProjectId(null)
}

export function getStudioProject(id: string | null) {
  if (!id) return null
  return readIndex().find((project) => project.id === id) || null
}

export function templateLabel(template: StudioProjectTemplate) {
  if (template === 'youtube') return 'YouTube 16:9'
  if (template === 'reel') return 'Reel 9:16'
  if (template === 'podcast') return 'Podcast'
  if (template === 'cinematic') return 'Cinematic'
  return 'Blank'
}
