/**
 * Worker and WorkerPool Implementation
 * Handles concurrent job processing with timeout protection and health tracking
 */

import { EventEmitter } from 'events';
import {
  Job,
  JobHandler,
  WorkerConfig,
  WorkerStats,
  WorkerStatus,
  WorkerPoolConfig,
  JobTimeoutError,
  WorkerError
} from '../types';
import { QueueManager } from './queue-manager';
import { Logger } from '../utils/logger';

/**
 * Individual Worker class
 */
export class Worker extends EventEmitter {
  private config: WorkerConfig;
  private queueManager: QueueManager;
  private logger: Logger;
  private handlers: Map<string, JobHandler> = new Map();
  private status: WorkerStatus = WorkerStatus.IDLE;
  private currentJobs: Set<string> = new Set();
  private stats = {
    processed: 0,
    failed: 0,
    totalProcessingTime: 0,
    startTime: Date.now(),
    lastHeartbeat: Date.now()
  };
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private processingPromises: Set<Promise<void>> = new Set();

  constructor(
    config: WorkerConfig,
    queueManager: QueueManager
  ) {
    super();
    this.config = config;
    this.queueManager = queueManager;
    this.logger = Logger.forWorker(config.id);
  }

  /**
   * Register a job handler for a specific job type
   */
  public registerHandler<T = any, R = any>(
    jobType: string,
    handler: JobHandler<T, R>
  ): void {
    this.handlers.set(jobType, handler);
    this.logger.debug('Handler registered', { jobType });
  }

  /**
   * Start the worker
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Worker already running');
      return;
    }

    this.isRunning = true;
    this.status = WorkerStatus.IDLE;

    this.logger.info('Worker starting', {
      concurrency: this.config.concurrency,
      heartbeatInterval: this.config.heartbeatInterval
    });

    // Start heartbeat
    this.startHeartbeat();

    // Start processing loop
    this.processLoop();

    this.emit('started', this.config.id);
  }

  /**
   * Stop the worker gracefully
   */
  public async stop(timeout = 30000): Promise<void> {
    this.logger.info('Worker stopping...');
    this.isRunning = false;

    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Wait for current jobs to complete with timeout
    const shutdownPromise = Promise.all(Array.from(this.processingPromises));
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Shutdown timeout')), timeout)
    );

    try {
      await Promise.race([shutdownPromise, timeoutPromise]);
      this.logger.info('Worker stopped gracefully');
    } catch (error) {
      this.logger.warn('Worker stopped with timeout', {
        pendingJobs: this.currentJobs.size
      });
    }

