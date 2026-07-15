// src/utils/retry-handler.ts
// Retry and fallback strategies for the financial analysis pipeline
// Enhances patterns seen in the TradingAgents implementation

/**
 * Configuration for retry behavior
 */
export interface RetryConfig {
  /** Maximum number of retry attempts */
  maxAttempts: number;
  
  /** Base delay in milliseconds for exponential backoff */
  baseDelayMs: number;
  
  /** Maximum delay in milliseconds */
  maxDelayMs: number;
  
  /** Whether to jitter the delay to prevent thundering herd */
  jitter: boolean;
  
  /** Specific error messages that should trigger a retry */
  retryableErrors: string[];
  
  /** Whether to enable circuit breaker pattern */
  circuitBreakerEnabled: boolean;
  
  /** Failure threshold for circuit breaker */
  failureThreshold: number;
  
  /** Timeout for circuit breaker in seconds */
  timeoutSeconds: number;
}

/**
 * Circuit breaker state
 */
interface CircuitBreakerState {
  /** Number of consecutive failures */
  failureCount: number;
  
  /** Last failure timestamp */
  lastFailureTime: number;
  
  /** Whether the circuit is currently open */
  isOpen: boolean;
  
  /** Next attempt allowed timestamp */
  nextAttemptTime: number;
}

/**
 * Retry handler with exponential backoff and circuit breaker pattern
 */
export class RetryHandler {
  private config: RetryConfig;
  private circuitBreakers: Map<string, CircuitBreakerState>;
  
  constructor(config: Partial<RetryConfig> = {}) {
    // Default configuration
    this.config = {
      maxAttempts: 3,
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      jitter: true,
      retryableErrors: [
        'NETWORK_ERROR',
        'TIMEOUT',
        'RATE_LIMIT_EXCEEDED',
        'SERVICE_UNAVAILABLE',
        'INTERNAL_SERVER_ERROR',
        'ECONNRESET',
        'ETIMEDOUT'
      ],
      circuitBreakerEnabled: true,
      failureThreshold: 5,
      timeoutSeconds: 60
    };
    
    // Merge with provided config
    Object.assign(this.config, config);
    
    // Initialize circuit breakers map
    this.circuitBreakers = new Map();
  }
  
  /**
   * Execute an operation with retry logic
   * @param operation - Async function to execute
   * @param operationName - Name for circuit breaker tracking
   * @param context - Optional context for logging
   * @returns Promise resolving to operation result
   */
  async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    context?: Record<string, any>
  ): Promise<T> {
    // Check circuit breaker
    if (this.isCircuitOpen(operationName)) {
      throw new Error(`Circuit breaker OPEN for ${operationName}. Too many failures.`);
    }
    
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt < this.config.maxAttempts; attempt++) {
      try {
        const result = await operation();
        
        // Success - reset failure count for this operation
        this.onSuccess(operationName);
        
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        // Check if we should retry this error
        if (!this.shouldRetryError(lastError, attempt)) {
          // Don't retry, break immediately
          break;
        }
        
        // If this isn't the last attempt, wait before retrying
        if (attempt < this.config.maxAttempts - 1) {
          const delay = this.calculateDelay(attempt);
          await this.delay(delay);
        }
      }
    }
    
    // All retries exhausted - handle failure
    this.onFailure(operationName);
    
    // Throw the last error
    throw lastError;
  }
  
  /**
   * Determine if an error should trigger a retry
   */
  private shouldRetryError(error: Error, attemptNumber: number): boolean {
    // Don't retry if we've exhausted attempts
    if (attemptNumber >= this.config.maxAttempts - 1) {
      return false;
    }
    
    // Check if error message matches any retryable patterns
    const errorMessage = error.message.toUpperCase();
    return this.config.retryableErrors.some(pattern => 
      errorMessage.includes(pattern)
    );
  }
  
  /**
   * Calculate delay for exponential backoff with optional jitter
   */
  private calculateDelay(attemptNumber: number): number {
    // Exponential backoff: baseDelay * 2^attempt
    let delay = this.config.baseDelayMs * Math.pow(2, attemptNumber);
    
    // Apply maximum delay cap
    delay = Math.min(delay, this.config.maxDelayMs);
    
    // Add jitter if enabled (±25%)
    if (this.config.jitter) {
      const jitterAmount = delay * 0.25;
      const jitter = (Math.random() * 2 - 1) * jitterAmount; // -1 to 1 range
      delay += jitter;
    }
    
    return Math.max(0, delay);
  }
  
  /**
   * Pause execution for specified milliseconds
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Handle successful operation - reset failure count
   */
  private onSuccess(operationName: string): void {
    const breaker = this.circuitBreakers.get(operationName);
    if (breaker) {
      breaker.failureCount = 0;
      breaker.lastFailureTime = Date.now();
    }
  }
  
  /**
   * Handle failed operation - increment failure count
   */
  private onFailure(operationName: string): void {
    const now = Date.now();
    const breaker = this.circuitBreakers.get(operationName) || {
      failureCount: 0,
      lastFailureTime: 0,
      isOpen: false,
      nextAttemptTime: 0
    };
    
    breaker.failureCount++;
    breaker.lastFailureTime = now;
    
    // Check if we should open the circuit
    if (breaker.failureCount >= this.config.failureThreshold) {
      breaker.isOpen = true;
      breaker.nextAttemptTime = now + (this.config.timeoutSeconds * 1000);
    }
    
    this.circuitBreakers.set(operationName, breaker);
  }
  
  /**
   * Check if circuit breaker is open for an operation
   */
  private isCircuitOpen(operationName: string): boolean {
    if (!this.config.circuitBreakerEnabled) {
      return false;
    }
    
    const breaker = this.circuitBreakers.get(operationName);
    if (!breaker) {
      return false;
    }
    
    // If circuit is open, check if timeout has expired
    if (breaker.isOpen) {
      const now = Date.now();
      if (now >= breaker.nextAttemptTime) {
        // Half-open state: allow one test request
        breaker.isOpen = false;
        this.circuitBreakers.set(operationName, breaker);
        return false;
      }
      return true;
    }
    
    return false;
  }
  
  /**
   * Manually reset a circuit breaker
   */
  public resetCircuitBreaker(operationName: string): void {
    this.circuitBreakers.delete(operationName);
  }
  
  /**
   * Get current circuit breaker state for monitoring
   */
  public getCircuitBreakerState(operationName: string): CircuitBreakerState | undefined {
    return this.circuitBreakers.get(operationName);
  }
}

