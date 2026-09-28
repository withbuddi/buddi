import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ConnectionCallback } from './views/ConnectionCallback';
import '@fontsource-variable/dm-sans/standard.css';
import '@fontsource-variable/dm-sans/standard-italic.css';
import '@fontsource/dm-mono/400.css';
import '@fontsource/dm-mono/500.css';
import './styles.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      {/* A connected service's consent page lands here, outside the shell. */}
      {location.pathname === '/connections/callback' ? <ConnectionCallback /> : <App />}
    </StrictMode>,
  );
}
