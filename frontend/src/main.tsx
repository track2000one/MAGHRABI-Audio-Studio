import React from 'react'
import ReactDOM from 'react-dom/client'
import RootRouter from './RootRouter'
import AppErrorBoundary from './AppErrorBoundary'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <RootRouter />
    </AppErrorBoundary>
  </React.StrictMode>,
)
