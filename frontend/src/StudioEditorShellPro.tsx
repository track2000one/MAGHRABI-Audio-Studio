import { useEffect } from 'react'

const REGION_CLASSES = [
  'studio-editor-root',
  'studio-editor-internal-toolbar',
  'studio-editor-grid',
  'studio-region-media',
  'studio-region-center',
  'studio-region-inspector',
  'studio-monitor-stage',
  'studio-source-monitor',
  'studio-program-monitor',
  'studio-timeline-dock',
]

function clearClasses(root: ParentNode = document) {
  REGION_CLASSES.forEach((className) => {
    root.querySelectorAll<HTMLElement>(`.${className}`).forEach((element) => element.classList.remove(className))
  })
}

function installRegions() {
  const editorRoot = document.querySelector<HTMLElement>('.maghrabi-studio-pro main > div')
  if (!editorRoot) return false

  clearClasses(editorRoot)
  editorRoot.classList.add('studio-editor-root')

  const header = editorRoot.querySelector<HTMLElement>(':scope > header')
  const section = editorRoot.querySelector<HTMLElement>(':scope > section')
  if (!section) return false

  header?.classList.add('studio-editor-internal-toolbar')
  section.classList.add('studio-editor-grid')

  const sectionChildren = Array.from(section.children).filter((node): node is HTMLElement => node instanceof HTMLElement)
  const media = sectionChildren[0]
  const center = sectionChildren[1]
  const inspector = sectionChildren[2]

  media?.classList.add('studio-region-media')
  center?.classList.add('studio-region-center')
  inspector?.classList.add('studio-region-inspector')

  if (center) {
    const centerChildren = Array.from(center.children).filter((node): node is HTMLElement => node instanceof HTMLElement)
    const monitorStage = centerChildren[0]
    const timeline = centerChildren[1]
    monitorStage?.classList.add('studio-monitor-stage')
    timeline?.classList.add('studio-timeline-dock')

    if (monitorStage) {
      const monitors = Array.from(monitorStage.children).filter((node): node is HTMLElement => node instanceof HTMLElement)
      monitors[0]?.classList.add('studio-source-monitor')
      monitors[1]?.classList.add('studio-program-monitor')
    }
  }

  return true
}

export default function StudioEditorShellPro() {
  useEffect(() => {
    let frame = 0
    let attempts = 0

    const scheduleInstall = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        if (!installRegions() && attempts < 80) {
          attempts += 1
          window.setTimeout(scheduleInstall, 50)
        }
      })
    }

    const observer = new MutationObserver(scheduleInstall)
    observer.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', scheduleInstall)
    window.addEventListener('maghrabi-active-project-changed', scheduleInstall)
    scheduleInstall()

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', scheduleInstall)
      window.removeEventListener('maghrabi-active-project-changed', scheduleInstall)
      window.cancelAnimationFrame(frame)
      clearClasses()
    }
  }, [])

  return null
}
