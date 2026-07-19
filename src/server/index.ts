// src/server/index.ts
// Socket.io server for real-time streaming of agent reasoning

import http from 'http';
import path from 'path';
import fs from 'fs';
import { Server, Socket } from 'socket.io';
import express from 'express';
import { AgencyGraph } from '../orchestration/agency-graph';
import { AGENCIES } from '../registry/agencies';
import { ANALYST_DEFS } from '../registry/analysts';
import { logger } from '../utils/logger';
import { config } from '../config';
import { AgentState } from '../types/financial-analysis';
import { connectionConfigStore, ConnectionConfigStore } from './connection-config';
import { registerConfigRoutes } from './config-routes';
import { analystConfigStore, AnalystConfigStore } from './analyst-config';
import { registerAnalystConfigRoutes } from './analyst-config-routes';
import { domainSourceConfigStore } from './domain-source-config';
import { registerDomainSourceRoutes } from './domain-source-routes';
import { analystParamsStore } from './analyst-params';
import { registerAnalystParamsRoutes } from './analyst-params-routes';
import { analystFlavorStore } from './analyst-flavors';
import { registerAnalystFlavorsRoutes } from './analyst-flavors-routes';
import { llmConfigStore, resolveModelRole, vaultHealth } from './llm-config';
import { registerLlmConfigRoutes } from './llm-config-routes';
import { registerQuoteRoutes } from './quote-routes';
import { registerSymbolRoutes } from './symbol-routes';
import { makeYahooFundFetch } from './quote';
import { registerHistoryRoutes } from './history-routes';
import { registerOptionsHistoryRoutes } from './options-history-routes';
import { appendDecision, type DecisionRecord } from './decision-log';
import { registerOptionsDebugRoutes } from './options-debug-routes';
import { registerServerLogRoutes } from './server-log-routes';
import { registerReportRoutes } from './report-routes';
import { registerRegistryRoutes } from './registry-routes';
import { registerApiDocsRoutes } from './api-docs-routes';
import { registerNewsRoutes } from './news-routes';
import { registerScreenerRoutes } from './screener-routes';
import { buildThesisSummary } from './thesis-summary';
import { shouldShowMockDisabledBanner } from '../registry/logic/mockMode';

/**
 * Socket.IO server for real-time financial analysis updates
 */

// ---- Phase 2 decision-log capture helpers (pure; used by captureDecision) ----

/** Current ingested price per ticker, taken from the last close of the first
 *  interval series in state.ingested.bars. Absent on the seeded parity path. */
function extractCurrentPrices(state: AgentState): Record<string, number> {
  const out: Record<string, number> = {};
  const bars = (state as any).ingested?.bars;
  if (!bars || typeof bars !== 'object') return out;
  for (const [ticker, series] of Object.entries(bars as Record<string, any[]>)) {
    if (!Array.isArray(series) || series.length === 0) continue;
    const last = series[series.length - 1];
    const close = last?.close ?? last?.c;
    if (typeof close === 'number') out[ticker] = close;
  }
  return out;
}

/** Per-analyst verdicts at decision time from the analyst traces. */
function extractVerdicts(state: AgentState): { fundamental?: string; technical?: string; sentiment?: string } {
  const out: { fundamental?: string; technical?: string; sentiment?: string } = {};
  for (const t of (state.analystTraces as any[]) ?? []) {
    if (t?.analyst === 'fundamental' || t?.analyst === 'technical' || t?.analyst === 'sentiment') {
      (out as any)[t.analyst] = t?.output?.verdict;
    }
  }
  return out;
}

/** Net Bull/Bear debate lean from the governance trace, if the debate ran. */
function extractDebateLean(state: AgentState): 'BULLISH' | 'BEARISH' | 'BALANCED' | null {
  for (const t of (state.analystTraces as any[]) ?? []) {
    if (t?.analyst === 'governance') {
      const lean = t?.output?.details?.debate?.netLean;
      if (lean === 'BULLISH' || lean === 'BEARISH' || lean === 'BALANCED') return lean;
    }
  }
  return null;
}