    this.status = WorkerStatus.STOPPED;
    this.emit('stopped', this.config.id);
  }

  /**
   * Main processing loop
   */
  private async processLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        // Check if we can process more jobs
        if (this.currentJobs.size >= this.config.concurrency) {
          await this.sleep(100);
          continue;
        }

        // Dequeue a job
        const job = await this.queueManager.dequeue();

        if (!job) {
          // No jobs available, wait a bit
          this.status = WorkerStatus.IDLE;
          await this.sleep(500);
          continue;
        }

        // Process the job (don't await, run concurrently)
        const processingPromise = this.processJob(job);
        this.processingPromises.add(processingPromise);

        processingPromise.finally(() => {
          this.processingPromises.delete(processingPromise);
        });

      } catch (error) {
        this.logger.error('Error in processing loop', { error });
        this.status = WorkerStatus.ERROR;
        await this.sleep(1000);
      }
    }
  }

  /**
   * Process a single job
   */
  private async processJob(job: Job): Promise<void> {
    const jobLogger = this.logger.child({ jobId: job.id, jobType: job.type });
    this.currentJobs.add(job.id);
    this.status = WorkerStatus.BUSY;

    const startTime = Date.now();

    try {
      jobLogger.info('Processing job', { attempt: job.attempts });

      // Get handler for job type
      const handler = this.handlers.get(job.type);

      if (!handler) {
        throw new WorkerError(
          this.config.id,
          `No handler registered for job type: ${job.type}`,
          { jobType: job.type }
        );
      }

      // Execute job with timeout
      const timeout = job.options.timeout || this.config.jobTimeout;
      const result = await this.executeWithTimeout(
        () => handler(job.payload, job),
        timeout,
        job.id
      );

      // Mark as completed
      await this.queueManager.markAsCompleted(job.id, result);

      const processingTime = Date.now() - startTime;
      this.stats.processed++;
      this.stats.totalProcessingTime += processingTime;

      jobLogger.info('Job completed', { processingTime });

      this.emit('job:completed', {
        workerId: this.config.id,
        jobId: job.id,
        processingTime
      });

    } catch (error) {
      const processingTime = Date.now() - startTime;
      this.stats.failed++;

      jobLogger.error('Job failed', {
        error: error instanceof Error ? error.message : String(error),
        processingTime
      });

      // Mark as failed (will retry or move to DLQ)
      await this.queueManager.markAsFailed(
        job.id,
        error instanceof Error ? error : new Error(String(error))
      );

      this.emit('job:failed', {
        workerId: this.config.id,
        jobId: job.id,
        error,
        processingTime
      });

    } finally {
      this.currentJobs.delete(job.id);
      if (this.currentJobs.size === 0) {
        this.status = WorkerStatus.IDLE;
      }
    }
  }

  /**
   * Execute a function with timeout protection
   */
  private async executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeout: number,
    jobId: string
  ): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new JobTimeoutError(jobId, timeout)), timeout);
    });

    return Promise.race([fn(), timeoutPromise]);
  }

  /**
   * Start heartbeat mechanism
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.stats.lastHeartbeat = Date.now();
      this.emit('heartbeat', {
        workerId: this.config.id,
        status: this.status,
        currentJobs: this.currentJobs.size,
        stats: this.getStats()
      });
    }, this.config.heartbeatInterval);
  }

  /**
   * Get worker statistics
   */
  public getStats(): WorkerStats {
    const uptime = Date.now() - this.stats.startTime;
    const successRate =
      this.stats.processed + this.stats.failed > 0
        ? (this.stats.processed / (this.stats.processed + this.stats.failed)) * 100
        : 100;

    const averageProcessingTime =
      this.stats.processed > 0
        ? this.stats.totalProcessingTime / this.stats.processed
        : 0;

    return {
      id: this.config.id,
      status: this.status,
      processed: this.stats.processed,
      failed: this.stats.failed,
      successRate,
      uptime,
      currentJobs: this.currentJobs.size,
      lastHeartbeat: this.stats.lastHeartbeat,
      averageProcessingTime
    };
  }

  /**
   * Get worker ID
   */
  public getId(): string {
    return this.config.id;
  }

  /**
   * Get worker status
   */
  public getStatus(): WorkerStatus {
    return this.status;
  }

  /**
   * Check if worker is healthy
   */
  public isHealthy(): boolean {
    const heartbeatAge = Date.now() - this.stats.lastHeartbeat;
    const maxHeartbeatAge = this.config.heartbeatInterval * 3;

    return (
      this.isRunning &&
      this.status !== WorkerStatus.ERROR &&
      heartbeatAge < maxHeartbeatAge
    );
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Worker Pool class to manage multiple workers
 */
export class WorkerPool extends EventEmitter {
  private config: WorkerPoolConfig;
  private queueManager: QueueManager;
  private workers: Map<string, Worker> = new Map();
  private logger: Logger;
  private workerIdCounter = 0;

  constructor(config: WorkerPoolConfig, queueManager: QueueManager) {
    super();
    this.config = config;
    this.queueManager = queueManager;
    this.logger = Logger.forComponent('WorkerPool');
  }

  /**
   * Initialize the worker pool
   */
  public async initialize(handlers: Map<string, JobHandler>): Promise<void> {
    this.logger.info('Initializing worker pool', {
      minWorkers: this.config.minWorkers,
      maxWorkers: this.config.maxWorkers,
      concurrency: this.config.workerConcurrency
    });

    // Create initial workers
    for (let i = 0; i < this.config.minWorkers; i++) {
      await this.addWorker(handlers);
    }

    this.logger.info('Worker pool initialized', {
      workerCount: this.workers.size
    });
  }

  /**
   * Add a new worker to the pool
   */
  public async addWorker(handlers?: Map<string, JobHandler>): Promise<Worker> {
    if (this.workers.size >= this.config.maxWorkers) {
      throw new Error('Maximum workers limit reached');
    }

    const workerId = `worker-${++this.workerIdCounter}`;

    const workerConfig: WorkerConfig = {
      id: workerId,
      concurrency: this.config.workerConcurrency,
      heartbeatInterval: this.config.heartbeatInterval,
      jobTimeout: this.config.jobTimeout
    };

    const worker = new Worker(workerConfig, this.queueManager);

    // Register handlers
    if (handlers) {
      handlers.forEach((handler, jobType) => {
        worker.registerHandler(jobType, handler);
      });
    }

    // Set up event forwarding
    worker.on('job:completed', (data) => this.emit('job:completed', data));
    worker.on('job:failed', (data) => this.emit('job:failed', data));
    worker.on('heartbeat', (data) => this.emit('worker:heartbeat', data));

    this.workers.set(workerId, worker);

    await worker.start();

    this.logger.info('Worker added', { workerId, totalWorkers: this.workers.size });

    this.emit('worker:added', { workerId, totalWorkers: this.workers.size });

    return worker;
  }

  /**
   * Remove a worker from the pool
   */
  public async removeWorker(workerId?: string): Promise<void> {
    if (this.workers.size <= this.config.minWorkers) {
      throw new Error('Cannot remove worker: minimum workers limit reached');
    }

    let targetWorkerId = workerId;

    if (!targetWorkerId) {
      // Find the most idle worker
      targetWorkerId = this.findMostIdleWorker();
    }

    if (!targetWorkerId) {
      throw new Error('No worker found to remove');
    }

    const worker = this.workers.get(targetWorkerId);

    if (!worker) {
      throw new Error(`Worker ${targetWorkerId} not found`);
    }

    await worker.stop();
    this.workers.delete(targetWorkerId);

    this.logger.info('Worker removed', {
      workerId: targetWorkerId,
      totalWorkers: this.workers.size
    });

    this.emit('worker:removed', {
      workerId: targetWorkerId,
      totalWorkers: this.workers.size
    });
  }

  /**
   * Scale the worker pool to a target count
   */
  public async scaleTo(targetCount: number): Promise<void> {
    const currentCount = this.workers.size;

    if (targetCount === currentCount) {
      return;
    }

    targetCount = Math.max(
      this.config.minWorkers,
      Math.min(targetCount, this.config.maxWorkers)
    );

    this.logger.info('Scaling worker pool', {
      from: currentCount,
      to: targetCount
    });

    if (targetCount > currentCount) {
      // Scale up
      const toAdd = targetCount - currentCount;
      for (let i = 0; i < toAdd; i++) {
        await this.addWorker();
      }
    } else {
      // Scale down
      const toRemove = currentCount - targetCount;
      for (let i = 0; i < toRemove; i++) {
        await this.removeWorker();
      }
    }

    this.emit('pool:scaled', {
      previousCount: currentCount,
      currentCount: this.workers.size,
      targetCount
    });
  }

  /**
   * Register a handler across all workers
   */
  public registerHandler<T = any, R = any>(
    jobType: string,
    handler: JobHandler<T, R>
  ): void {
    this.workers.forEach(worker => {
      worker.registerHandler(jobType, handler);
    });

    this.logger.debug('Handler registered across all workers', { jobType });
  }

  /**
   * Get all worker statistics
   */
  public getAllStats(): WorkerStats[] {
    return Array.from(this.workers.values()).map(worker => worker.getStats());
  }

  /**
   * Get pool size
   */
  public getSize(): number {
    return this.workers.size;
  }

  /**
   * Get healthy worker count
   */
  public getHealthyWorkerCount(): number {
    return Array.from(this.workers.values()).filter(w => w.isHealthy()).length;
  }

  /**
   * Stop all workers gracefully
   */
  public async shutdown(timeout = 30000): Promise<void> {
    this.logger.info('Shutting down worker pool...');

    const shutdownPromises = Array.from(this.workers.values()).map(worker =>
      worker.stop(timeout)
    );

    await Promise.all(shutdownPromises);

    this.workers.clear();

    this.logger.info('Worker pool shut down');

    this.emit('pool:shutdown');
  }

  /**
   * Find the most idle worker (for removal)
   */
  private findMostIdleWorker(): string | undefined {
    let mostIdleWorkerId: string | undefined;
    let minCurrentJobs = Infinity;

    for (const [workerId, worker] of this.workers) {
      const stats = worker.getStats();
      if (stats.currentJobs < minCurrentJobs) {
        minCurrentJobs = stats.currentJobs;
        mostIdleWorkerId = workerId;
      }
    }

    return mostIdleWorkerId;
  }

  /**
   * Check if pool is healthy
   */
  public isHealthy(): boolean {
    const healthyWorkers = this.getHealthyWorkerCount();
    return healthyWorkers >= this.config.minWorkers;
  }
}
