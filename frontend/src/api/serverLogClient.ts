// frontend/src/api/serverLogClient.ts
// Fetch the last N lines of the server log (GET /server-log).
//
// In dev the browser talks to the Vite origin (:5173), which proxies /server-log
// to the Express backend (:3001) — see vite.config.ts. In a production build the
// backend serves the SPA and the same relative URL hits it directly. A relative
// URL is used so both contexts work; if the response is HTML (e.g. a misconfigured
// proxy fell back to the SPA), we surface a clear error instead of dumping markup.
export async function getServerLog(lines = 200): Promise<string> {
  const res = await fetch(`/server-log?lines=${encodeURIComponent(lines)}`);
  if (!res.ok) throw new Error(`server-log ${res.status}`);
  const text = await res.text();
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) {
    throw new Error(
      'Server log endpoint returned HTML — the dev proxy may not be forwarding /server-log to the backend.',
    );
  }
  return text;
}