class AnalysisServer {
  private app: express.Express;
  private server: http.Server;
  private io: Server;
  // The single runtime is the data-driven AgencyGraph, built per agency from
  // the registry and cached by agencyId, so the same server can run different
  // agencies (e.g. long-term vs the 4-node crypto-screener) without a restart.
  // The legacy hardcoded graph has been retired (see orchestration/financial-graph.ts).
  private readonly graphCache = new Map<string, { execute(initialState: AgentState): Promise<AgentState> }>();

  private getGraph(agencyId: string, sessionId = 'default'): { execute(initialState: AgentState): Promise<AgentState> } {
    const baseId = AGENCIES[agencyId] ? agencyId : (AGENCIES[config.agencyId] ? config.agencyId : 'long-term');
    // Base graph (no overrides) is cached by agency id. When the session has
    // saved weight overrides we build a fresh graph from a merged clone so the
    // next run reflects them. Single-tenant demo scale, so per-request builds
    // only happen when the user has actually saved config.
    if (sessionId === 'default' && !this.hasSavedParams(baseId, sessionId) && !this.hasSavedFlavors(baseId, sessionId)) {
      const cached = this.graphCache.get(baseId);
      if (cached) return cached;
    }
    const agency = this.mergeSavedParams(AGENCIES[baseId]!, sessionId);
    const agencyWithFlavors = this.mergeFlavors(agency, sessionId);
    // Parallel execution is a per-session setting (default true → analysts
    // run concurrently after data ingestion; falls back to serial when the
    // agency has live stage-2 sources or canRunParallel() says no). Read it
    // from the connection config so the user toggles it in the
    // Settings → Connection tab.
    const parallel = connectionConfigStore.get(sessionId).parallelAnalysts === true;
    const graph = new AgencyGraph(agencyWithFlavors, { parallel });
    if (sessionId === 'default' && agency === AGENCIES[baseId]) {
      this.graphCache.set(baseId, graph);
    }
    return graph;
  }

  /** True if any analyst in the agency has saved params for this session. */
  private hasSavedParams(agencyId: string, sessionId: string): boolean {
    const agency = AGENCIES[agencyId];
    if (!agency) return false;
    return agency.analysts.some((a) => analystParamsStore.has({ sessionId, agencyId, analystId: a.id }));
  }

  /**
   * Return a deep-ish clone of the agency def with saved weight overrides
   * merged into each analyst ref's `params`. When nothing is saved for the
   * session, returns the SAME agency object (so the cached base graph is used).
   */
  private mergeSavedParams(agency: typeof AGENCIES[string], sessionId: string): typeof AGENCIES[string] {
    let changed = false;
    const analysts = agency.analysts.map((ref) => {
      const saved = analystParamsStore.get({ sessionId, agencyId: agency.id, analystId: ref.id });
      if (!saved || Object.keys(saved).length === 0) return ref;
      changed = true;
      const merged = { ...(ref.params ?? {}) } as Record<string, any>;
      for (const [k, v] of Object.entries(saved)) merged[k] = v;
      return { ...ref, params: merged };
    });
    if (!changed) return agency;
    return { ...agency, analysts };
  }

  /** True if any analyst in the agency has a saved flavor set for this session. */
  private hasSavedFlavors(agencyId: string, sessionId: string): boolean {
    const agency = AGENCIES[agencyId];
    if (!agency) return false;
    return agency.analysts.some((a) => analystFlavorStore.has({ sessionId, agencyId, analystId: a.id }));
  }

