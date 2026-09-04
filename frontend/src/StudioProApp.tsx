import StudioCommandPalette from './StudioCommandPalette'
import StudioProjectStatus from './StudioProjectStatus'
import StudioTimelineEnhancer from './StudioTimelineEnhancer'
import VideoStudioCreator from './VideoStudioCreator'
import './studioProContrast.css'

export default function StudioProApp() {
  return (
    <div className="maghrabi-studio-pro min-h-screen">
      <VideoStudioCreator />
      <StudioTimelineEnhancer />
      <StudioProjectStatus />
      <StudioCommandPalette />
    </div>
  )
}
