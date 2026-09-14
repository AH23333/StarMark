import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initI18n } from '~/core/i18n'
import './style.css'

void initI18n().then(() => {
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
})