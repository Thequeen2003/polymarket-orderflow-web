import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

// Avoid browser scroll restoration fighting live-updating panels in dev.
if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
