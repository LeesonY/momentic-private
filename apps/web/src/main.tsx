import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.tsx';
import { AppProvider } from './state/AppContext.tsx';
import { ThemeProvider } from './state/ThemeContext.tsx';
import './styles/index.css';
import './styles/modern.css';
import './styles/models.css';
import './styles/form-controls.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <AppProvider>
        <App />
      </AppProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
