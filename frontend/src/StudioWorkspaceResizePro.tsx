import { useEffect } from 'react'

const STORAGE_KEY = 'maghrabi-workspace-columns-v1'
const MIN_VIEWPORT = 1360

type Sizes = { library: number; inspector: number }

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

export default function StudioWorkspaceResizePro() {
  useEffect(() => {
    let section: HTMLElement | null = null
    let leftHandle: HTMLDivElement | null = null
    let rightHandle: HTMLDivElement | null = null
    let sizes = readSizes()
    let active: 'library' | 'inspector' | null = null
    let resizeObserver: ResizeObserver | null = null
    let mutationObserver: MutationObserver | null = null

    const applyColumns = () => {
      if (!section) return
      if (window.innerWidth < MIN_VIEWPORT) {
        section.style.removeProperty('grid-template-columns')
        leftHandle?.classList.add('is-hidden')
        rightHandle?.classList.add('is-hidden')
        return
      }
      section.style.setProperty('grid-template-columns', `${sizes.library}px minmax(560px, 1fr) ${sizes.inspector}px`, 'important')
      leftHandle?.classList.remove('is-hidden')
      rightHandle?.classList.remove('is-hidden')
      window.requestAnimationFrame(positionHandles)
    }

    const positionHandles = () => {
      if (!section || !leftHandle || !rightHandle || window.innerWidth < MIN_VIEWPORT) return
      const asides = section.querySelectorAll<HTMLElement>(':scope > aside')
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

    const install = () => {
      const next = document.querySelector<HTMLElement>('.maghrabi-studio-pro main > div > section')
      if (!next || next === section) return
      leftHandle?.remove()
      rightHandle?.remove()
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
      leftHandle.addEventListener('dblclick', () => { sizes.library = 330; writeSizes(sizes); applyColumns() })
      rightHandle.addEventListener('dblclick', () => { sizes.inspector = 310; writeSizes(sizes); applyColumns() })
      section.append(leftHandle, rightHandle)
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
      if (section) section.style.removeProperty('grid-template-columns')
      document.documentElement.classList.remove('maghrabi-workspace-resizing')
    }
  }, [])

  return null
}
