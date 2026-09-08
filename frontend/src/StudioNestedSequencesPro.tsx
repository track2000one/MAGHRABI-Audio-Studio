import { useEffect, useMemo, useState } from 'react'
import { Boxes, ChevronLeft, Copy, Layers3, RefreshCcw, Save, Trash2, X } from 'lucide-react'
import { getActiveStudioProjectId } from './lib/projectHubStore'
import { loadStoredVideoProject } from './lib/projectStore'
import {
  captureNestedSequence,
  injectActiveNestedSequences,
  loadNestedSequenceSettings,
  rangesOverlap,
  saveNestedSequenceSettings,
  type NestedAudioClip,
  type NestedAudioLane,
  type NestedSequence,
  type NestedSequenceSettings,
  type NestedVideoClip,
  type NestedVideoLane,
  type ParentTimelineSnapshot,
} from './lib/nestedSequenceProjectSettings'

type StoredTimelineShape = ParentTimelineSnapshot & {
  videoBins?: string[]
  audioBins?: string[]
}

type SelectedItem = { kind: 'video'; id: string } | { kind: 'audio'; id: string } | null

const videoLanes: NestedVideoLane[] = ['V3', 'V2', 'V1']
const audioLanes: NestedAudioLane[] = ['A1', 'A2', 'A3']
const laneOrder = [...videoLanes, ...audioLanes]
const filters = ['none', 'warm', 'cool', 'cinematic', 'vivid', 'mono']

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function videoDuration(clip: NestedVideoClip) {
  if (clip.freezeFrame) return clamp(Number(clip.freezeDuration ?? 2), .1, 12)
  return Math.max(.02, (clip.end - clip.start) / clamp(clip.speed, .25, 4))
}

function audioDuration(clip: NestedAudioClip) {
  return Math.max(.02, clip.sourceEnd - clip.sourceStart)
}

function fmt(seconds: number) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const mins = Math.floor(safe / 60)
  return `${String(mins).padStart(2, '0')}:${(safe - mins * 60).toFixed(2).padStart(5, '0')}`
}

async function waitForSnapshot(projectId: string | null) {
  const selector = '.maghrabi-studio-pro button'
  const saveButton = Array.from(document.querySelectorAll<HTMLButtonElement>(selector))
    .find((button) => button.textContent?.trim().startsWith('حفظ'))

  if (saveButton) {
    await new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        window.removeEventListener('maghrabi-project-snapshot-changed', onChanged as EventListener)
        resolve()
      }
      const onChanged = (event: Event) => {
        const detail = (event as CustomEvent<{ projectId?: string | null }>).detail
        if (!projectId || !detail?.projectId || detail.projectId === projectId) done()
      }
      window.addEventListener('maghrabi-project-snapshot-changed', onChanged as EventListener)
      saveButton.click()
      window.setTimeout(done, 1400)
    })
  }

  return loadStoredVideoProject<StoredTimelineShape>(projectId)
}

function defaultCaptureRange(project: StoredTimelineShape) {
  const rangeIn = Number(project.rangeIn)
  const rangeOut = Number(project.rangeOut)
  if (Number.isFinite(rangeIn) && Number.isFinite(rangeOut) && rangeOut > rangeIn + .05) {
    return [rangeIn, rangeOut] as const
  }
  const v1 = (project.clips || [])
    .filter((clip) => String(clip.lane || 'V1') === 'V1')
    .sort((a, b) => Number(a.startAt || 0) - Number(b.startAt || 0))
  const first = v1[0]
  if (!first) return [0, 5] as const
  const start = Math.max(0, Number(first.startAt || 0))
  const source = Math.max(.02, Number(first.end || 0) - Number(first.start || 0))
  const duration = first.freezeFrame ? clamp(Number(first.freezeDuration || 2), .1, 12) : source / clamp(Number(first.speed || 1), .25, 4)
  return [start, start + duration] as const
}