  /**
   * Return a deep-ish clone of the agency def with each analyst ref's
   * `prompt`/`role`/`flavorId` overridden by the user's SELECTED flavor (from
   * AnalystFlavorStore). When nothing is saved for the session, returns the
   * SAME agency object (so the cached base graph is used and long-term parity
   * is preserved — no flavor = legacy prompt, no LLM step).
   */
  private mergeFlavors(
    agency: typeof AGENCIES[string],
    sessionId: string,
  ): typeof AGENCIES[string] {
    let changed = false;
    const analysts = agency.analysts.map((ref) => {
      const saved = analystFlavorStore.get({ sessionId, agencyId: agency.id, analystId: ref.id });
      if (!saved || saved.flavors.length === 0) return ref;
      const selected = saved.flavors.find((f) => f.id === saved.selectedId) ?? saved.flavors[0]!;
      if (!selected) return ref;
      changed = true;
      // §12.4 resolution: flavor.modelRole → agency override → def default → deep-thought.
      const agencyRole = llmConfigStore.getAgencyModelRole(sessionId, agency.id);
      const resolvedRole = resolveModelRole(selected.modelRole, agencyRole, undefined);
      // §10.7 opt-in: the selected flavor may enable the LLM step. We flip the
      // per-run clone's `logic.llm.enabled` ONLY here (never the shipped base
      // def), so the long-term parity guard stays intact until the user picks a
      // flavor with `enabled:true`. Merge logic from the BASE def so mode/fn/
      // features are preserved (the ref's logic may only carry `llm`), then
      // overlay the ref's logic, then flip llm.enabled from the flavor.
      const baseLogic = ANALYST_DEFS[ref.id]?.logic ?? {};
      const mergedLogic: typeof ref.logic = {
        ...baseLogic,
        ...(ref.logic ?? {}),
        llm: {
          ...(baseLogic.llm ?? {}),
          ...(ref.logic?.llm ?? {}),
          enabled: selected.enabled === true,
        },
      };
      logger.debug(
        `mergeFlavors ${agency.id}/${ref.id}: flavor=${selected.id} ` +
          `llm.enabled=${selected.enabled === true} role=${resolvedRole}`,
      );
      return {
        ...ref,
        prompt: selected.instructions,
        role: selected.role || ref.role,
        flavorId: selected.id,
        modelRole: resolvedRole,
        logic: mergedLogic,
      } as typeof ref;
    });
    // Also need to rebuild the graph if a flavor is selected for any analyst.
    if (!changed) return agency;
    return { ...agency, analysts };
  }

  constructor() {
    // Initialize Express app
    this.app = express();
    
    // Create HTTP server
    this.server = http.createServer(this.app);
    
    // Initialize Socket.IO server
    this.io = new Server(this.server, config.socket);
    
    // Initialize the analysis graph based on the configured mode.
    // The single runtime is the data-driven AgencyGraph built from the
    // registry. Warm the default agency graph so the first request is instant.
    this.getGraph(config.agencyId);
    logger.info(`Graph mode: AGENCY (data-driven, default=${config.agencyId})`);
    
    // Set up routes and middleware
    this.setupMiddleware();
    this.setupRoutes();
    this.setupSocketHandlers();
    
    logger.info('Analysis server initialized');
  }
  
  /**
   * Set up Express middleware
   */
  private setupMiddleware(): void {
    // Parse JSON bodies. Limit raised from the 100KB default: the POST /reports
    // payload is the entire final AgentState (raw-data channels + full LLM
    // message traces), which easily exceeds 100KB for a long-term/LLM run.
    this.app.use(express.json({ limit: '25mb' }));

    // Serve the built Vite SPA (frontend/dist) if it exists. The directory is
    // produced by `npm run build` (vite build). When running the backend
    // standalone without a frontend build, this is a no-op rather than a crash.
    const frontendDist = path.join(__dirname, '..', '..', 'frontend', 'dist');
    if (fs.existsSync(frontendDist)) {
      this.app.use(express.static(frontendDist));
    }
  }
  
