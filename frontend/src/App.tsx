import { useCallback, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import SettingsDialog from './components/SettingsDialog';
import AnalysisView from './components/AnalysisView';
import ReportsCalendar from './components/ReportsCalendar';
import type { ConnectionSettings, AnalystSourceCatalog } from './types';
import { getAnalystSourceCatalog } from './api/analystConfigClient';
import { getRegistry } from './api/registryClient';
import { applyRegistryAgencies } from './components/analysts/agencies';
import { AGENCY_IDS, DEFAULT_AGENCY, type AgencyId } from './components/analysts/agencies';
import { getPageMaxWidth, setPageMaxWidth as persistPageMaxWidth } from './lib/uiPrefs';

// Connect the socket to the SAME ORIGIN that served the page. In dev the Vite
// proxy forwards `/socket.io` (ws) to the backend; in prod the backend serves
// both the SPA and the socket. This is robust to any HOST/PORT and works
// cross-machine (open http://<lan-ip>:5173 and the socket follows). A hardcoded
// `http://localhost:PORT` breaks the moment the backend binds a non-loopback
// HOST or the page is opened from another machine. Override with VITE_SOCKET_URL
// only for an explicit, non-proxied backend origin.
const SOCKET_URL =
  import.meta.env.VITE_SOCKET_URL ||
  (typeof window !== 'undefined' ? window.location.origin : undefined);
const ATTEMPT_TIMEOUT_MS = 4000;

function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  // Connection chip state: 'connecting' (initial / retrying), 'connected'
  // (green), 'disconnected' (backend stopped/killed — red). Drives the badge
  // text+color; `connected` stays a plain boolean for AnalysisView.
  const [connState, setConnState] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<ConnectionSettings | undefined>(undefined);
  const [sessionId, setSessionId] = useState('default');
  // §12.4.1: selected agency, owned here so the top-right Settings dialog's
  // per-agency "default model" control targets the SAME agency shown below.
  const [agencyId, setAgencyId] = useState<AgencyId>(DEFAULT_AGENCY);
  // B1: catalog of analysts that declare a LIVE+auth source (drives the ⚙ button).
  const [sourceCatalog, setSourceCatalog] = useState<AnalystSourceCatalog>({ analysts: [] });
  // Bumped when an agency is created/deleted in the Settings dialog so the
  // AnalysisView dropdown re-renders from the mutated AGENCIES mirror live.
  const [registryVersion, setRegistryVersion] = useState(0);
  // Page max-width (px), persisted in localStorage. Applied to the .content
  // <main> so the whole page honors the user's chosen width.
  const [pageMaxWidth, setPageMaxWidth] = useState<number>(() => getPageMaxWidth());

  const handlePageMaxWidthChange = useCallback((px: number) => {
    const clamped = persistPageMaxWidth(px);
    setPageMaxWidth(clamped);
  }, []);

  // Pull the persisted registry once on mount (and on (re)connect) so the
  // AGENCIES mirror — which feeds the top-right agency dropdown — includes
  // custom agencies BEFORE the user opens Settings. Without this, a new agency
  // (e.g. "My Wheel with new Analyst") only appeared after opening Settings.
  const refreshRegistry = useCallback(async (sid: string) => {
    try {
      const data = await getRegistry(sid);
      applyRegistryAgencies(data.agencies);
      // Mirror mutated outside React — nudge a re-render so the dropdown
      // reflects the freshly-loaded agencies immediately.
      setRegistryVersion((v) => v + 1);
    } catch {
      // Server may not be up yet / route disabled — non-fatal; the mirror keeps
      // the compiled defaults until a later load (e.g. opening Settings).
    }
  }, []);

  // Fetch the catalog once on mount (and whenever the socket connects).
  const refreshSourceCatalog = useCallback(async () => {
    try {
      const catalog = await getAnalystSourceCatalog();
      setSourceCatalog(catalog);
    } catch {
      // Server may not be up yet / route disabled — fail silently; the ⚙ button
      // simply won't appear. Non-fatal.
    }
  }, []);

  useEffect(() => {
    refreshSourceCatalog();
  }, [refreshSourceCatalog, connected]);

  // Populate the agency dropdown mirror before first paint. Runs on mount,
  // on (re)connect, and whenever the session changes. Quietly no-ops if the
  // server isn't reachable yet (the catch swallows it; Settings re-fetches).
  useEffect(() => {
    refreshRegistry(sessionId);
  }, [refreshRegistry, sessionId, connected]);

  const socketRef = useRef<Socket | null>(null);
  const cancelled = useRef(false);

  const cleanupSocket = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.removeAllListeners();
      socketRef.current.disconnect();
      socketRef.current = null;
    }
  }, []);

  // One connection attempt. We rely on socket.io's built-in reconnection (not
  // `reconnection: false`) so the chip self-heals: if the backend is stopped
  // or crashes, the socket emits `disconnect` → chip goes red "Disconnected",
  // and socket.io quietly keeps retrying until the server returns → chip goes
  // green again with no user action. There is no manual Connect button.
  const attemptConnect = useCallback(() => {
    if (cancelled.current) return;
    const s: Socket = io(SOCKET_URL, {
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
      transports: ['websocket', 'polling'],
      timeout: ATTEMPT_TIMEOUT_MS,
    });
    socketRef.current = s;

    s.on('connect', () => {
      if (cancelled.current) return;
      s.on('welcome', (msg: { message: string }) => {
        console.log('[server]', msg.message);
      });
      setConnected(true);
      setConnState('connected');
      setSocket(s);
    });

    // Backend stopped/killed/network drop: show DISCONNECTED (red). socket.io
    // keeps retrying on its own, so this is a transient state, not a dead end.
    s.on('disconnect', () => {
      if (cancelled.current) return;
      setConnected(false);
      setConnState('disconnected');
    });

    // Initial connection failed (server down, auth, DNS): show Disconnected
    // rather than staying stuck on "Connecting…". Reconnection stays enabled.
    s.on('connect_error', () => {
      if (cancelled.current) return;
      setConnected(false);
      setConnState('disconnected');
    });
  }, []);

  // Auto-connect on first mount (covers the "refresh the UI" case).
  useEffect(() => {
    cancelled.current = false;
    cleanupSocket();
    setConnected(false);
    setConnState('connecting');
    attemptConnect();
    return () => {
      cancelled.current = true;
      cleanupSocket();
    };
    // Run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <span class="app-wordmark" data-testid="app-wordmark">Trading<span class="app-wordmark-accent">Corp</span></span>
        <div className="topbar-actions">
          <span className={`status ${connState === 'connected' ? 'online' : 'offline'}`}
            data-testid="conn-status"
            data-state={connState}>
            {connState === 'connected' ? '🟢 Connected'
              : connState === 'disconnected' ? '🔴 Disconnected'
              : '🟡 Connecting…'}
          </span>
          <ReportsCalendar />
          <button
            type="button"
            className="settings-open"
            aria-label="Open connection settings"
            data-testid="open-connection-settings"
            onClick={() => setSettingsOpen(true)}
          >
            ⚙ Settings
          </button>
        </div>
      </header>

      <main className="content" style={{ maxWidth: pageMaxWidth }}>
        <AnalysisView
          socket={socket}
          connected={connected}
          sessionId={sessionId}
          onSessionChange={setSessionId}
          sourceCatalog={sourceCatalog}
          agencyId={agencyId}
          onAgencyChange={setAgencyId}
          registryVersion={registryVersion}
          onSourceSaved={refreshSourceCatalog}
        />
      </main>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        initial={settings}
        sessionId={sessionId}
        agencyId={agencyId}
        onSaved={(s) => setSettings(s)}
        onRegistryChange={() => setRegistryVersion((v) => v + 1)}
        onPageMaxWidthChange={handlePageMaxWidthChange}
      />
    </div>
  );
}

export default App;
