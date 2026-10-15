import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error('Telegram Signal Desk failed to render:', error?.message || 'Unknown render error');
  }

  render() {
    if (this.state.failed) {
      return <main className="loading-shell"><section className="panel"><h1>Signal Desk could not start</h1><p className="muted">A page error interrupted startup. Reload the page; if this keeps happening, share the error with your app administrator.</p><button className="button button-primary" onClick={() => window.location.reload()}>Reload app</button></section></main>;
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </React.StrictMode>,
);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  });
}
