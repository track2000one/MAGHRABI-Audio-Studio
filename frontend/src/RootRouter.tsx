import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { ShieldCheck, SlidersHorizontal, Video } from 'lucide-react'
import App from './App'
import { getAuthStatus } from './lib/api'

const AudioTools = lazy(() => import('./AudioTools'))
const VideoStudioCreator = lazy(() => import('./VideoStudioCreator'))
const VideoStudio = lazy(() => import('./VideoStudio'))
const VideoStudioPro = lazy(() => import('./VideoStudioPro'))
const VideoStudioV3 = lazy(() => import('./VideoStudioV3'))
const VideoStudioV4 = lazy(() => import('./VideoStudioV4'))
const VideoStudioV5 = lazy(() => import('./VideoStudioV5'))
const VideoStudioV6 = lazy(() => import('./VideoStudioV6'))
const VideoStudioV7 = lazy(() => import('./VideoStudioV7'))
const VideoStudioV8 = lazy(() => import('./VideoStudioV8'))
const VideoStudioV9 = lazy(() => import('./VideoStudioV9'))
const VideoStudioV10 = lazy(() => import('./VideoStudioV10'))
const VideoStudioV11 = lazy(() => import('./VideoStudioV11'))
const VideoStudioV12 = lazy(() => import('./VideoStudioV12'))
const VideoStudioV13 = lazy(() => import('./VideoStudioV13'))
const VideoStudioV14 = lazy(() => import('./VideoStudioV14'))
const VideoStudioV15 = lazy(() => import('./VideoStudioV15'))
const VideoStudioV16 = lazy(() => import('./VideoStudioV16'))
const VideoStudioV17 = lazy(() => import('./VideoStudioV17'))
const VideoStudioV18 = lazy(() => import('./VideoStudioV18'))
const VideoStudioV19 = lazy(() => import('./VideoStudioV19'))
const VideoStudioV20 = lazy(() => import('./VideoStudioV20'))
const VideoStudioV21 = lazy(() => import('./VideoStudioV21'))
const VideoStudioV22 = lazy(() => import('./VideoStudioV22'))
const VideoStudioV23 = lazy(() => import('./VideoStudioV23'))
const VideoStudioV24 = lazy(() => import('./VideoStudioV24'))
const VideoStudioV25 = lazy(() => import('./VideoStudioV25'))
const VideoStudioV26 = lazy(() => import('./VideoStudioV26'))
const VideoStudioV27 = lazy(() => import('./VideoStudioV27'))
const VideoStudioV28 = lazy(() => import('./VideoStudioV28'))
const VideoStudioV29 = lazy(() => import('./VideoStudioV29'))
const VideoStudioV30 = lazy(() => import('./VideoStudioV30'))
const VideoStudioV31 = lazy(() => import('./VideoStudioV31'))
const VideoStudioV32 = lazy(() => import('./VideoStudioV32'))
const VideoStudioV33 = lazy(() => import('./VideoStudioV33'))
const VideoStudioV34 = lazy(() => import('./VideoStudioV34'))
const VideoStudioV40 = lazy(() => import('./VideoStudioV40'))
const ReviewPortalV22 = lazy(() => import('./ReviewPortalV22'))
const EnterprisePortalV23 = lazy(() => import('./EnterprisePortalV23'))
const InviteAcceptV23 = lazy(() => import('./InviteAcceptV23'))
const SecurePortalV24 = lazy(() => import('./SecurePortalV24'))
const InviteAcceptV24 = lazy(() => import('./InviteAcceptV24'))
const ResetPasswordV24 = lazy(() => import('./ResetPasswordV24'))

const loading = (
  <main className="grid min-h-screen place-items-center bg-[#050911] text-slate-100" dir="rtl">
    <div className="rounded-3xl border border-white/10 bg-white/5 px-8 py-6 text-center shadow-2xl shadow-black/40">
      <div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-2 border-cyan-300/20 border-t-cyan-300" />
      <div className="text-sm font-black">جاري تحميل مساحة العمل...</div>
      <div className="mt-1 text-xs text-slate-500">يتم تحميل الوحدة المطلوبة فقط لتحسين الأداء.</div>
    </div>
  </main>
)

function lazyScreen(content: ReactNode) {
  return <Suspense fallback={loading}>{content}</Suspense>
}

