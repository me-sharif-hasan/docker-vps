import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import './index.css'

// HashRouter deliberately, not BrowserRouter - the built app is served as
// static files by Fastify at /dashboard with no SPA history-fallback route,
// so a deep link like /dashboard/sessions would 404 on a hard refresh.
// Hash routing (/dashboard/#/sessions) never leaves /dashboard/index.html,
// so no server-side wildcard route is needed at all.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>
)
