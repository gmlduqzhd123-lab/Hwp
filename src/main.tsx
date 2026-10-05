import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { startInstallWatcher } from './features/install-state';
import './styles/app.css';

startInstallWatcher();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