export default function RootRouter() {
  const [route, setRoute] = useState(window.location.hash)
  const [authenticated, setAuthenticated] = useState(false)

  useEffect(() => {
    const onHash = () => setRoute(window.location.hash)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    const refresh = () => {
      getAuthStatus()
        .then((status) => setAuthenticated(status.authenticated))
        .catch(() => setAuthenticated(false))
    }
    refresh()
    const timer = window.setInterval(refresh, 2500)
    return () => window.clearInterval(timer)
  }, [])

  if (route.startsWith('#invite24=')) {
    const token = route.slice('#invite24='.length)
    if (token) return lazyScreen(<InviteAcceptV24 token={token} />)
  }
  if (route.startsWith('#reset=')) {
    const token = route.slice('#reset='.length)
    if (token) return lazyScreen(<ResetPasswordV24 token={token} />)
  }
  if (route.startsWith('#invite=')) {
    const token = route.slice('#invite='.length)
    if (token) return lazyScreen(<InviteAcceptV23 token={token} />)
  }
  if (route.startsWith('#review=')) {
    const raw = route.slice('#review='.length)
    const separator = raw.indexOf(':')
    if (separator > 0) {
      const roomId = raw.slice(0, separator)
      const token = raw.slice(separator + 1)
      if (roomId && token) return lazyScreen(<ReviewPortalV22 roomId={roomId} token={token} />)
    }
  }

  if (route === '#secure') return lazyScreen(<SecurePortalV24 />)
  if (route === '#team') return lazyScreen(<EnterprisePortalV23 />)
  if (route === '#tools') return lazyScreen(<AudioTools />)
  if (route === '#video-basic') return lazyScreen(<VideoStudio />)
  if (route === '#video-v2') return lazyScreen(<VideoStudioPro />)
  if (route === '#video-v3') return lazyScreen(<VideoStudioV3 />)
  if (route === '#video-v4') return lazyScreen(<VideoStudioV4 />)
  if (route === '#video-v5') return lazyScreen(<VideoStudioV5 />)
  if (route === '#video-v6') return lazyScreen(<VideoStudioV6 />)
  if (route === '#video-v7') return lazyScreen(<VideoStudioV7 />)
  if (route === '#video-v8') return lazyScreen(<VideoStudioV8 />)
  if (route === '#video-v9') return lazyScreen(<VideoStudioV9 />)
  if (route === '#video-v10') return lazyScreen(<VideoStudioV10 />)
  if (route === '#video-v11') return lazyScreen(<VideoStudioV11 />)
  if (route === '#video-v12') return lazyScreen(<VideoStudioV12 />)
  if (route === '#video-v13') return lazyScreen(<VideoStudioV13 />)
  if (route === '#video-v14') return lazyScreen(<VideoStudioV14 />)
  if (route === '#video-v15') return lazyScreen(<VideoStudioV15 />)
  if (route === '#video-v16') return lazyScreen(<VideoStudioV16 />)
  if (route === '#video-v17') return lazyScreen(<VideoStudioV17 />)
  if (route === '#video-v18') return lazyScreen(<VideoStudioV18 />)
  if (route === '#video-v19') return lazyScreen(<VideoStudioV19 />)
  if (route === '#video-v20') return lazyScreen(<VideoStudioV20 />)
  if (route === '#video-v21') return lazyScreen(<VideoStudioV21 />)
  if (route === '#video-v22') return lazyScreen(<VideoStudioV22 />)
  if (route === '#video-v23') return lazyScreen(<VideoStudioV23 />)
  if (route === '#video-v24') return lazyScreen(<VideoStudioV24 />)
  if (route === '#video-v25') return lazyScreen(<VideoStudioV25 />)
  if (route === '#video-v26') return lazyScreen(<VideoStudioV26 />)
  if (route === '#video-v27') return lazyScreen(<VideoStudioV27 />)
  if (route === '#video-v28') return lazyScreen(<VideoStudioV28 />)
  if (route === '#video-v29') return lazyScreen(<VideoStudioV29 />)
  if (route === '#video-v30') return lazyScreen(<VideoStudioV30 />)
  if (route === '#video-v31') return lazyScreen(<VideoStudioV31 />)
  if (route === '#video-v32') return lazyScreen(<VideoStudioV32 />)
  if (route === '#video-v33') return lazyScreen(<VideoStudioV33 />)
  if (route === '#video-v34') return lazyScreen(<VideoStudioV34 />)
  if (route === '#video-v40' || route === '#readiness') return lazyScreen(<VideoStudioV40 />)
  if (route === '#editor') return lazyScreen(<VideoStudioV12 />)
  if (route === '#video') return lazyScreen(<VideoStudioCreator />)

  return (
    <>
      <App />
      {authenticated && (
        <div className="fixed bottom-5 left-5 z-50 flex flex-col gap-2 sm:flex-row">
          <a href="#video" className="inline-flex items-center gap-2 rounded-2xl border border-cyan-300/20 bg-[#0b1220]/95 px-4 py-3 text-xs font-black text-cyan-100 shadow-2xl shadow-black/40 backdrop-blur-xl transition hover:border-cyan-300/40 hover:bg-[#101a2b]">
            <Video className="h-4 w-4 text-cyan-300" />
            Video Studio Creator Pro
          </a>
          <a href="#tools" className="inline-flex items-center gap-2 rounded-2xl border border-cyan-300/20 bg-[#0b1220]/95 px-4 py-3 text-xs font-black text-cyan-100 shadow-2xl shadow-black/40 backdrop-blur-xl transition hover:border-cyan-300/40 hover:bg-[#101a2b]">
            <SlidersHorizontal className="h-4 w-4 text-cyan-300" />
            أدوات الصوت
          </a>
          <a href="#readiness" className="inline-flex items-center gap-2 rounded-2xl border border-emerald-300/20 bg-[#0b1220]/95 px-4 py-3 text-xs font-black text-emerald-100 shadow-2xl shadow-black/40 backdrop-blur-xl transition hover:border-emerald-300/40 hover:bg-[#101a2b]">
            <ShieldCheck className="h-4 w-4 text-emerald-300" />
            جاهزية الإنتاج
          </a>
        </div>
      )}
    </>
  )
}
