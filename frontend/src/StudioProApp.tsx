import { useEffect, useState } from 'react'
import StudioCommandPalette from './StudioCommandPalette'
import StudioCreativeSuite from './StudioCreativeSuite'
import StudioEditingCorePro from './StudioEditingCorePro'
import StudioPrecisionEditPro from './StudioPrecisionEditPro'
import StudioProjectStatus from './StudioProjectStatus'
import StudioSequencePlaybackPro from './StudioSequencePlaybackPro'
import StudioThemeSelector, { getInitialStudioTheme, STUDIO_THEME_STORAGE_KEY, type StudioThemeId } from './StudioThemeSelector'
import StudioTimelineEnhancer from './StudioTimelineEnhancer'
import StudioTimelineInteractionPro from './StudioTimelineInteractionPro'
import StudioTitlePreviewPro from './StudioTitlePreviewPro'
import StudioTransportPro from './StudioTransportPro'
import StudioWorkspaceNav from './StudioWorkspaceNav'
import StudioWorkspaceResizePro from './StudioWorkspaceResizePro'
import VideoStudioCreator from './VideoStudioCreator'
import './studioProContrast.css'
import './studioThemes.css'
import './studioCreatorTeal.css'
import './studioCreatorWorkspace.css'
import './studioCreativeSuite.css'
import './studioSequencePlayback.css'
import './studioWorkspaceResize.css'
import './studioTitlePreview.css'

export default function StudioProApp() {
  const [theme, setTheme] = useState<StudioThemeId>(() => getInitialStudioTheme())

  useEffect(() => {
    window.localStorage.setItem(STUDIO_THEME_STORAGE_KEY, theme)
    document.documentElement.style.colorScheme = theme === 'light-studio' ? 'light' : 'dark'
  }, [theme])

  return (
    <div className="maghrabi-studio-pro min-h-screen" data-studio-theme={theme}>
      <StudioWorkspaceNav />
      <VideoStudioCreator />
      <StudioTimelineEnhancer />
      <StudioTimelineInteractionPro />
      <StudioEditingCorePro />
      <StudioPrecisionEditPro />
      <StudioSequencePlaybackPro />
      <StudioTransportPro />
      <StudioWorkspaceResizePro />
      <StudioCreativeSuite />
      <StudioTitlePreviewPro />
      <StudioProjectStatus />
      <StudioCommandPalette />
      <StudioThemeSelector value={theme} onChange={setTheme} />
    </div>
  )
}
