import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
// Brand wordmark font (embedded, subset) — Playfair Display for the
// "TradingCorp" header. Bold weights 700/800.
import '@fontsource/playfair-display/700.css';
import '@fontsource/playfair-display/800.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
