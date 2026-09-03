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
  if (route === '#video') return <VideoStudioV15 />

  return (
    <>
      <App />
      {authenticated && (
        <div className="fixed bottom-5 left-5 z-50 flex flex-col gap-2 sm:flex-row">
          <a
            href="#video"
            className="inline-flex items-center gap-2 rounded-2xl border border-fuchsia-300/20 bg-[#0b1220]/95 px-4 py-3 text-xs font-black text-fuchsia-100 shadow-2xl shadow-black/40 backdrop-blur-xl transition hover:border-fuchsia-300/40 hover:bg-[#101a2b]"
          >
            <Video className="h-4 w-4 text-fuchsia-300" />
            Video Studio Creator V15
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