/**
 * Specialized retry handler for data ingestion operations
 */
export class DataIngestionRetryHandler extends RetryHandler {
  constructor() {
    super({
      maxAttempts: 3,
      baseDelayMs: 2000, // Longer initial delay for data services
      maxDelayMs: 30000,
      jitter: true,
      retryableErrors: [
        'NETWORK_ERROR',
        'TIMEOUT',
        'RATE_LIMIT_EXCEEDED',
        'SERVICE_UNAVAILABLE',
        'INTERNAL_SERVER_ERROR',
        'ECONNRESET',
        'ETIMEDOUT',
        'API_KEY_INVALID',
        'QUOTA_EXCEEDED'
      ],
      circuitBreakerEnabled: true,
      failureThreshold: 5,
      timeoutSeconds: 120 // Longer timeout for data services
    });
  }
  
  /**
   * Execute data ingestion with fallback to cached data
   */
  async executeWithFallback<T>(
    primaryOperation: () => Promise<T>,
    fallbackOperation: () => Promise<T | null>,
    operationName: string,
    context?: Record<string, any>
  ): Promise<T> {
    try {
      // Try primary operation with retry
      return await this.executeWithRetry(primaryOperation, operationName, context);
    } catch (primaryError) {
      console.warn(`Primary operation failed for ${operationName}:`, primaryError);
      
      // Try fallback operation
      try {
        const fallbackResult = await fallbackOperation();
        if (fallbackResult !== null) {
          console.log(`Using fallback data for ${operationName}`);
          return fallbackResult;
        }
      } catch (fallbackError) {
        console.error(`Fallback operation also failed for ${operationName}:`, fallbackError);
      }
      
      // If both fail, throw the original error
      throw primaryError;
    }
  }
}

/**
 * Specialized retry handler for analysis operations
 */
export class AnalysisRetryHandler extends RetryHandler {
  constructor() {
    super({
      maxAttempts: 2, // Fewer attempts for CPU-bound operations
      baseDelayMs: 500,
      maxDelayMs: 5000,
      jitter: false, // Less jitter for predictable timing
      retryableErrors: [
        'TIMEOUT',
        'MEMORY_ERROR',
        'PROCESSING_ERROR'
      ],
      circuitBreakerEnabled: true,
      failureThreshold: 3,
      timeoutSeconds: 30
    });
  }
  
  /**
   * Execute analysis with graceful degradation
   */
  async executeWithDegradation<T>(
    primaryOperation: () => Promise<T>,
    degradedOperation: () => Promise<T>,
    operationName: string,
    context?: Record<string, any>
  ): Promise<T> {
    try {
      // Try full analysis
      return await this.executeWithRetry(primaryOperation, operationName, context);
    } catch (error) {
      console.warn(`Primary analysis failed for ${operationName}:`, error);
      
      try {
        // Try degraded/faster analysis
        console.log(`Attempting degraded analysis for ${operationName}`);
        return await this.executeWithRetry(degradedOperation, `${operationName}_degraded`, context);
      } catch (degradedError) {
        console.error(`Degraded analysis also failed for ${operationName}:`, degradedError);
        
        // Return minimal viable result as last resort
        throw new Error(`Analysis failed for ${operationName}: ${(error as Error).message}`);
      }
    }
  }
}

// Export singleton instances
export const retryHandler = new RetryHandler();
export const dataIngestionRetryHandler = new DataIngestionRetryHandler();
export const analysisRetryHandler = new AnalysisRetryHandler();