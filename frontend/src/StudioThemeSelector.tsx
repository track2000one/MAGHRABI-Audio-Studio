import { useEffect, useRef, useState } from 'react'

export type StudioThemeId = 'creator-teal' | 'midnight-pro' | 'graphite-gold' | 'light-studio' | 'ocean-blue' | 'amoled-black'

export const STUDIO_THEME_STORAGE_KEY = 'maghrabi-studio-theme-v2'

export const STUDIO_THEMES: Array<{
  id: StudioThemeId
  name: string
  description: string
  swatches: [string, string, string]
}> = [
  {
    id: 'creator-teal',
    name: 'Creator Teal',
    description: 'Film-style dark graphite · mint teal',
    swatches: ['#172129', '#4ce1c1', '#283640'],
  },
  {
    id: 'midnight-pro',
    name: 'Midnight Pro',
    description: 'Cyan · Indigo · deep navy',
    swatches: ['#070b16', '#22d3ee', '#6366f1'],
  },
  {
    id: 'graphite-gold',
    name: 'Graphite Gold',
    description: 'Graphite · warm gold · premium',
    swatches: ['#0d0f12', '#e8b84a', '#8b6a22'],
  },
  {
    id: 'light-studio',
    name: 'Light Studio',
    description: 'Bright · neutral · high clarity',
    swatches: ['#e9eef7', '#ffffff', '#2563eb'],
  },
  {
    id: 'ocean-blue',
    name: 'Ocean Blue',
    description: 'Ocean · azure · electric cyan',
    swatches: ['#06131f', '#0ea5e9', '#06b6d4'],
  },
  {
    id: 'amoled-black',
    name: 'AMOLED Black',
    description: 'Pure black · cyan · maximum contrast',
    swatches: ['#000000', '#00e5ff', '#111827'],
  },
]

export function getInitialStudioTheme(): StudioThemeId {
  if (typeof window === 'undefined') return 'creator-teal'
  const stored = window.localStorage.getItem(STUDIO_THEME_STORAGE_KEY) as StudioThemeId | null
  return STUDIO_THEMES.some((theme) => theme.id === stored) ? stored! : 'creator-teal'
}

type Props = {
  value: StudioThemeId
  onChange: (theme: StudioThemeId) => void
}

export default function StudioThemeSelector({ value, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const active = STUDIO_THEMES.find((theme) => theme.id === value) ?? STUDIO_THEMES[0]

  useEffect(() => {
    if (!open) return
    const closeOnOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', closeOnOutside)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeOnOutside)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  return (
    <div ref={rootRef} className="maghrabi-theme-picker" dir="ltr">
      {open && (
        <div className="maghrabi-theme-menu" role="menu" aria-label="Studio theme">
          <div className="maghrabi-theme-menu-head">
            <span>STUDIO THEME</span>
            <small>Appearance is saved automatically</small>
          </div>
          <div className="maghrabi-theme-list">
            {STUDIO_THEMES.map((theme) => {
              const selected = theme.id === value
              return (
                <button
                  key={theme.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  className={`maghrabi-theme-option${selected ? ' is-selected' : ''}`}
                  onClick={() => {
                    onChange(theme.id)
                    setOpen(false)
                  }}
                >
                  <span className="maghrabi-theme-preview" aria-hidden="true">
                    {theme.swatches.map((color) => <i key={color} style={{ background: color }} />)}
                  </span>
                  <span className="maghrabi-theme-copy">
                    <strong>{theme.name}</strong>
                    <small>{theme.description}</small>
                  </span>
                  <span className="maghrabi-theme-check" aria-hidden="true">{selected ? '✓' : ''}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      <button
        type="button"
        className={`maghrabi-theme-trigger${open ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        title="Change Studio theme"
      >
        <span className="maghrabi-theme-trigger-icon" aria-hidden="true">◐</span>
        <span>
          <small>THEME</small>
          <strong>{active.name}</strong>
        </span>
        <b aria-hidden="true">⌃</b>
      </button>
    </div>
  )
}
