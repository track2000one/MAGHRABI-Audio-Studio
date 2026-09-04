import StudioCommandPalette from './StudioCommandPalette'
import StudioProjectStatus from './StudioProjectStatus'
import VideoStudioCreator from './VideoStudioCreator'

export default function StudioProApp() {
  return (
    <>
      <VideoStudioCreator />
      <StudioProjectStatus />
      <StudioCommandPalette />
    </>
  )
}
