import { render, screen, waitFor, act } from '@testing-library/react';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';

// Deterministic tests: mock socket.io-client so we control connect success
// without depending on a live backend or real timeouts. The manual Connect
// button was removed (auto-connect is reliable) — these tests cover the
// green status indicator + settings entry instead.

function makeFakeSocket() {
  const handlers: Record<string, Array<(data?: any) => void>> = {};
  const socket: any = {
    once: (ev: string, cb: (d?: any) => void) => {
      (handlers[ev] ||= []).push(cb);
    },
    on: (ev: string, cb: (d?: any) => void) => {
      (handlers[ev] ||= []).push(cb);
    },
    removeAllListeners: () => {
      for (const k of Object.keys(handlers)) delete handlers[k];
    },
    off: () => {},
    disconnect: () => {
      (handlers['disconnect'] || []).forEach((cb) => cb());
    },
    // helper used by tests to drive events
    __emit: (ev: string, data?: any) => {
      (handlers[ev] || []).forEach((cb) => cb(data));
    },
  };
  return socket;
}

let fakeSocket: ReturnType<typeof makeFakeSocket>;

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => {
    fakeSocket = makeFakeSocket();
    return fakeSocket;
  }),
  Socket: class {},
}));

import App from '../App';
import * as registryClient from '../api/registryClient';
import { AGENCY_IDS, AGENCIES } from '../components/analysts/agencies';

describe('App shell', () => {
  beforeEach(() => {
    fakeSocket = makeFakeSocket();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('renders the application shell (top-level ticker section)', () => {
    render(<App />);
    // The "TradingCorp" wordmark lives in the static index.html header; the
    // React app shell mounts the top-level ticker input section.
    expect(screen.getByTestId('ticker-section')).toBeInTheDocument();
  });

  it('renders the connection settings button', () => {
    render(<App />);
    expect(screen.getByTestId('open-connection-settings')).toBeInTheDocument();
  });

  it('shows a reports button', () => {
    render(<App />);
    expect(screen.getByTestId('reports-btn')).toBeInTheDocument();
  });

  it('auto-connects and flips the indicator to Connected', async () => {
    render(<App />);
    // Before connect, the indicator shows the connecting state.
    expect(screen.getByText(/Connecting/)).toBeInTheDocument();
    await act(async () => {
      fakeSocket.__emit('connect');
    });
    // onConnect fires synchronously on the 'connect' event.
    expect(screen.getByText(/Connected/)).toBeInTheDocument();
  });

  it('flips to DISCONNECTED (red) when the backend stops', async () => {
    render(<App />);
    await act(async () => {
      fakeSocket.__emit('connect');
    });
    expect(screen.getByText(/Connected/)).toBeInTheDocument();
    // Backend killed → socket.io emits 'disconnect'.
    await act(async () => {
      fakeSocket.__emit('disconnect');
    });
    const badge = screen.getByTestId('conn-status');
    expect(badge).toHaveTextContent(/Disconnected/);
    expect(badge).toHaveAttribute('data-state', 'disconnected');
    // Red/offline styling — NOT the green 'online' class.
    expect(badge.className).toContain('offline');
    expect(badge.className).not.toContain('online');
  });

  it('flips to DISCONNECTED when the initial connect fails', async () => {
    render(<App />);
    await act(async () => {
      fakeSocket.__emit('connect_error', new Error('server down'));
    });
    const badge = screen.getByTestId('conn-status');
    expect(badge).toHaveTextContent(/Disconnected/);
    expect(badge).toHaveAttribute('data-state', 'disconnected');
  });

  it('reconnects to green after a disconnect once the server returns', async () => {
    render(<App />);
    await act(async () => {
      fakeSocket.__emit('connect');
    });
    await act(async () => {
      fakeSocket.__emit('disconnect');
    });
    expect(screen.getByTestId('conn-status')).toHaveAttribute('data-state', 'disconnected');
    // Server comes back → socket.io reconnects → chip is green again.
    await act(async () => {
      fakeSocket.__emit('connect');
    });
    expect(screen.getByTestId('conn-status')).toHaveAttribute('data-state', 'connected');
  });

  it('renders a status indicator', () => {
    render(<App />);
    expect(screen.getByText(/Connecting|Connected/)).toBeInTheDocument();
  });

  it('loads the registry on mount so custom agencies appear in the dropdown without opening Settings', async () => {
    const getRegistry = vi
      .spyOn(registryClient, 'getRegistry')
      .mockResolvedValue({
        catalog: [],
        // Compiled defaults + a custom agency the user created earlier.
        agencies: [
          { id: 'long-term', name: 'Long Term', analystCount: 5, analysts: ['orchestrator'] },
          { id: 'short-term', name: 'Short Term', analystCount: 5, analysts: ['orchestrator'] },
          { id: 'crypto-screener', name: 'Crypto Screener', analystCount: 5, analysts: ['orchestrator'] },
          { id: 'my-wheel', name: 'My Wheel with new Analyst', analystCount: 1, analysts: ['orchestrator'] },
        ],
      } as any);
    render(<App />);
    // Flush the mount-time fetch (fake timers freeze polling, so drive it via act).
    await act(async () => {
      await Promise.resolve();
    });
    expect(getRegistry).toHaveBeenCalled();
    expect(AGENCY_IDS).toContain('my-wheel');
    expect(AGENCIES['my-wheel']?.name).toBe('My Wheel with new Analyst');
  });
});
