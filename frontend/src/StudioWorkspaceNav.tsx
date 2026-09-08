import {
  Captions,
  Crosshair,
  Film,
  Gauge,
  Grid2X2,
  Images,
  Layers3,
  Music2,
  Send,
  SlidersHorizontal,
  Sparkles,
  WandSparkles,
} from 'lucide-react'
import type { CreativeTab } from './lib/creativeProjectSettings'

type LinkTab = { label: string; href: string; icon: typeof Film; creative?: never; mixer?: never; masks?: never }
type CreativeNavTab = { label: string; icon: typeof Film; creative: CreativeTab; href?: never; mixer?: never; masks?: never }
type MixerNavTab = { label: string; icon: typeof Film; mixer: true; href?: never; creative?: never; masks?: never }
type MasksNavTab = { label: string; icon: typeof Film; masks: true; href?: never; creative?: never; mixer?: never }
type NavTab = LinkTab | CreativeNavTab | MixerNavTab | MasksNavTab

const tabs: NavTab[] = [
  { label: 'MEDIA', href: '#video', icon: Film },
  { label: 'AUDIO', href: '#audio', icon: Music2 },
  { label: 'TITLES', creative: 'titles', icon: Captions },
  { label: 'TRANSITIONS', creative: 'transitions', icon: Layers3 },
  { label: 'EFFECTS', creative: 'looks', icon: Sparkles },
  { label: 'MASKS', masks: true, icon: Crosshair },
  { label: 'SPEED', creative: 'speed', icon: Gauge },
  { label: 'MIX', mixer: true, icon: SlidersHorizontal },
  { label: 'ELEMENTS', href: '#video-v5', icon: Images },
  { label: 'SPLIT SCREEN', href: '#video-v5', icon: Grid2X2 },
]

function openCreative(tab: CreativeTab) {
  if (tab === 'transitions') {
    window.dispatchEvent(new CustomEvent('maghrabi-open-transition-browser'))
    return
  }
  window.dispatchEvent(new CustomEvent('maghrabi-open-creative-suite', { detail: { tab } }))
}

function openMixer() {
  window.dispatchEvent(new CustomEvent('maghrabi-open-audio-mixer'))
}

function openMasks() {
  window.dispatchEvent(new CustomEvent('maghrabi-open-mask-suite'))
}

function NavAction({ tab, rail = false }: { tab: NavTab; rail?: boolean }) {
  const Icon = tab.icon
  const className = rail
    ? `maghrabi-rail-tab${tab.label === 'MEDIA' ? ' is-active' : ''}`
    : `maghrabi-creator-tab${tab.label === 'MEDIA' ? ' is-active' : ''}`
  const content = <><Icon size={rail ? 17 : 16} /><span className={rail ? 'maghrabi-rail-label' : undefined}>{tab.label}</span></>

  if ('mixer' in tab && tab.mixer) {
    return <button type="button" className={className} onClick={openMixer} title={tab.label}>{content}</button>
  }
  if ('masks' in tab && tab.masks) {
    return <button type="button" className={className} onClick={openMasks} title={tab.label}>{content}</button>
  }
  if ('creative' in tab && tab.creative) {
    return <button type="button" className={className} onClick={() => openCreative(tab.creative)} title={tab.label}>{content}</button>
  }
  return <a href={tab.href} className={className} title={tab.label}>{content}</a>
}

export default function StudioWorkspaceNav() {
  return (
    <>
      <div className="maghrabi-creator-nav" dir="ltr">
        <div className="maghrabi-creator-brand">
          <span className="maghrabi-creator-brand-mark"><WandSparkles size={15} /></span>
          <span>
            <strong>MAGHRABI STUDIO</strong>
            <small>Creator Workspace</small>
          </span>
        </div>

        <nav className="maghrabi-creator-tabs" aria-label="Creator workspace">
          {tabs.map((tab) => <NavAction key={tab.label} tab={tab} />)}
        </nav>

        <a href="#deliver" className="maghrabi-creator-export">
          <Send size={15} />
          <span>EXPORT</span>
        </a>
      </div>

      <nav className="maghrabi-creator-rail" aria-label="Creator tools" dir="ltr">
        {tabs.map((tab) => <NavAction key={`rail-${tab.label}`} tab={tab} rail />)}
      </nav>
    </>
  )
}
