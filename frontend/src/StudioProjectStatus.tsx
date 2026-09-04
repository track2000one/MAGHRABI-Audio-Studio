import { useEffect, useState } from 'react'
import { CheckCircle2, Clock3, Database, Film, Music2 } from 'lucide-react'
import { getActiveStudioProjectId, getStudioProject } from './lib/projectHubStore'
import { getStoredVideoProjectInfo, type StoredProjectInfo } from './lib/projectStore'

const emptyInfo: StoredProjectInfo = { exists: false, savedAt: null, videoCount: 0, audioCount: 0, outputSize: null, quality: null }

function savedLabel(savedAt: string | null) {
  if (!savedAt) return 'Not saved yet'
  const date = new Date(savedAt)
  if (Number.isNaN(date.getTime())) return 'Saved'
  return new Intl.DateTimeFormat('ar-SA', { hour: '2-digit', minute: '2-digit' }).format(date)
}

export default function StudioProjectStatus() {
  const [projectId, setProjectId] = useState<string | null>(() => getActiveStudioProjectId())
  const [info, setInfo] = useState<StoredProjectInfo>(emptyInfo)

  const refresh = async () => {
    const id = getActiveStudioProjectId()
    setProjectId(id)
    if (!id) { setInfo(emptyInfo); return }
    try { setInfo(await getStoredVideoProjectInfo(id)) } catch { setInfo(emptyInfo) }
  }

  useEffect(() => {
    refresh()
    const onChange = () => refresh()
    window.addEventListener('maghrabi-active-project-changed', onChange)
    window.addEventListener('maghrabi-project-snapshot-changed', onChange)
    window.addEventListener('maghrabi-project-index-changed', onChange)
    return () => {
      window.removeEventListener('maghrabi-active-project-changed', onChange)
      window.removeEventListener('maghrabi-project-snapshot-changed', onChange)
      window.removeEventListener('maghrabi-project-index-changed', onChange)
    }
  }, [])

  const project = getStudioProject(projectId)
  if (!project) return null

  return (
    <div className="fixed bottom-5 left-1/2 z-[86] hidden -translate-x-1/2 items-center gap-2 rounded-2xl border border-white/10 bg-[#08111f]/94 px-3 py-2 shadow-2xl shadow-black/50 backdrop-blur-xl xl:flex" dir="ltr">
      <span className={`grid h-7 w-7 place-items-center rounded-xl ${info.exists ? 'bg-emerald-300/10 text-emerald-300' : 'bg-amber-300/10 text-amber-300'}`}>
        {info.exists ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Database className="h-3.5 w-3.5" />}
      </span>
      <span className="max-w-[180px] truncate text-[10px] font-black text-slate-200">{project.name}</span>
      <span className="h-4 w-px bg-white/10" />
      <span className="inline-flex items-center gap-1 text-[9px] text-slate-500"><Clock3 className="h-3 w-3" />{savedLabel(info.savedAt)}</span>
      {info.exists && (
        <>
          <span className="h-4 w-px bg-white/10" />
          <span className="inline-flex items-center gap-1 text-[9px] text-slate-500"><Film className="h-3 w-3" />{info.videoCount}</span>
          <span className="inline-flex items-center gap-1 text-[9px] text-slate-500"><Music2 className="h-3 w-3" />{info.audioCount}</span>
          <span className="rounded-lg border border-white/8 px-1.5 py-0.5 text-[8px] font-black text-slate-600">{info.outputSize || '—'} · {info.quality || '—'}</span>
        </>
      )}
    </div>
  )
}
