import { useEffect, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import App from './App'
import AudioTools from './AudioTools'
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

  return (
    <>
      <App />
      {authenticated && (
        <a
          href="#tools"
          className="fixed bottom-5 left-5 z-50 inline-flex items-center gap-2 rounded-2xl border border-cyan-300/20 bg-[#0b1220]/95 px-4 py-3 text-xs font-black text-cyan-100 shadow-2xl shadow-black/40 backdrop-blur-xl transition hover:border-cyan-300/40 hover:bg-[#101a2b]"
        >
          <SlidersHorizontal className="h-4 w-4 text-cyan-300" />
          أدوات الصوت
        </a>
      )}
    </>
  )
}
