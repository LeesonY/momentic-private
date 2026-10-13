import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.tsx';
import { AppProvider } from './state/AppContext.tsx';
import { ThemeProvider } from './state/ThemeContext.tsx';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles/tokens.css';
import './styles/base.css';
import './styles/controls.css';
import './styles/components.css';
import './styles/shell.css';
import './styles/pages.css';
import './styles/models.css';
import './styles/mo.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <AppProvider>
        <App />
      </AppProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
