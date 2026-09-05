import { useEffect } from 'react'

const STORAGE_KEY = 'maghrabi-workspace-columns-v1'
const FOCUS_KEY = 'maghrabi-workspace-focus-v1'
const MIN_VIEWPORT = 1360

type Sizes = { library: number; inspector: number }
type FocusState = { libraryCollapsed: boolean; inspectorCollapsed: boolean }

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function readSizes(): Sizes {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return {
      library: clamp(Number(parsed?.library) || 330, 240, 500),
      inspector: clamp(Number(parsed?.inspector) || 310, 240, 460),
    }
  } catch {
    return { library: 330, inspector: 310 }
  }
}

function writeSizes(sizes: Sizes) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes))
}

function readFocus(): FocusState {
  try {
    const raw = localStorage.getItem(FOCUS_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return {
      libraryCollapsed: Boolean(parsed?.libraryCollapsed),
      inspectorCollapsed: Boolean(parsed?.inspectorCollapsed),
    }
  } catch {
    return { libraryCollapsed: false, inspectorCollapsed: false }
  }
}

function writeFocus(state: FocusState) {
  localStorage.setItem(FOCUS_KEY, JSON.stringify(state))
}

function buttonStyle(active = false) {
  return [
    'height:26px',
    'padding:0 9px',
    'border-radius:8px',
    `border:1px solid ${active ? 'rgba(103,232,249,.38)' : 'rgba(255,255,255,.10)'}`,
    `background:${active ? 'rgba(34,211,238,.12)' : 'rgba(3,8,18,.82)'}`,
    `color:${active ? '#cffafe' : '#94a3b8'}`,
    'font-size:9px',
    'font-weight:900',
    'letter-spacing:.08em',
    'cursor:pointer',
    'backdrop-filter:blur(14px)',
  ].join(';')
}

export default function StudioWorkspaceResizePro() {
  useEffect(() => {
    let section: HTMLElement | null = null
    let leftHandle: HTMLDivElement | null = null
    let rightHandle: HTMLDivElement | null = null
    let toolbar: HTMLDivElement | null = null
    let sizes = readSizes()
    let focus = readFocus()
    let active: 'library' | 'inspector' | null = null
    let resizeObserver: ResizeObserver | null = null
    let mutationObserver: MutationObserver | null = null

    const directAsides = (): HTMLElement[] => section ? Array.from(section.querySelectorAll<HTMLElement>(':scope > aside')) : []

    const updateToolbar = () => {
      if (!toolbar) return
      const media = toolbar.querySelector<HTMLButtonElement>('[data-workspace-action="media"]')
      const focusButton = toolbar.querySelector<HTMLButtonElement>('[data-workspace-action="focus"]')
      const inspector = toolbar.querySelector<HTMLButtonElement>('[data-workspace-action="inspector"]')
      if (media) {
        media.style.cssText = buttonStyle(focus.libraryCollapsed)
        media.textContent = focus.libraryCollapsed ? 'SHOW MEDIA' : 'HIDE MEDIA'
      }
      if (inspector) {
        inspector.style.cssText = buttonStyle(focus.inspectorCollapsed)
        inspector.textContent = focus.inspectorCollapsed ? 'SHOW INSPECTOR' : 'HIDE INSPECTOR'
      }
      if (focusButton) {
        const isFocus = focus.libraryCollapsed && focus.inspectorCollapsed
        focusButton.style.cssText = buttonStyle(isFocus)
        focusButton.textContent = isFocus ? 'EXIT FOCUS' : 'FOCUS'
      }
    }

    const applyColumns = () => {
      if (!section) return
      const asides = directAsides()
      const library = asides[0]
      const inspector = asides[asides.length - 1]

      if (window.innerWidth < MIN_VIEWPORT) {
        section.style.removeProperty('grid-template-columns')
        leftHandle?.classList.add('is-hidden')
        rightHandle?.classList.add('is-hidden')
        library?.style.removeProperty('overflow')
        library?.style.removeProperty('opacity')
        library?.style.removeProperty('pointer-events')
        inspector?.style.removeProperty('overflow')
        inspector?.style.removeProperty('opacity')
        inspector?.style.removeProperty('pointer-events')
        if (toolbar) toolbar.style.display = 'none'
        return
      }

      if (toolbar) toolbar.style.display = 'flex'
      const libraryWidth = focus.libraryCollapsed ? 0 : sizes.library
      const inspectorWidth = focus.inspectorCollapsed ? 0 : sizes.inspector
      section.style.setProperty('grid-template-columns', `${libraryWidth}px minmax(560px, 1fr) ${inspectorWidth}px`, 'important')

      if (library) {
        library.style.overflow = focus.libraryCollapsed ? 'hidden' : ''
        library.style.opacity = focus.libraryCollapsed ? '0' : '1'
        library.style.pointerEvents = focus.libraryCollapsed ? 'none' : ''
        library.style.transition = 'opacity 140ms ease'
      }
      if (inspector) {
        inspector.style.overflow = focus.inspectorCollapsed ? 'hidden' : ''
        inspector.style.opacity = focus.inspectorCollapsed ? '0' : '1'
        inspector.style.pointerEvents = focus.inspectorCollapsed ? 'none' : ''
        inspector.style.transition = 'opacity 140ms ease'
      }

      leftHandle?.classList.toggle('is-hidden', focus.libraryCollapsed)
      rightHandle?.classList.toggle('is-hidden', focus.inspectorCollapsed)
      updateToolbar()
      window.requestAnimationFrame(positionHandles)
    }

    const positionHandles = () => {
      if (!section || !leftHandle || !rightHandle || window.innerWidth < MIN_VIEWPORT) return
      const asides = directAsides()
      const library = asides[0]
      const inspector = asides[asides.length - 1]
      if (!library || !inspector) return
      const sectionRect = section.getBoundingClientRect()
      const libraryRect = library.getBoundingClientRect()
      const inspectorRect = inspector.getBoundingClientRect()
      const height = Math.max(360, Math.min(580, Math.max(libraryRect.height, inspectorRect.height)))
      leftHandle.style.left = `${libraryRect.right - sectionRect.left - 4}px`
      leftHandle.style.height = `${height}px`
      rightHandle.style.left = `${inspectorRect.left - sectionRect.left - 4}px`
      rightHandle.style.height = `${height}px`
    }

    const setActive = (value: 'library' | 'inspector' | null) => {
      active = value
      leftHandle?.classList.toggle('is-dragging', value === 'library')
      rightHandle?.classList.toggle('is-dragging', value === 'inspector')
      document.documentElement.classList.toggle('maghrabi-workspace-resizing', Boolean(value))
    }

    const onMove = (event: PointerEvent) => {
      if (!active || !section) return
      const rect = section.getBoundingClientRect()
      if (active === 'library') sizes.library = clamp(event.clientX - rect.left, 240, Math.min(500, rect.width * .34))
      else sizes.inspector = clamp(rect.right - event.clientX, 240, Math.min(460, rect.width * .31))
      applyColumns()
    }

    const onUp = () => {
      if (!active) return
      writeSizes(sizes)
      setActive(null)
    }

    const makeToolbar = () => {
      if (!section) return
      toolbar?.remove()
      toolbar = document.createElement('div')
      toolbar.className = 'maghrabi-workspace-focusbar'
      toolbar.style.cssText = 'position:absolute;z-index:70;top:6px;left:50%;transform:translateX(-50%);display:flex;gap:5px;align-items:center;pointer-events:auto;'

      const makeButton = (action: string, label: string, title: string) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.dataset.workspaceAction = action
        button.textContent = label
        button.title = title
        button.style.cssText = buttonStyle(false)
        toolbar?.appendChild(button)
        return button
      }

      const media = makeButton('media', 'HIDE MEDIA', 'إخفاء/إظهار Media لزيادة مساحة Timeline')
      const focusButton = makeButton('focus', 'FOCUS', 'وضع التركيز: إخفاء Media وInspector')
      const inspector = makeButton('inspector', 'HIDE INSPECTOR', 'إخفاء/إظهار Inspector')
      const reset = makeButton('reset', 'RESET', 'إعادة مساحة العمل إلى الوضع الافتراضي')

      media.addEventListener('click', () => {
        focus.libraryCollapsed = !focus.libraryCollapsed
        writeFocus(focus)
        applyColumns()
      })
      inspector.addEventListener('click', () => {
        focus.inspectorCollapsed = !focus.inspectorCollapsed
        writeFocus(focus)
        applyColumns()
      })
      focusButton.addEventListener('click', () => {
        const isFocus = focus.libraryCollapsed && focus.inspectorCollapsed
        focus = { libraryCollapsed: !isFocus, inspectorCollapsed: !isFocus }
        writeFocus(focus)
        applyColumns()
      })
      reset.addEventListener('click', () => {
        sizes = { library: 330, inspector: 310 }
        focus = { libraryCollapsed: false, inspectorCollapsed: false }
        writeSizes(sizes)
        writeFocus(focus)
        applyColumns()
      })

      section.appendChild(toolbar)
      updateToolbar()
    }

    const install = () => {
      const next = document.querySelector<HTMLElement>('.maghrabi-studio-pro main > div > section')
      if (!next || next === section) return
      leftHandle?.remove()
      rightHandle?.remove()
      toolbar?.remove()
      resizeObserver?.disconnect()
      section = next
      section.style.position = 'relative'
      leftHandle = document.createElement('div')
      rightHandle = document.createElement('div')
      leftHandle.className = 'maghrabi-workspace-resizer is-library'
      rightHandle.className = 'maghrabi-workspace-resizer is-inspector'
      leftHandle.title = 'اسحب لتغيير عرض Media · نقرتان لإعادة الضبط'
      rightHandle.title = 'اسحب لتغيير عرض Inspector · نقرتان لإعادة الضبط'
      leftHandle.addEventListener('pointerdown', (event) => { event.preventDefault(); setActive('library') })
      rightHandle.addEventListener('pointerdown', (event) => { event.preventDefault(); setActive('inspector') })
      leftHandle.addEventListener('dblclick', () => { sizes.library = 330; focus.libraryCollapsed = false; writeSizes(sizes); writeFocus(focus); applyColumns() })
      rightHandle.addEventListener('dblclick', () => { sizes.inspector = 310; focus.inspectorCollapsed = false; writeSizes(sizes); writeFocus(focus); applyColumns() })
      section.append(leftHandle, rightHandle)
      makeToolbar()
      resizeObserver = new ResizeObserver(() => { applyColumns(); positionHandles() })
      resizeObserver.observe(section)
      applyColumns()
      positionHandles()
    }

    document.addEventListener('pointermove', onMove, true)
    document.addEventListener('pointerup', onUp, true)
    window.addEventListener('resize', applyColumns)
    mutationObserver = new MutationObserver(() => install())
    mutationObserver.observe(document.body, { childList: true, subtree: true })
    install()

    return () => {
      document.removeEventListener('pointermove', onMove, true)
      document.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('resize', applyColumns)
      mutationObserver?.disconnect()
      resizeObserver?.disconnect()
      leftHandle?.remove()
      rightHandle?.remove()
      toolbar?.remove()
      const asides = directAsides()
      asides.forEach((aside) => {
        aside.style.removeProperty('overflow')
        aside.style.removeProperty('opacity')
        aside.style.removeProperty('pointer-events')
        aside.style.removeProperty('transition')
      })
      if (section) section.style.removeProperty('grid-template-columns')
      document.documentElement.classList.remove('maghrabi-workspace-resizing')
    }
  }, [])

  return null
}
