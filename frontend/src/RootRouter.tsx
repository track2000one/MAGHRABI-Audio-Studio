import { useEffect, useState } from 'react'
import { SlidersHorizontal, Video } from 'lucide-react'
import App from './App'
import AudioTools from './AudioTools'
import VideoStudio from './VideoStudio'
import VideoStudioPro from './VideoStudioPro'
import VideoStudioV3 from './VideoStudioV3'
import VideoStudioV4 from './VideoStudioV4'
import VideoStudioV5 from './VideoStudioV5'
import VideoStudioV6 from './VideoStudioV6'
import VideoStudioV7 from './VideoStudioV7'
import VideoStudioV8 from './VideoStudioV8'
import VideoStudioV9 from './VideoStudioV9'
import VideoStudioV10 from './VideoStudioV10'
import VideoStudioV11 from './VideoStudioV11'
import VideoStudioV12 from './VideoStudioV12'
import VideoStudioV13 from './VideoStudioV13'
import VideoStudioV14 from './VideoStudioV14'
import VideoStudioV15 from './VideoStudioV15'
import VideoStudioV16 from './VideoStudioV16'
import VideoStudioV17 from './VideoStudioV17'
import VideoStudioV18 from './VideoStudioV18'
import VideoStudioV19 from './VideoStudioV19'
import VideoStudioV20 from './VideoStudioV20'
import VideoStudioV21 from './VideoStudioV21'
import VideoStudioV22 from './VideoStudioV22'
import VideoStudioV23 from './VideoStudioV23'
import VideoStudioV24 from './VideoStudioV24'
import VideoStudioV25 from './VideoStudioV25'
import VideoStudioV26 from './VideoStudioV26'
import VideoStudioV27 from './VideoStudioV27'
import VideoStudioV28 from './VideoStudioV28'
import VideoStudioV29 from './VideoStudioV29'
import ReviewPortalV22 from './ReviewPortalV22'
import EnterprisePortalV23 from './EnterprisePortalV23'
import InviteAcceptV23 from './InviteAcceptV23'
import SecurePortalV24 from './SecurePortalV24'
import InviteAcceptV24 from './InviteAcceptV24'
import ResetPasswordV24 from './ResetPasswordV24'
import { getAuthStatus } from './lib/api'

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
    if (token) return <InviteAcceptV24 token={token} />
  }

  if (route.startsWith('#reset=')) {
    const token = route.slice('#reset='.length)
    if (token) return <ResetPasswordV24 token={token} />
  }

  if (route.startsWith('#invite=')) {
    const token = route.slice('#invite='.length)
    if (token) return <InviteAcceptV23 token={token} />
  }

  if (route.startsWith('#review=')) {
    const raw = route.slice('#review='.length)
    const separator = raw.indexOf(':')
    if (separator > 0) {
      const roomId = raw.slice(0, separator)
      const token = raw.slice(separator + 1)
      if (roomId && token) return <ReviewPortalV22 roomId={roomId} token={token} />
    }
  }

  if (route === '#secure') return <SecurePortalV24 />
  if (route === '#team') return <EnterprisePortalV23 />
  if (route === '#tools') return <AudioTools />
  if (route === '#video-basic') return <VideoStudio />
  if (route === '#video-v2') return <VideoStudioPro />
  if (route === '#video-v3') return <VideoStudioV3 />
  if (route === '#video-v4') return <VideoStudioV4 />
  if (route === '#video-v5') return <VideoStudioV5 />
  if (route === '#video-v6') return <VideoStudioV6 />
  if (route === '#video-v7') return <VideoStudioV7 />
  if (route === '#video-v8') return <VideoStudioV8 />
  if (route === '#video-v9') return <VideoStudioV9 />
  if (route === '#video-v10') return <VideoStudioV10 />
  if (route === '#video-v11') return <VideoStudioV11 />
  if (route === '#video-v12') return <VideoStudioV12 />
  if (route === '#video-v13') return <VideoStudioV13 />
  if (route === '#video-v14') return <VideoStudioV14 />
  if (route === '#video-v15') return <VideoStudioV15 />
  if (route === '#video-v16') return <VideoStudioV16 />
  if (route === '#video-v17') return <VideoStudioV17 />
  if (route === '#video-v18') return <VideoStudioV18 />
  if (route === '#video-v19') return <VideoStudioV19 />
  if (route === '#video-v20') return <VideoStudioV20 />
  if (route === '#video-v21') return <VideoStudioV21 />
  if (route === '#video-v22') return <VideoStudioV22 />
  if (route === '#video-v23') return <VideoStudioV23 />
  if (route === '#video-v24') return <VideoStudioV24 />
  if (route === '#video-v25') return <VideoStudioV25 />
  if (route === '#video-v26') return <VideoStudioV26 />
  if (route === '#video-v27') return <VideoStudioV27 />
  if (route === '#video-v28') return <VideoStudioV28 />
  if (route === '#video') return <VideoStudioV29 />

  return (
    <>
      <App />
      {authenticated && (
        <div className="fixed bottom-5 left-5 z-50 flex flex-col gap-2 sm:flex-row">
          <a
            href="#video"
            className="inline-flex items-center gap-2 rounded-2xl border border-cyan-300/20 bg-[#0b1220]/95 px-4 py-3 text-xs font-black text-cyan-100 shadow-2xl shadow-black/40 backdrop-blur-xl transition hover:border-cyan-300/40 hover:bg-[#101a2b]"
          >
            <Video className="h-4 w-4 text-cyan-300" />
            Video Studio Creator V29
          </a>
          <a
            href="#tools"
            className="inline-flex items-center gap-2 rounded-2xl border border-cyan-300/20 bg-[#0b1220]/95 px-4 py-3 text-xs font-black text-cyan-100 shadow-2xl shadow-black/40 backdrop-blur-xl transition hover:border-cyan-300/40 hover:bg-[#101a2b]"
          >
            <SlidersHorizontal className="h-4 w-4 text-cyan-300" />
            أدوات الصوت
          </a>
        </div>
      )}
    </>
  )
}
