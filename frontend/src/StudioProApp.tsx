import { useEffect, useState } from 'react'
import StudioCommandPalette from './StudioCommandPalette'
import StudioEditingCorePro from './StudioEditingCorePro'
import StudioPrecisionEditPro from './StudioPrecisionEditPro'
import StudioProjectStatus from './StudioProjectStatus'
import StudioThemeSelector, { getInitialStudioTheme, STUDIO_THEME_STORAGE_KEY, type StudioThemeId } from './StudioThemeSelector'
import StudioTimelineEnhancer from './StudioTimelineEnhancer'
import VideoStudioCreator from './VideoStudioCreator'
import './studioProContrast.css'

export default function StudioProApp() {
  const [theme, setTheme] = useState<StudioThemeId>(() => getInitialStudioTheme())

  useEffect(() => {
    window.localStorage.setItem(STUDIO_THEME_STORAGE_KEY, theme)
    document.documentElement.style.colorScheme = theme === 'light-studio' ? 'light' : 'dark'
  }, [theme])

  return (
    <div className="maghrabi-studio-pro min-h-screen" data-studio-theme={theme}>
      <VideoStudioCreator />
      <StudioTimelineEnhancer />
      <StudioEditingCorePro />
      <StudioPrecisionEditPro />
      <StudioProjectStatus />
      <StudioCommandPalette />
      <StudioThemeSelector value={theme} onChange={setTheme} />
    </div>
  )
}
