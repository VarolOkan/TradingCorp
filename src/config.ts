// src/config.ts
// Configuration management for the financial analysis pipeline

import { config as dotenvConfig } from 'dotenv';
import path from 'path';

// Load environment variables from .env file
dotenvConfig({ path: path.resolve(process.cwd(), '.env') });

/**
 * Configuration object
 */
export const config = {
  // Server configuration
  port: parseInt(process.env.PORT || '3001', 10),
  // `host` is the *display* name for logs. The actual bind address is
  // `bindHost` (see below) — binding to a literal hostname that isn't
  // resolvable on the current machine makes `server.listen()` throw
  // ENOTFOUND (e.g. HOST=linux-1sou.AtHome on a different box). We default
  // the bind address to 0.0.0.0 (all interfaces) and only honor an explicit
  // HOST when it is a real IP / localhost / 0.0.0.0.
  host: process.env.HOST || 'localhost',
  bindHost: (() => {
    const h = process.env.HOST;
    // No HOST, or an explicit "all interfaces" value → bind all interfaces.
    if (!h || h === '0.0.0.0' || h === '::') return h || '0.0.0.0';
    // Explicit loopback → loopback only (opt-in "local machine only" mode).
    if (h === 'localhost' || h === '127.0.0.1') return '127.0.0.1';
    // A specific IP (e.g. 10.9.200.188) or a hostname: bind ALL interfaces
    // (0.0.0.0) rather than that address alone. Binding to a single IP makes
    // the server UNREACHABLE via localhost, which breaks the Vite dev proxy and
    // any same-machine client (both hit http://localhost:PORT). 0.0.0.0 covers
    // BOTH the given IP (LAN clients) AND localhost (proxy / same machine), and
    // also avoids ENOTFOUND when HOST is a non-resolvable hostname. The `host`
    // field above still shows the configured name in logs.
    return '0.0.0.0';
  })(),
  
  // Socket.io configuration
  // CORS allowed origins for the dev front-end. Defaults cover the common
  // dev ports; override with SOCKET_ORIGIN (comma-separated list, or '*').
  socket: {
    cors: {
      origin: process.env.SOCKET_ORIGIN
        ? process.env.SOCKET_ORIGIN === '*'
          ? '*'
          : process.env.SOCKET_ORIGIN.split(',').map((o) => o.trim())
        : ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:5173'],
      methods: ['GET', 'POST']
    }
  },
  
  // Analysis configuration
  analysis: {
    defaultDepth: process.env.DEFAULT_ANALYSIS_DEPTH || 'STANDARD',
    defaultTimeHorizon: process.env.DEFAULT_TIME_HORIZON || 'MEDIUM_TERM',
    defaultRiskTolerance: process.env.DEFAULT_RISK_TOLERANCE || 'MODERATE'
  },
  
  // Logging configuration
  logLevel: process.env.LOG_LEVEL || 'info',

  // Graph execution mode is always the data-driven AgencyGraph built from the
  // registry (the legacy hard-coded graph was retired). `agencyId` selects the
  // default agency; the long-term agency is its 1:1 successor.
  graphMode: 'agency' as const,

  // Default agency used by the server (the registry's long-term agency).
  agencyId: process.env.AGENCY_ID || 'long-term',
  
  // Data source configuration (for future implementation)
  dataSources: {
    alphaVantage: {
      apiKey: process.env.ALPHA_VANTAGE_API_KEY || ''
    },
    yahooFinance: {
      // No API key required for basic usage
    }
  }
};

export default config;