function Field({ label, value, min, max, step = .01, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void }) {
  return <label className="block rounded-xl border border-white/8 bg-black/20 p-2.5">
    <span className="mb-1 block text-[8px] font-black tracking-widest text-slate-500">{label}</span>
    <input type="number" value={Number.isFinite(value) ? value : 0} min={min} max={max} step={step} onChange={(event) => onChange(clamp(Number(event.target.value), min, max))} className="w-full bg-transparent text-[11px] font-bold text-slate-200 outline-none" />
  </label>
}

export default function StudioNestedSequencesPro() {
  const [projectId, setProjectId] = useState<string | null>(() => getActiveStudioProjectId())
  const [settings, setSettings] = useState<NestedSequenceSettings>(() => loadNestedSequenceSettings(getActiveStudioProjectId()))
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [selectedItem, setSelectedItem] = useState<SelectedItem>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const active = useMemo(() => settings.sequences.find((sequence) => sequence.id === activeId) || null, [settings, activeId])
  const selectedVideo = active && selectedItem?.kind === 'video' ? active.videoClips.find((clip) => clip.id === selectedItem.id) || null : null
  const selectedAudio = active && selectedItem?.kind === 'audio' ? active.audioClips.find((clip) => clip.id === selectedItem.id) || null : null

  const commit = (next: NestedSequenceSettings) => {
    setSettings(next)
    saveNestedSequenceSettings(projectId, next)
  }

  const patchSequence = (id: string, patch: Partial<NestedSequence>) => {
    commit({
      sequences: settings.sequences.map((sequence) => sequence.id === id ? { ...sequence, ...patch, updatedAt: new Date().toISOString() } : sequence),
    })
  }

  const patchVideo = (id: string, patch: Partial<NestedVideoClip>) => {
    if (!active) return
    patchSequence(active.id, { videoClips: active.videoClips.map((clip) => clip.id === id ? { ...clip, ...patch } : clip) })
  }

  const patchAudio = (id: string, patch: Partial<NestedAudioClip>) => {
    if (!active) return
    patchSequence(active.id, { audioClips: active.audioClips.map((clip) => clip.id === id ? { ...clip, ...patch } : clip) })
  }

  useEffect(() => {
    const refresh = () => {
      const nextProject = getActiveStudioProjectId()
      setProjectId(nextProject)
      setSettings(loadNestedSequenceSettings(nextProject))
      setActiveId(null)
      setSelectedItem(null)
    }
    window.addEventListener('maghrabi-active-project-changed', refresh)
    return () => window.removeEventListener('maghrabi-active-project-changed', refresh)
  }, [])

  useEffect(() => {
    const refresh = () => setSettings(loadNestedSequenceSettings(getActiveStudioProjectId()))
    window.addEventListener('maghrabi-nested-sequences-changed', refresh)
    return () => window.removeEventListener('maghrabi-nested-sequences-changed', refresh)
  }, [])

  useEffect(() => {
    const previous = window.fetch.bind(window)
    const wrapped: typeof window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/api/video/v12/queue') && init?.body instanceof FormData) {
        const raw = init.body.get('manifest')
        if (typeof raw === 'string') {
          try {
            const parsed = JSON.parse(raw) as Record<string, unknown>
            init.body.set('manifest', JSON.stringify(injectActiveNestedSequences(parsed)))
          } catch {
            // Let V12 return the canonical manifest validation error.
          }
        }
      }
      return previous(input, init)
    }
    window.fetch = wrapped
    return () => { if (window.fetch === wrapped) window.fetch = previous }
  }, [])

  const createFromParent = async () => {
    if (busy) return
    setBusy(true); setError(null); setMessage(null)
    try {
      const snapshot = await waitForSnapshot(projectId)
      if (!snapshot) throw new Error('احفظ المشروع مرة واحدة قبل إنشاء Compound Sequence.')
      const [start, end] = defaultCaptureRange(snapshot.project)
      const sequence = captureNestedSequence(snapshot.project, start, end, `Compound ${settings.sequences.length + 1}`)
      if (settings.sequences.some((item) => rangesOverlap(item, sequence))) throw new Error('يتداخل هذا النطاق مع Compound Sequence موجود. عدّل IN/OUT أو موضع الـCompound أولًا.')
      const next = { sequences: [...settings.sequences, sequence].slice(0, 12) }
      commit(next)
      setActiveId(sequence.id)
      setSelectedItem(sequence.videoClips[0] ? { kind: 'video', id: sequence.videoClips[0].id } : null)
      setOpen(true)
      setMessage(`تم التقاط ${sequence.videoClips.length} Video Clips و${sequence.audioClips.length} Audio Clips من Parent Timeline.`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'تعذر إنشاء Compound Sequence.')
    } finally { setBusy(false) }
  }

  const resyncActive = async () => {
    if (!active || busy) return
    setBusy(true); setError(null); setMessage(null)
    try {
      const snapshot = await waitForSnapshot(projectId)
      if (!snapshot) throw new Error('تعذر قراءة Parent Snapshot.')
      const captured = captureNestedSequence(snapshot.project, active.parentStartAt, active.parentStartAt + active.duration, active.name)
      const replacement: NestedSequence = { ...captured, id: active.id, name: active.name, enabled: active.enabled, createdAt: active.createdAt, updatedAt: new Date().toISOString() }
      const others = settings.sequences.filter((item) => item.id !== active.id)
      if (others.some((item) => rangesOverlap(item, replacement))) throw new Error('النطاق المحدث يتداخل مع Compound آخر.')
      commit({ sequences: settings.sequences.map((item) => item.id === active.id ? replacement : item) })
      setSelectedItem(replacement.videoClips[0] ? { kind: 'video', id: replacement.videoClips[0].id } : null)
      setMessage('تمت مزامنة Nested Timeline من Parent Timeline الحالي.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'تعذر تحديث الـNested Timeline.')
    } finally { setBusy(false) }
  }

  const duplicateActive = () => {
    if (!active) return
    const clone: NestedSequence = {
      ...active,
      id: `nested-sequence-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: `${active.name} Copy`.slice(0, 80),
      parentStartAt: active.parentStartAt + active.duration + .1,
      videoClips: active.videoClips.map((clip) => ({ ...clip, id: `${clip.id}-copy-${Math.random().toString(36).slice(2, 5)}` })),
      audioClips: active.audioClips.map((clip) => ({ ...clip, id: `${clip.id}-copy-${Math.random().toString(36).slice(2, 5)}` })),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    if (settings.sequences.some((item) => rangesOverlap(item, clone))) {
      setError('لا توجد مساحة زمنية خالية مباشرة بعد الـCompound لعمل Duplicate. عدّل Parent Start أولًا.')
      return
    }
    commit({ sequences: [...settings.sequences, clone].slice(0, 12) })
    setActiveId(clone.id); setSelectedItem(null)
  }

  const removeActive = () => {
    if (!active) return
    commit({ sequences: settings.sequences.filter((item) => item.id !== active.id) })
    setActiveId(null); setSelectedItem(null)
    setMessage('تم Unpack للـCompound: Parent Timeline سيُرندر بمقاطعه الأصلية مجددًا.')
  }

  const timelineScale = active ? Math.max(900, Math.min(1800, active.duration * 110)) : 900

  return <>
    <button onClick={() => setOpen(true)} className="fixed left-4 top-[154px] z-[86] flex items-center gap-2 rounded-2xl border border-fuchsia-300/25 bg-[#100817]/95 px-3 py-2.5 text-[9px] font-black tracking-[.16em] text-fuchsia-100 shadow-2xl shadow-black/50 backdrop-blur-xl transition hover:border-fuchsia-300/50" title="Compound Clips / Nested Sequences 2.0">
      <Boxes className="h-4 w-4 text-fuchsia-300" /> NESTED
      {settings.sequences.length > 0 && <span className="rounded-full bg-fuchsia-300 px-1.5 py-0.5 text-[8px] text-slate-950">{settings.sequences.length}</span>}
    </button>

    {open && <div className="fixed inset-0 z-[140] overflow-auto bg-[#02040a]/96 p-3 backdrop-blur-2xl md:p-6" dir="rtl">
      <div className="mx-auto min-h-[82vh] max-w-[1500px] overflow-hidden rounded-[30px] border border-white/10 bg-[#070b13] shadow-2xl shadow-black/80">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-[#0a0f1a] px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-2xl bg-fuchsia-300/10 text-fuchsia-300"><Boxes className="h-5 w-5" /></span>
            <div><h2 className="text-base font-black text-white">Compound Clips / Nested Sequences 2.0</h2><p className="mt-1 text-[9px] text-slate-500">Parent Timeline → Nested Timeline → Intermediate Render → Parent Finishing Pipeline</p></div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={createFromParent} disabled={busy} className="rounded-xl bg-fuchsia-300 px-3 py-2 text-[9px] font-black text-slate-950 disabled:opacity-40"><Layers3 className="ml-1 inline h-3.5 w-3.5" />CREATE FROM IN/OUT</button>
            <button onClick={() => setOpen(false)} className="grid h-9 w-9 place-items-center rounded-xl border border-white/10 text-slate-400"><X className="h-4 w-4" /></button>
          </div>
        </header>

        {(error || message) && <div className={`mx-5 mt-4 rounded-2xl border px-4 py-3 text-[10px] font-bold ${error ? 'border-rose-300/20 bg-rose-300/5 text-rose-200' : 'border-emerald-300/20 bg-emerald-300/5 text-emerald-200'}`}>{error || message}</div>}

        <div className="grid min-h-[720px] lg:grid-cols-[260px_minmax(0,1fr)_300px]">
          <aside className="border-l border-white/8 bg-[#080d16] p-4">
            <div className="flex items-center justify-between"><span className="text-[9px] font-black tracking-[.18em] text-slate-500">SEQUENCES</span><span className="text-[8px] text-slate-600">{settings.sequences.length}/12</span></div>
            <div className="mt-3 space-y-2">
              {settings.sequences.map((sequence) => <button key={sequence.id} onClick={() => { setActiveId(sequence.id); setSelectedItem(null) }} className={`w-full rounded-2xl border p-3 text-right transition ${sequence.id === activeId ? 'border-fuchsia-300/35 bg-fuchsia-300/[.07]' : 'border-white/7 bg-white/[.02] hover:border-white/15'}`}>
                <div className="flex items-center justify-between"><span className={`h-2 w-2 rounded-full ${sequence.enabled ? 'bg-emerald-300' : 'bg-slate-700'}`} /><span className="truncate text-[10px] font-black text-slate-200">{sequence.name}</span></div>
                <div className="mt-2 flex justify-between text-[8px] text-slate-600"><span>{sequence.videoClips.length}V · {sequence.audioClips.length}A</span><span>{fmt(sequence.parentStartAt)} → {fmt(sequence.parentStartAt + sequence.duration)}</span></div>
              </button>)}
              {!settings.sequences.length && <div className="rounded-2xl border border-dashed border-white/10 p-5 text-center text-[9px] leading-5 text-slate-600">ضع IN/OUT على الـParent Timeline ثم أنشئ Compound. إذا لم يوجد IN/OUT سيتم التقاط أول V1 Clip.</div>}
            </div>
          </aside>

          <section className="min-w-0 p-4">
            {active ? <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-[10px] font-black"><span className="text-slate-600">PARENT</span><ChevronLeft className="h-3 w-3 text-slate-700" /><span className="text-fuchsia-200">{active.name}</span></div>
                <div className="flex gap-2">
                  <button onClick={resyncActive} disabled={busy} className="rounded-xl border border-cyan-300/15 px-3 py-2 text-[8px] font-black text-cyan-200 disabled:opacity-40"><RefreshCcw className="ml-1 inline h-3 w-3" />SYNC PARENT</button>
                  <button onClick={duplicateActive} className="rounded-xl border border-white/10 px-3 py-2 text-[8px] font-black text-slate-300"><Copy className="ml-1 inline h-3 w-3" />DUPLICATE</button>
                  <button onClick={removeActive} className="rounded-xl border border-rose-300/15 px-3 py-2 text-[8px] font-black text-rose-200"><Trash2 className="ml-1 inline h-3 w-3" />UNPACK</button>
                </div>
              </div>

              <div className="mt-4 overflow-x-auto rounded-3xl border border-white/8 bg-[#050912] p-3">
                <div style={{ width: timelineScale }}>
                  <div className="mb-2 flex h-7 items-end border-b border-white/8 text-[7px] text-slate-700">
                    {Array.from({ length: 11 }).map((_, index) => <span key={index} className="relative flex-1 border-r border-white/[.04]"><span className="absolute bottom-1 right-1">{(active.duration * index / 10).toFixed(1)}s</span></span>)}
                  </div>
                  {laneOrder.map((lane) => {
                    const isVideo = lane.startsWith('V')
                    const items = isVideo ? active.videoClips.filter((clip) => clip.lane === lane) : active.audioClips.filter((clip) => clip.lane === lane)
                    return <div key={lane} className="relative mb-1.5 flex h-14 border-b border-white/[.04] bg-white/[.015]">
                      <div className="absolute right-0 top-0 z-10 grid h-full w-10 place-items-center border-l border-white/8 bg-[#0b101a] text-[8px] font-black text-slate-500">{lane}</div>
                      <div className="relative mr-10 h-full flex-1">
                        {items.map((item) => {
                          const duration = isVideo ? videoDuration(item as NestedVideoClip) : audioDuration(item as NestedAudioClip)
                          const startAt = item.startAt
                          const selected = selectedItem?.id === item.id
                          return <button key={item.id} onClick={() => setSelectedItem({ kind: isVideo ? 'video' : 'audio', id: item.id })} style={{ right: `${(startAt / active.duration) * 100}%`, width: `${Math.max(1.2, (duration / active.duration) * 100)}%` }} className={`absolute top-1.5 h-11 overflow-hidden rounded-lg border px-2 text-right transition ${selected ? 'border-fuchsia-200 bg-fuchsia-300/20 text-white' : isVideo ? 'border-violet-300/20 bg-violet-300/10 text-violet-100' : 'border-cyan-300/20 bg-cyan-300/10 text-cyan-100'}`}>
                            <span className="block truncate text-[8px] font-black">{isVideo ? `MEDIA ${(item as NestedVideoClip).fileIndex + 1}` : (item as NestedAudioClip).name}</span>
                            <span className="mt-1 block truncate text-[7px] opacity-50">{fmt(startAt)} · {duration.toFixed(2)}s</span>
                          </button>
                        })}
                      </div>
                    </div>
                  })}
                </div>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-4">
                <Field label="PARENT START" value={active.parentStartAt} min={0} max={86400} step={.1} onChange={(value) => {
                  const candidate = { ...active, parentStartAt: value }
                  if (settings.sequences.some((item) => item.id !== active.id && rangesOverlap(item, candidate))) { setError('هذا الموضع يتداخل مع Compound آخر.'); return }
                  setError(null); patchSequence(active.id, { parentStartAt: value })
                }} />
                <Field label="DURATION" value={active.duration} min={.1} max={900} step={.1} onChange={(value) => patchSequence(active.id, { duration: value })} />
                <label className="rounded-xl border border-white/8 bg-black/20 p-2.5"><span className="mb-1 block text-[8px] font-black tracking-widest text-slate-500">ENABLED</span><button onClick={() => patchSequence(active.id, { enabled: !active.enabled })} className={`w-full rounded-lg px-2 py-1.5 text-[9px] font-black ${active.enabled ? 'bg-emerald-300 text-slate-950' : 'bg-slate-800 text-slate-400'}`}>{active.enabled ? 'ACTIVE' : 'BYPASSED'}</button></label>
                <label className="rounded-xl border border-white/8 bg-black/20 p-2.5"><span className="mb-1 block text-[8px] font-black tracking-widest text-slate-500">NAME</span><input value={active.name} onChange={(event) => patchSequence(active.id, { name: event.target.value.slice(0, 80) })} className="w-full bg-transparent text-[10px] font-bold outline-none" /></label>
              </div>
            </> : <div className="grid min-h-[620px] place-items-center text-center"><div><Boxes className="mx-auto h-10 w-10 text-fuchsia-300/20" /><p className="mt-4 text-sm font-black text-slate-400">اختر Nested Sequence أو أنشئ واحدة جديدة</p><p className="mt-2 max-w-md text-[10px] leading-6 text-slate-600">الـCompound غير هدمي: المقاطع الأصلية تبقى في Parent Timeline، بينما Render Queue يستبدل النطاق تلقائيًا بالـNested Render.</p></div></div>}
          </section>

          <aside className="border-r border-white/8 bg-[#080d16] p-4">
            <div className="flex items-center justify-between"><span className="text-[9px] font-black tracking-[.18em] text-slate-500">NESTED INSPECTOR</span><Save className="h-3.5 w-3.5 text-emerald-300/50" /></div>
            {selectedVideo && active && <div className="mt-4 space-y-3">
              <div className="rounded-2xl border border-violet-300/15 bg-violet-300/5 p-3"><p className="text-[10px] font-black text-violet-200">VIDEO · MEDIA {selectedVideo.fileIndex + 1}</p><p className="mt-1 text-[8px] text-slate-600">{fmt(selectedVideo.startAt)} · {videoDuration(selectedVideo).toFixed(2)}s</p></div>
              <label className="block text-[8px] font-black text-slate-500">LANE<select value={selectedVideo.lane} onChange={(event) => patchVideo(selectedVideo.id, { lane: event.target.value as NestedVideoLane })} className="mt-1 w-full rounded-xl border border-white/8 bg-[#0b111c] p-2 text-[10px] text-slate-200">{videoLanes.map((lane) => <option key={lane}>{lane}</option>)}</select></label>
              <Field label="LOCAL START" value={selectedVideo.startAt} min={0} max={active.duration} step={.01} onChange={(value) => patchVideo(selectedVideo.id, { startAt: value })} />
              <Field label="SOURCE IN" value={selectedVideo.start} min={0} max={Math.max(selectedVideo.end - .02, selectedVideo.start)} step={.01} onChange={(value) => patchVideo(selectedVideo.id, { start: value })} />
              <Field label="SOURCE OUT" value={selectedVideo.end} min={selectedVideo.start + .02} max={86400} step={.01} onChange={(value) => patchVideo(selectedVideo.id, { end: value })} />
              <Field label="SPEED" value={selectedVideo.speed} min={.25} max={4} step={.05} onChange={(value) => patchVideo(selectedVideo.id, { speed: value })} />
              <Field label="VOLUME" value={selectedVideo.volume} min={0} max={2} step={.05} onChange={(value) => patchVideo(selectedVideo.id, { volume: value })} />
              <label className="block text-[8px] font-black text-slate-500">LOOK<select value={String(selectedVideo.filter || 'none')} onChange={(event) => patchVideo(selectedVideo.id, { filter: event.target.value })} className="mt-1 w-full rounded-xl border border-white/8 bg-[#0b111c] p-2 text-[10px] text-slate-200">{filters.map((filter) => <option key={filter} value={filter}>{filter.toUpperCase()}</option>)}</select></label>
              <button onClick={() => { patchSequence(active.id, { videoClips: active.videoClips.filter((clip) => clip.id !== selectedVideo.id) }); setSelectedItem(null) }} className="w-full rounded-xl border border-rose-300/15 py-2 text-[8px] font-black text-rose-200">REMOVE FROM NESTED</button>
            </div>}

            {selectedAudio && active && <div className="mt-4 space-y-3">
              <div className="rounded-2xl border border-cyan-300/15 bg-cyan-300/5 p-3"><p className="truncate text-[10px] font-black text-cyan-200">AUDIO · {selectedAudio.name}</p><p className="mt-1 text-[8px] text-slate-600">{fmt(selectedAudio.startAt)} · {audioDuration(selectedAudio).toFixed(2)}s</p></div>
              <label className="block text-[8px] font-black text-slate-500">LANE<select value={selectedAudio.lane} onChange={(event) => patchAudio(selectedAudio.id, { lane: event.target.value as NestedAudioLane })} className="mt-1 w-full rounded-xl border border-white/8 bg-[#0b111c] p-2 text-[10px] text-slate-200">{audioLanes.map((lane) => <option key={lane}>{lane}</option>)}</select></label>
              <Field label="LOCAL START" value={selectedAudio.startAt} min={0} max={active.duration} step={.01} onChange={(value) => patchAudio(selectedAudio.id, { startAt: value })} />
              <Field label="SOURCE IN" value={selectedAudio.sourceStart} min={0} max={Math.max(selectedAudio.sourceEnd - .02, selectedAudio.sourceStart)} step={.01} onChange={(value) => patchAudio(selectedAudio.id, { sourceStart: value })} />
              <Field label="SOURCE OUT" value={selectedAudio.sourceEnd} min={selectedAudio.sourceStart + .02} max={86400} step={.01} onChange={(value) => patchAudio(selectedAudio.id, { sourceEnd: value })} />
              <Field label="VOLUME" value={selectedAudio.volume} min={0} max={2} step={.05} onChange={(value) => patchAudio(selectedAudio.id, { volume: value })} />
              <Field label="FADE IN" value={Number(selectedAudio.fadeIn || 0)} min={0} max={10} step={.05} onChange={(value) => patchAudio(selectedAudio.id, { fadeIn: value })} />
              <Field label="FADE OUT" value={Number(selectedAudio.fadeOut || 0)} min={0} max={10} step={.05} onChange={(value) => patchAudio(selectedAudio.id, { fadeOut: value })} />
              <button onClick={() => { patchSequence(active.id, { audioClips: active.audioClips.filter((clip) => clip.id !== selectedAudio.id) }); setSelectedItem(null) }} className="w-full rounded-xl border border-rose-300/15 py-2 text-[8px] font-black text-rose-200">REMOVE FROM NESTED</button>
            </div>}

            {!selectedVideo && !selectedAudio && <div className="mt-4 rounded-2xl border border-dashed border-white/10 p-4 text-[9px] leading-5 text-slate-600">اختر Clip داخل الـNested Timeline لتعديل Lane / Trim / Speed / Volume / Look. التعديلات تحفظ مباشرة للمشروع النشط.</div>}

            <div className="mt-5 rounded-2xl border border-emerald-300/10 bg-emerald-300/[.025] p-3 text-[8px] leading-5 text-slate-600"><span className="font-black text-emerald-300">RENDER CONTRACT</span><br />Nested intermediate بلا Master LUT، ثم يعود إلى Parent Pipeline ليأخذ Masks/Compositing/LUT/Grade/Text مرة واحدة فقط.</div>
          </aside>
        </div>
      </div>
    </div>}
  </>
}
