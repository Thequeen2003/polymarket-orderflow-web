import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { RootErrorBoundary } from './RootErrorBoundary';
import { installPointerCaptureSafety } from './pointerCaptureSafety';

installPointerCaptureSafety();

// Avoid browser scroll restoration fighting live-updating panels in dev.
if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';

// No <StrictMode>: dev double-mount + double-effect was amplifying races (WS listeners,
// window events, timers) and interacting badly with hot reload on this heavy UI.

createRoot(document.getElementById('root')!).render(
  <RootErrorBoundary>
    <App />
  </RootErrorBoundary>,
);
