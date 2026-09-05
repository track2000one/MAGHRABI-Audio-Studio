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

const tabs = [
  { label: 'MEDIA', href: '#video', icon: Film },
  { label: 'AUDIO', href: '#audio', icon: Music2 },
  { label: 'TITLES', href: '#video', icon: Captions },
  { label: 'TRANSITIONS', href: '#video-v4', icon: Layers3 },
  { label: 'EFFECTS', href: '#color', icon: Sparkles },
  { label: 'ELEMENTS', href: '#video-v5', icon: Images },
  { label: 'SPLIT SCREEN', href: '#video-v5', icon: Grid2X2 },
]

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
        {tabs.map(({ label, href, icon: Icon }) => (
          <a key={label} href={href} className={`maghrabi-creator-tab${label === 'MEDIA' ? ' is-active' : ''}`}>
            <Icon size={16} />
            <span>{label}</span>
          </a>
        ))}
      </nav>

      <a href="#deliver" className="maghrabi-creator-export">
        <Send size={15} />
        <span>EXPORT</span>
      </a>
    </div>
  )
}
