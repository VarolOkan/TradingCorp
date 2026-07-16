// src/server/socket.ts
// Socket.io server setup for real-time streaming of agent reasoning
// Designed to work with Next.js frontend

import { Server, Socket } from 'socket.io';
import { AgentState } from '../types/financial-analysis';
import { buildLegacyGraph } from '../orchestration/financial-graph';

/**
 * Socket.IO server for real-time financial analysis updates
 * Streams agent "thought processes" to the frontend
 */
class AnalysisSocketServer {
  private io: Server;
  private analysisGraph: { execute(initialState: AgentState): Promise<AgentState> };
  
  constructor(httpServer: any) {
    // Initialize Socket.IO server
    this.io = new Server(httpServer, {
      cors: {
        origin: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
        methods: ['GET', 'POST']
      }
    });
    
    // Initialize the analysis graph (data-driven long-term agency)
    this.analysisGraph = buildLegacyGraph();
    
    // Set up connection handlers
    this.setupConnectionHandlers();
  }
  
  /**
   * Set up socket connection event handlers
   */
  private setupConnectionHandlers(): void {
    this.io.on('connection', (socket: Socket) => {
      console.log('Client connected:', socket.id);
      
      // Handle analysis request from client
      socket.on('request_analysis', (data: { tickers: string[]; options?: any }) => {
        this.handleAnalysisRequest(socket, data);
      });
      
      // Handle client disconnection
      socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
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
    data: { tickers: string[]; options?: any }
  ): Promise<void> {
    const { tickers, options = {} } = data;
    
    // Validate input
    if (!tickers || tickers.length === 0) {
      socket.emit('analysis_error', {
        error: 'No ticker symbols provided'
      });
      return;
    }
    
    try {
      // Emit initial status
      socket.emit('analysis_start', {
        tickers,
        timestamp: new Date().toISOString(),
        message: 'Starting financial analysis...'
      });
      
      // Prepare initial state for the workflow
      const initialState: AgentState = {
        messages: [],
        current_date: new Date().toISOString().split('T')[0]!,
        tickers,
        company_name: tickers.join(', '),
        investment_thesis: '',
        final_decision: '',
        error: null,
        current_step: 'initializing'
      };
      
      // Execute the analysis workflow
      const result = await this.analysisGraph.execute(initialState);

      // Build a normalized payload the clients can render directly.
      // The raw AgentState only has `final_decision` (a string) + `messages`;
      // the rich InvestmentDecision (decision/confidence/reasoning/...) is
      // nested inside the last governance system message's `data.overallDecision`.
      const normalized = this.normalizeResult(result);

      // Emit final result
      socket.emit('analysis_complete', {
        ...result,
        ...normalized,
        // Honest signal: when mock data is globally disabled and the run had no
        // live sources, the output is empty (not fabricated). The UI shows a banner.
        mockDisabled: isMockDisabled(),
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      // Emit error to client
      socket.emit('analysis_error', {
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }
  
  /**
   * Emit progress updates during analysis
   * This would be called from within the agent nodes
   * @param socket - Socket connection
   * @param step - Current step in the workflow
   * @param data - Data to send with the update
   */
  public emitProgressUpdate(
    socket: Socket,
    step: string,
    data: any
  ): void {
    socket.emit('analysis_progress', {
      step,
      data,
      timestamp: new Date().toISOString()
    });
  }
  
  /**
   * Emit agent thinking/streaming updates
   * @param socket - Socket connection
   * @param agentName - Name of the agent
   * @param thought - Current thought or reasoning from the agent
   */
  public emitAgentThought(
    socket: Socket,
    agentName: string,
    thought: string
  ): void {
    socket.emit('agent_thought', {
      agent: agentName,
      thought,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Normalize the raw AgentState into the flat fields the front-ends expect
   * (decision, confidence, reasoning, preservation_rationale, plus the
   * per-analyst breakdown objects). Everything is optional with safe
   * fallbacks so the UI never renders "undefined".
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

    // Per-ticker decisions/risk assessments, keyed by ticker.
    const decisions: Record<string, any> = overall?.decisions || {};
    const riskAssessments: Record<string, any> = overall?.riskAssessments || {};

    // Determine the top-level decision. Prefer the structured decision; fall
    // back to the raw final_decision string (e.g. "ERROR: ...").
    let decision: 'APPROVE' | 'REJECT' | 'ERROR' = 'REJECT';
    if (overall?.decision === 'APPROVE' || overall?.decision === 'REJECT') {
      decision = overall.decision;
    } else if (state.final_decision && state.final_decision.startsWith('ERROR')) {
      decision = 'ERROR';
    }

    return {
      decision,                                   // APPROVE | REJECT | ERROR
      confidence: overall?.confidence ?? null,    // number | null
      reasoning: overall?.reasoning ?? state.final_decision ?? 'No reasoning provided',
      preservation_rationale: overall?.preservation_rationale ?? null,
      conditions: overall?.conditions ?? [],
      tickers: state.tickers,
      company_name: state.company_name,
      investment_thesis: state.investment_thesis,
      final_decision: state.final_decision,
      error: state.error ?? null,
      // Per-ticker detail objects the React page renders
      fundamental_analysis: null,
      technical_analysis: null,
      sentiment_analysis: null,
      risk_assessment: Object.keys(riskAssessments).length > 0 ? riskAssessments : null,
      decisions,
      riskAssessments,
      // §4.9 pipeline-wide data-health summary (client data-quality strip).
      dataHealth: state.dataHealth ?? null
    };
  }
  
  /**
   * Get the Socket.IO instance for external access
   */
  public getIO(): Server {
    return this.io;
  }
}

export default AnalysisSocketServer;