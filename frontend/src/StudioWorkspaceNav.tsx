import {
  Captions,
  Film,
  Grid2X2,
  Images,
  Layers3,
  Music2,
  Send,
  Sparkles,
  WandSparkles,
} from 'lucide-react'
import type { CreativeTab } from './lib/creativeProjectSettings'

type LinkTab = { label: string; href: string; icon: typeof Film; creative?: never }
type CreativeNavTab = { label: string; icon: typeof Film; creative: CreativeTab; href?: never }

type NavTab = LinkTab | CreativeNavTab

const tabs: NavTab[] = [
  { label: 'MEDIA', href: '#video', icon: Film },
  { label: 'AUDIO', href: '#audio', icon: Music2 },
  { label: 'TITLES', creative: 'titles', icon: Captions },
  { label: 'TRANSITIONS', creative: 'transitions', icon: Layers3 },
  { label: 'EFFECTS', creative: 'looks', icon: Sparkles },
  { label: 'ELEMENTS', href: '#video-v5', icon: Images },
  { label: 'SPLIT SCREEN', href: '#video-v5', icon: Grid2X2 },
]

function openCreative(tab: CreativeTab) {
  window.dispatchEvent(new CustomEvent('maghrabi-open-creative-suite', { detail: { tab } }))
}

export default function StudioWorkspaceNav() {
  return (
    <div className="maghrabi-creator-nav" dir="ltr">
      <div className="maghrabi-creator-brand">
        <span className="maghrabi-creator-brand-mark"><WandSparkles size={15} /></span>
        <span>
          <strong>MAGHRABI STUDIO</strong>
          <small>Creator Workspace</small>
        </span>
      </div>

      <nav className="maghrabi-creator-tabs" aria-label="Creator workspace">
        {tabs.map((tab) => {
          const Icon = tab.icon
          if ('creative' in tab && tab.creative) {
            return (
              <button key={tab.label} type="button" className="maghrabi-creator-tab" onClick={() => openCreative(tab.creative)}>
                <Icon size={16} />
                <span>{tab.label}</span>
              </button>
            )
          }
          return (
            <a key={tab.label} href={tab.href} className={`maghrabi-creator-tab${tab.label === 'MEDIA' ? ' is-active' : ''}`}>
              <Icon size={16} />
              <span>{tab.label}</span>
            </a>
          )
        })}
      </nav>

      <a href="#deliver" className="maghrabi-creator-export">
        <Send size={15} />
        <span>EXPORT</span>
      </a>
    </div>
  )
}
