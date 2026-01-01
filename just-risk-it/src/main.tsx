import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { PrivyProvider } from './providers/PrivyProvider'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PrivyProvider>
    <App />
    </PrivyProvider>
  </StrictMode>,
)