  /**
   * Set up REST API routes
   */
  private setupRoutes(): void {
    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
    });
    
    // Configuration endpoints (static GET + runtime POST / Option B).
    // Registered via the shared helper so they're unit-testable without
    // booting the full Socket.IO server.
    registerConfigRoutes(this.app, connectionConfigStore);

    // Per-analyst / per-source credentials (B1). The Settings dialog POSTs a
    // distinct token per analyst source here; stored server-side, never echoed.
    registerAnalystConfigRoutes(this.app, analystConfigStore);
    // P3b — swappable per-domain source mapping (set from the Settings UI; the
    // engine reads it via resolveDomain -> DomainSourceConfigStore).
    registerDomainSourceRoutes(this.app, domainSourceConfigStore);

    // Per-analyst tunable WEIGHTS (per-card Settings panel). Saved weight
    // overrides are merged into the agency graph at request time; stored
    // server-side, never echoed.
    registerAnalystParamsRoutes(this.app, analystParamsStore);
    registerAnalystFlavorsRoutes(this.app, analystFlavorStore);
    registerLlmConfigRoutes(this.app, llmConfigStore);
    registerQuoteRoutes(this.app, undefined, makeYahooFundFetch());
    // Ticker-symbol validation (server-side, shared with the orchestrator). The
    // frontend calls this instead of validating in the browser because the symbol
    // API is not CORS-accessible from the client.
    registerSymbolRoutes(this.app);
    registerHistoryRoutes(this.app);
    registerOptionsHistoryRoutes(this.app);
    registerOptionsDebugRoutes(this.app);
    registerServerLogRoutes(this.app);
    registerReportRoutes(this.app);
    registerRegistryRoutes(this.app);
    registerApiDocsRoutes(this.app);
    registerNewsRoutes(this.app);
    registerScreenerRoutes(this.app);
  }

  /**
   * Set up Socket.IO connection handlers
   */
  private setupSocketHandlers(): void {
    this.io.on('connection', (socket: Socket) => {
      logger.info(`Client connected: ${socket.id}`);
      
      // Send welcome message
      socket.emit('welcome', {
        message: 'Connected to TradingCorp',
        serverId: socket.id,
        timestamp: new Date().toISOString()
      });
      
      // Handle analysis request from client
      socket.on('request_analysis', async (data: { tickers: string[]; options?: any; sessionId?: string }) => {
        await this.handleAnalysisRequest(socket, data);
      });
      
      // Handle client disconnection
      socket.on('disconnect', (reason: string) => {
        logger.info(`Client disconnected: ${socket.id}, reason: ${reason}`);
      });
      
      // Handle errors
      socket.on('error', (error: Error) => {
        logger.error(`Socket error: ${error.message}`, error);
      });
    });
  }
  
  /**
   * Handle an analysis request from the frontend
   * @param socket - Socket connection
   * @param data - Request data containing tickers and options
   */
  private async handleAnalysisRequest(
    socket: Socket, 
    data: { tickers: string[]; options?: any; sessionId?: string; agencyId?: string }
  ): Promise<void> {
    const { tickers, options = {}, sessionId, agencyId } = data;
    
    // Resolve the agency to run. The client may request a specific agency
    // (e.g. the 4-node crypto-screener) via agencyId; otherwise fall back to
    // the server-configured default. Graphs are cached per agency id so we
    // don't rebuild the LangGraph StateGraph on every request.
    const requestedAgencyId = agencyId || config.agencyId;
    const agency = AGENCIES[requestedAgencyId] || AGENCIES[config.agencyId]!;
    // Read the runtime connection config (Option B) for this session. The
    // Settings dialog POSTed it to /config earlier; if absent we fall back to
    // the default/server config. The token is available here for upstream
    // data-source calls but is never echoed back to the client.
    const activeSession = sessionId || 'default';
    const runtimeConfig = connectionConfigStore.get(activeSession);
    if (connectionConfigStore.has(activeSession)) {
      logger.info(
        `Analysis for session ${activeSession} using baseUri=${runtimeConfig.baseUri}` +
          ` (token=${runtimeConfig.accessToken ? 'set' : 'unset'})`
      );
    }
    
    // Validate input
    if (!tickers || tickers.length === 0) {
      socket.emit('analysis_error', {
        error: 'No ticker symbols provided'
      });
      return;
    }
    
    try {
      logger.info(`Starting analysis for tickers: ${tickers.join(', ')}`);
      
      // Emit analysis start event
      socket.emit('analysis_start', {
        tickers,
        agencyId: requestedAgencyId,
        timestamp: new Date().toISOString(),
        message: 'Starting financial analysis...'
      });
      
      // Prepare initial state for the workflow. Inject a progress reporter that
      // forwards per-analyst graph events to this socket so the AnalystWall
      // lights up as each analyst actually runs (real streaming, not a mock).
      const progress = {
        emit(event: string, payload: any) {
          if (event === 'analyst:start') {
            socket.emit('analyst_start', payload);
          } else if (event === 'analyst:done') {
            socket.emit('analyst_done', payload);
          }
        },
      };

      const initialState: AgentState = {
        messages: [],
        current_date: new Date().toISOString().split('T')[0]!,
        tickers,
        company_name: tickers.join(', '),
        investment_thesis: '',
        final_decision: '',
        error: null,
        current_step: 'initializing',
        progress,
        // Surface the runtime config (Option B) to the graph. The token stays
        // server-side; it is never included in the emitted result.
        runtimeConfig: connectionConfigStore.has(activeSession)
          ? runtimeConfig
          : undefined
      };
      
      // Execute the analysis workflow
      // Build (or fetch cached) graph with this session's saved weight overrides.
      const result = await this.getGraph(requestedAgencyId, activeSession).execute(initialState);

      // Emit final result. The raw AgentState only carries `final_decision`
      // (a string) + `messages`; the rich InvestmentDecision
      // (decision/confidence/reasoning/...) is nested inside the last
      // governance system message's `data.overallDecision`. Normalize so the
      // front-ends get the flat fields they render.
      const normalized = this.normalizeResult(result);
      socket.emit('analysis_complete', {
        ...result,
        ...normalized,
        // Honest signal: only claim "no live source" when mock data is globally
        // disabled AND the run genuinely acquired ZERO live sources. If any
        // source came back ok/fallback (dataHealth.sourcesOk > 0), the outputs
        // are real — suppress the banner (it was previously firing on the env
        // flag alone, contradicting an all-OK Data Ingestion strip).
        mockDisabled: shouldShowMockDisabledBanner(normalized.dataHealth),
        timestamp: new Date().toISOString()
      });

      // Phase 2: persist a decision record (best-effort — a log write failure
      // must NEVER break the run). Gated by DECISION_LOG_ENABLED (default ON).
      if (process.env.DECISION_LOG_ENABLED !== 'false') {
        try {
          const prices = extractCurrentPrices(result);
          const record: DecisionRecord = {
            ts: new Date().toISOString(),
            tickers,
            agencyId: requestedAgencyId,
            decision: normalized.decision === 'APPROVE' || normalized.decision === 'REJECT' ? normalized.decision : 'ERROR',
            confidence: typeof normalized.confidence === 'number' ? normalized.confidence : null,
            debateLean: extractDebateLean(result) ?? undefined,
            verdicts: extractVerdicts(result),
            prices: Object.keys(prices).length ? prices : undefined,
          };
          appendDecision(record);
        } catch (logErr) {
          logger.warn(`Decision log write failed (non-fatal): ${logErr instanceof Error ? logErr.message : String(logErr)}`);
        }
      }

      // Self-documenting diagnostic (debug-level: off unless LOG_LEVEL=DEBUG).
      // Proves at a glance whether the banner is correct or whether the running
      // process is stale code. If sourcesOk>0 yet mockDisabled=true, the server
      // is NOT running the patched emit path.
      logger.debug(
        `[mockDisabled gate] mockDisabled=${shouldShowMockDisabledBanner(normalized.dataHealth)} ` +
          `sourcesOk=${normalized.dataHealth?.sourcesOk ?? 0} ` +
          `sourcesTotal=${normalized.dataHealth?.sourcesTotal ?? 0} ` +
          `tickers=${tickers.join(',')}`,
      );
      
      logger.info(`Analysis completed for tickers: ${tickers.join(', ')}`);
    } catch (error) {
      // Emit error to client
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Analysis failed: ${errorMessage}`, error);
      
      socket.emit('analysis_error', {
        error: errorMessage,
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Normalize the raw AgentState into the flat fields the front-ends expect
   * (decision, confidence, reasoning, preservation_rationale, plus the
   * per-ticker detail objects). All optional with safe fallbacks so the UI
   * never renders "undefined".
   */
  private normalizeResult(state: AgentState): Record<string, any> {
    // The rich InvestmentDecision is nested in the last governance system
    // message: message.data.overallDecision
    const govMessages = (state.messages || []).filter(
      (m: any) => m && m.role === 'system' && m.data && m.data.overallDecision
    );
    const overall: any =
      govMessages.length > 0
        ? govMessages[govMessages.length - 1].data.overallDecision
        : null;

    const decisions: Record<string, any> = overall?.decisions || {};
    const riskAssessments: Record<string, any> = overall?.riskAssessments || {};

    let decision: 'APPROVE' | 'REJECT' | 'ERROR' = 'REJECT';
    if (overall?.decision === 'APPROVE' || overall?.decision === 'REJECT') {
      decision = overall.decision;
    } else if (state.final_decision && state.final_decision.startsWith('ERROR')) {
      decision = 'ERROR';
    }

    const reasoning: string =
      overall?.reasoning ?? state.final_decision ?? 'No reasoning provided';

    // Phase B: structured, scannable thesis summary derived from the real
    // per-analyst traces (so the frontend need not re-derive it). Additive —
    // absent in legacy payloads, so the client falls back to building rows from
    // analystTraces (Phase A) or the raw investment_thesis string (parity).
    const thesisSummary = buildThesisSummary(state, decision, overall?.confidence ?? null, reasoning);

    return {
      decision,
      confidence: overall?.confidence ?? null,
      reasoning,
      preservation_rationale: overall?.preservation_rationale ?? null,
      conditions: overall?.conditions ?? [],
      company_name: state.company_name,
      investment_thesis: state.investment_thesis,
      error: state.error ?? null,
      fundamental_analysis: null,
      technical_analysis: null,
      sentiment_analysis: null,
      risk_assessment: Object.keys(riskAssessments).length > 0 ? riskAssessments : null,
      decisions,
      riskAssessments,
      // Structured per-analyst traces for client-side drill-down / traceability.
      // Each entry carries the instructions, the data/sources consumed, the
      // weighting steps, and the output — keyed by `analyst`.
      analystTraces: Array.isArray(state.analystTraces) ? state.analystTraces : [],
      // Phase B: scannable thesis grid (decision + per-analyst verdict/score).
      thesisSummary,
      // §4.9 pipeline-wide data-health summary (green/amber/red strip on the client).
      dataHealth: state.dataHealth ?? null,
    };
  }
  
  /**
   * Expose the underlying Express app (used by tests / supertest).
   */
  public getApp(): express.Express {
    return this.app;
  }

  /**
   * Start the server
   */
  public start(): void {
    this.server.listen(config.port, config.bindHost, () => {
      logger.info(`Server running on http://${config.host}:${config.port}`);
      // Surface LLM role token status at boot so a missing token is obvious.
      const status = llmConfigStore.status();
      for (const [role, s] of Object.entries(status)) {
        logger.info(
          `LLM role '${role}': provider=${s.provider} model=${s.model} ` +
            `token=${s.configured ? 'SET (will call provider)' : 'MISSING (fallback)'}`,
        );
      }
      // Surface vault health — a wrong passphrase silently drops all tokens.
      const vh = vaultHealth();
      if (vh.unreadable) {
        logger.error(`LLM vault UNREADABLE (${vh.kind}): ${vh.unreadable} — tokens dropped; re-save in the LLM Models tab to re-key.`);
      } else {
        logger.info(`LLM vault OK (${vh.kind})`);
      }
    });
  }
  
  /**
   * Stop the server
   */
  public stop(): void {
    this.server.close(() => {
      logger.info('Server stopped');
    });
  }
}

// Create and start the server (only when run directly, not when imported by tests)
const server = new AnalysisServer();
if (require.main === module) {
  server.start();
}

// Export for potential use in tests or other modules
export default server;
export { AnalysisServer };

// Phase B: thesis summary builder (kept in its own module so it can be tested
// without the SQLite-backed server singletons). Re-exported here for callers
// that already import from the server module.
export { buildThesisSummary } from './thesis-summary';
export type { ThesisSummary, ThesisSummaryRow } from './thesis-summary';