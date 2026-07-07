
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './src/App.tsx';
import './index.css';

const clearChunkRetryState = () => {
  try {
    Object.keys(sessionStorage)
      .filter(key => key.startsWith('finmonitor_chunk_retry_'))
      .forEach(key => sessionStorage.removeItem(key));
  } catch {}
};

const isChunkLoadError = (value: unknown) => {
  const message = value instanceof Error ? value.message : String(value || '');
  return /Failed to fetch dynamically imported module|Importing a module script failed|Loading chunk|ChunkLoadError|module script/i.test(message);
};

const showStartupRecovery = () => {
  const root = document.getElementById('root');
  if (!root) return;

  clearChunkRetryState();
  root.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#020617;color:#f8fafc;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:24px;">
      <div style="width:100%;max-width:440px;background:#0f172a;border:1px solid #1e293b;border-radius:24px;padding:32px;text-align:center;box-shadow:0 24px 70px rgba(0,0,0,.45);">
        <div style="width:56px;height:56px;border-radius:18px;background:#4f46e5;margin:0 auto 18px;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:24px;">F</div>
        <h1 style="margin:0;font-size:24px;font-weight:900;letter-spacing:0;">FinMonitor</h1>
        <p style="margin:12px 0 0;color:#cbd5e1;font-size:14px;line-height:1.6;font-weight:700;">La app recibió una actualización y tu navegador intentó usar archivos anteriores.</p>
        <button id="finmonitor-reload" style="margin-top:22px;width:100%;border:0;border-radius:14px;background:#ffffff;color:#0f172a;padding:14px 18px;font-size:14px;font-weight:900;cursor:pointer;">Recargar FinMonitor</button>
      </div>
    </div>
  `;

  document.getElementById('finmonitor-reload')?.addEventListener('click', async () => {
    clearChunkRetryState();
    try {
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map(name => caches.delete(name)));
    } catch {}
    const url = new URL(window.location.href);
    url.searchParams.set('v', Date.now().toString());
    window.location.replace(url.toString());
  });
};

window.addEventListener('error', event => {
  if (isChunkLoadError(event.error || event.message)) {
    event.preventDefault();
    showStartupRecovery();
  }
});

window.addEventListener('unhandledrejection', event => {
  if (isChunkLoadError(event.reason)) {
    event.preventDefault();
    showStartupRecovery();
  }
});

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
