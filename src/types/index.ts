/**
 * Core type definitions for QueueFlow
 */

// ============================================================================
// Enums
// ============================================================================

export enum JobPriority {
  HIGH = 'high',
  NORMAL = 'normal',
  LOW = 'low'
}

export enum JobStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  EXPIRED = 'expired'
}

export enum WorkerStatus {
  IDLE = 'idle',
  BUSY = 'busy',
  STOPPED = 'stopped',
  ERROR = 'error'
}

export enum ScalingStrategy {
  DEFAULT = 'default',
  AGGRESSIVE = 'aggressive',
  CONSERVATIVE = 'conservative',
  PREDICTIVE = 'predictive'
}

// ============================================================================
// Job Types
// ============================================================================

export interface JobOptions {
  priority?: JobPriority;
  maxRetries?: number;
  ttl?: number; // Time to live in milliseconds
  timeout?: number; // Job execution timeout in milliseconds
  deduplicationKey?: string; // For message deduplication
}

export interface Job<T = any> {
  id: string;
  type: string;
  payload: T;
  options: JobOptions;
  status: JobStatus;
  attempts: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  result?: any;
}

export interface JobMetadata {
  jobId: string;
  enqueuedAt: number;
  priority: JobPriority;
  attempts: number;
  lastAttemptAt?: number;
  nextRetryAt?: number;
}

export interface JobHandler<T = any, R = any> {
  (payload: T, job: Job<T>): Promise<R>;
}

// ============================================================================
// Worker Types
// ============================================================================

export interface WorkerConfig {
  id: string;
  concurrency: number;
  heartbeatInterval: number;
  jobTimeout: number;
}

export interface WorkerStats {
  id: string;
  status: WorkerStatus;
  processed: number;
  failed: number;
  successRate: number;
  uptime: number;
  currentJobs: number;
  lastHeartbeat: number;
  averageProcessingTime: number;
}

export interface WorkerPoolConfig {
  minWorkers: number;
  maxWorkers: number;
  workerConcurrency: number;
  heartbeatInterval: number;
  jobTimeout: number;
}

// ============================================================================
// Queue Types
// ============================================================================

export interface QueueConfig {
  redisHost: string;
  redisPort: number;
  redisPassword?: string;
  redisDb: number;
  keyPrefix: string;
  highPriorityWeight: number;
  normalPriorityWeight: number;
  lowPriorityWeight: number;
  defaultMaxRetries: number;
  dlqRetentionDays: number;
  batchSize: number;
}

export interface QueueMetrics {
  totalJobs: number;
  pendingJobs: number;
  processingJobs: number;
  completedJobs: number;
  failedJobs: number;
  dlqJobs: number;
  highPriorityJobs: number;
  normalPriorityJobs: number;
  lowPriorityJobs: number;
  averageProcessingTime: number;
  processingRate: number; // Jobs per second
  errorRate: number; // Percentage
}

// ============================================================================
// Auto-Scaler Types
// ============================================================================

export interface ScalingConfig {
  minWorkers: number;
  maxWorkers: number;
  scaleUpThreshold: number;
  scaleDownThreshold: number;
  cooldownPeriod: number;
  strategy: ScalingStrategy;
  enableKubernetes: boolean;
  enablePredictive: boolean;
}

export interface ScalingMetrics {
  queueDepth: number;
  processingRate: number;
  errorRate: number;
  activeWorkers: number;
  timestamp: number;
}

export interface ScalingDecision {
  action: 'scale_up' | 'scale_down' | 'none';
  targetWorkers: number;
  currentWorkers: number;
  reason: string;
  confidence?: number; // For predictive scaling
}

// ============================================================================
// Monitoring Types
// ============================================================================

export interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: number;
  checks: {
    redis: boolean;
    workers: boolean;
    queue: boolean;
    api: boolean;
  };
  details?: {
    redisLatency?: number;
    activeWorkers?: number;
    queueDepth?: number;
    healthyWorkers?: number;
    dlqDepth?: number;
    error?: string;
    [key: string]: any;
  };
}

export interface MetricsSnapshot {
  timestamp: number;
  queue: QueueMetrics;
  workers: WorkerStats[];
  scaling: {
    currentWorkers: number;
    targetWorkers: number;
    lastScalingAction?: string;
    lastScalingTime?: number;
  };
}

// ============================================================================
// API Types
// ============================================================================

export interface CreateJobRequest {
  type: string;
  payload: any;
  options?: JobOptions;
}

export interface CreateJobResponse {
  jobId: string;
  status: JobStatus;
  enqueuedAt: number;
}

export interface StatusResponse {
  status: string;
  timestamp: number;
  metrics: MetricsSnapshot;
  health: HealthCheckResult;
}

export interface ReprocessDLQRequest {
  jobIds?: string[]; // If not provided, reprocess all
  maxJobs?: number;
}

export interface ReprocessDLQResponse {
  reprocessed: number;
  failed: number;
  jobIds: string[];
}

export interface ScaleRequest {
  targetWorkers?: number;
  strategy?: ScalingStrategy;
}

export interface ScaleResponse {
  previousWorkers: number;
  currentWorkers: number;
  targetWorkers: number;
  action: string;
}

export interface CleanupRequest {
  removeExpired?: boolean;
  removeCompleted?: boolean;
  olderThan?: number; // Timestamp
}

export interface CleanupResponse {
  removed: number;
  types: {
    expired?: number;
    completed?: number;
  };
}

// ============================================================================
// Circuit Breaker Types
// ============================================================================

export interface CircuitBreakerConfig {
  threshold: number; // Number of failures before opening
  timeout: number; // Time to wait before trying again (ms)
  enabled: boolean;
}

export enum CircuitBreakerState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half_open'
}

// ============================================================================
// Redis Types
// ============================================================================

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db: number;
  keyPrefix: string;
  poolSize: number;
}

// ============================================================================
// WebSocket Types
// ============================================================================

export interface WebSocketMessage {
  type: 'metrics' | 'worker_update' | 'job_update' | 'scaling_event';
  timestamp: number;
  data: any;
}

export interface WebSocketConfig {
  port: number;
  path: string;
  heartbeatInterval: number;
}

// ============================================================================
// Logging Types
// ============================================================================

export interface LogContext {
  jobId?: string;
  workerId?: string;
  component?: string;
  [key: string]: any;
}

export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  DEBUG = 'debug'
}

// ============================================================================
// Error Types
// ============================================================================

export class QueueFlowError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: any
  ) {
    super(message);
    this.name = 'QueueFlowError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export class JobTimeoutError extends QueueFlowError {
  constructor(jobId: string, timeout: number) {
    super(
      `Job ${jobId} timed out after ${timeout}ms`,
      'JOB_TIMEOUT',
      { jobId, timeout }
    );
    this.name = 'JobTimeoutError';
  }
}

export class WorkerError extends QueueFlowError {
  constructor(workerId: string, message: string, details?: any) {
    super(message, 'WORKER_ERROR', { workerId, ...details });
    this.name = 'WorkerError';
  }
}

export class RedisConnectionError extends QueueFlowError {
  constructor(message: string, details?: any) {
    super(message, 'REDIS_CONNECTION_ERROR', details);
    this.name = 'RedisConnectionError';
  }
}
