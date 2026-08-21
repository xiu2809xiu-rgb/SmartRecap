import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { PrefsProvider } from './lib/prefs.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { AuthProvider } from './lib/auth.jsx';
import { StoreProvider } from './lib/store.jsx';
import { JobsProvider } from './components/jobs.jsx';
import { ToastProvider } from './components/ui.jsx';
import './styles/base.css';
import './styles/app.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <PrefsProvider>
        <ToastProvider>
          <AuthProvider>
            <StoreProvider>
              <JobsProvider>
                {/* Last resort. Without this a render error anywhere unmounts
                    the tree and the page just goes white. */}
                <ErrorBoundary>
                  <App />
                </ErrorBoundary>
              </JobsProvider>
            </StoreProvider>
          </AuthProvider>
        </ToastProvider>
      </PrefsProvider>
    </BrowserRouter>
  </StrictMode>,
);