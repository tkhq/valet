import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, router } from './app';
import { applyBuildChrome } from './lib/build-info';
import { initFaro, observeRouter } from './lib/observability';
import './styles/globals.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element not found');

applyBuildChrome();

// Frontend observability — hard no-op unless VITE_FARO_URL is set.
void initFaro();
observeRouter(router);

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// Register service worker for PWA install support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Service worker registration failed — non-critical for app functionality
    });
  });
}
