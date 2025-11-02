/**
 * Prometheus Metrics Exporter
 * Exposes system metrics in Prometheus format
 */

import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';
import { QueueManager } from '../core/queue-manager';
import { WorkerPool } from '../core/worker';
import { Logger } from '../utils/logger';

export class MetricsCollector {
  private registry: Registry;
  private logger: Logger;

  // Queue Metrics
  private queueDepthGauge!: Gauge;
  private queueDepthByPriorityGauge!: Gauge;
  private jobsEnqueuedCounter!: Counter;
  private jobsCompletedCounter!: Counter;
  private jobsFailedCounter!: Counter;
  private dlqSizeGauge!: Gauge;

  // Worker Metrics
  private activeWorkersGauge!: Gauge;
  private workerUtilizationGauge!: Gauge;
  private jobProcessingTimeHistogram!: Histogram;

  // Processing Metrics
  private processingRateGauge!: Gauge;
  private errorRateGauge!: Gauge;
  private averageProcessingTimeGauge!: Gauge;

  // Scaling Metrics
  private scalingEventsCounter!: Counter;
  private lastScalingTimestamp!: Gauge;

  private queueManager: QueueManager | null = null;
  private workerPool: WorkerPool | null = null;
  private collectionInterval: NodeJS.Timeout | null = null;
  private readonly COLLECTION_INTERVAL = 10000; // 10 seconds

  constructor() {
    this.registry = new Registry();
    this.logger = Logger.forComponent('MetricsCollector');

    // Initialize metrics
    this.initializeMetrics();

    // Collect default Node.js metrics
    collectDefaultMetrics({ register: this.registry });
  }

  /**
   * Initialize Prometheus metrics
   */
  private initializeMetrics(): void {
    // Queue Metrics
    this.queueDepthGauge = new Gauge({
      name: 'queueflow_queue_depth',
      help: 'Current number of jobs in queue',
      registers: [this.registry]
    });

    this.queueDepthByPriorityGauge = new Gauge({
      name: 'queueflow_queue_depth_by_priority',
      help: 'Queue depth by priority level',
      labelNames: ['priority'],
      registers: [this.registry]
    });

    this.jobsEnqueuedCounter = new Counter({
      name: 'queueflow_jobs_enqueued_total',
      help: 'Total number of jobs enqueued',
      labelNames: ['job_type'],
      registers: [this.registry]
    });

    this.jobsCompletedCounter = new Counter({
      name: 'queueflow_jobs_completed_total',
      help: 'Total number of jobs completed',
      labelNames: ['job_type'],
      registers: [this.registry]
    });

    this.jobsFailedCounter = new Counter({
      name: 'queueflow_jobs_failed_total',
      help: 'Total number of jobs failed',
      labelNames: ['job_type'],
      registers: [this.registry]
    });

    this.dlqSizeGauge = new Gauge({
      name: 'queueflow_dlq_size',
      help: 'Number of jobs in dead letter queue',
      registers: [this.registry]
    });

    // Worker Metrics
    this.activeWorkersGauge = new Gauge({
      name: 'queueflow_active_workers',
      help: 'Number of active workers',
      registers: [this.registry]
    });

    this.workerUtilizationGauge = new Gauge({
      name: 'queueflow_worker_utilization',
      help: 'Worker utilization percentage',
      labelNames: ['worker_id'],
      registers: [this.registry]
    });

    this.jobProcessingTimeHistogram = new Histogram({
      name: 'queueflow_job_processing_duration_seconds',
      help: 'Job processing duration in seconds',
      labelNames: ['job_type', 'status'],
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
      registers: [this.registry]
    });

    // Processing Metrics
    this.processingRateGauge = new Gauge({
      name: 'queueflow_processing_rate',
      help: 'Jobs processed per second',
      registers: [this.registry]
    });

    this.errorRateGauge = new Gauge({
      name: 'queueflow_error_rate',
      help: 'Error rate percentage',
      registers: [this.registry]
    });

    this.averageProcessingTimeGauge = new Gauge({
      name: 'queueflow_average_processing_time_ms',
      help: 'Average job processing time in milliseconds',
      registers: [this.registry]
    });

    // Scaling Metrics
    this.scalingEventsCounter = new Counter({
      name: 'queueflow_scaling_events_total',
      help: 'Total number of scaling events',
      labelNames: ['action'],
      registers: [this.registry]
    });

    this.lastScalingTimestamp = new Gauge({
      name: 'queueflow_last_scaling_timestamp',
      help: 'Timestamp of last scaling event',
      registers: [this.registry]
    });

    this.logger.info('Prometheus metrics initialized');
  }

  /**
   * Set queue manager reference
   */
  public setQueueManager(queueManager: QueueManager): void {
    this.queueManager = queueManager;
  }

  /**
   * Set worker pool reference
   */
  public setWorkerPool(workerPool: WorkerPool): void {
    this.workerPool = workerPool;
  }

  /**
   * Start metrics collection
   */
  public startCollection(): void {
    if (this.collectionInterval) {
      this.logger.warn('Metrics collection already started');
      return;
    }

    this.logger.info('Starting metrics collection', {
      interval: this.COLLECTION_INTERVAL
    });

    this.collectionInterval = setInterval(() => {
      this.collectMetrics();
    }, this.COLLECTION_INTERVAL);

    // Collect immediately
    this.collectMetrics();
  }

  /**
   * Stop metrics collection
   */
  public stopCollection(): void {
    if (this.collectionInterval) {
      clearInterval(this.collectionInterval);
      this.collectionInterval = null;
      this.logger.info('Metrics collection stopped');
    }
  }

  /**
   * Collect current metrics
   */
  private async collectMetrics(): Promise<void> {
    try {
      // Collect queue metrics
      if (this.queueManager) {
        const queueMetrics = await this.queueManager.getMetrics();

        this.queueDepthGauge.set(queueMetrics.pendingJobs);

        this.queueDepthByPriorityGauge.set(
          { priority: 'high' },
          queueMetrics.highPriorityJobs
        );
        this.queueDepthByPriorityGauge.set(
          { priority: 'normal' },
          queueMetrics.normalPriorityJobs
        );
        this.queueDepthByPriorityGauge.set(
          { priority: 'low' },
          queueMetrics.lowPriorityJobs
        );

        this.dlqSizeGauge.set(queueMetrics.dlqJobs);
        this.errorRateGauge.set(queueMetrics.errorRate);
        this.averageProcessingTimeGauge.set(queueMetrics.averageProcessingTime);

        // Calculate processing rate
        const processingRate = this.calculateProcessingRate(queueMetrics);
        this.processingRateGauge.set(processingRate);
      }

      // Collect worker metrics
      if (this.workerPool) {
        const workerStats = this.workerPool.getAllStats();

        this.activeWorkersGauge.set(workerStats.length);

        workerStats.forEach(stats => {
          const utilization = (stats.currentJobs / 5) * 100; // Assuming concurrency of 5
          this.workerUtilizationGauge.set({ worker_id: stats.id }, utilization);
        });
      }

      this.logger.debug('Metrics collected successfully');
    } catch (error) {
      this.logger.error('Failed to collect metrics', { error });
    }
  }

  /**
   * Calculate processing rate (jobs/second)
   */
  private lastCompletedCount = 0;
  private lastCollectionTime = Date.now();

  private calculateProcessingRate(queueMetrics: any): number {
    const currentTime = Date.now();
    const currentCompleted = queueMetrics.completedJobs;

    const timeDiff = (currentTime - this.lastCollectionTime) / 1000; // in seconds
    const jobsDiff = currentCompleted - this.lastCompletedCount;

    const rate = timeDiff > 0 ? jobsDiff / timeDiff : 0;

    this.lastCompletedCount = currentCompleted;
    this.lastCollectionTime = currentTime;

    return Math.max(0, rate);
  }

  /**
   * Record job enqueued
   */
  public recordJobEnqueued(jobType: string): void {
    this.jobsEnqueuedCounter.inc({ job_type: jobType });
  }

  /**
   * Record job completed
   */
  public recordJobCompleted(jobType: string, durationMs: number): void {
    this.jobsCompletedCounter.inc({ job_type: jobType });
    this.jobProcessingTimeHistogram.observe(
      { job_type: jobType, status: 'completed' },
      durationMs / 1000
    );
  }

  /**
   * Record job failed
   */
  public recordJobFailed(jobType: string, durationMs: number): void {
    this.jobsFailedCounter.inc({ job_type: jobType });
    this.jobProcessingTimeHistogram.observe(
      { job_type: jobType, status: 'failed' },
      durationMs / 1000
    );
  }

  /**
   * Record scaling event
   */
  public recordScalingEvent(action: 'scale_up' | 'scale_down'): void {
    this.scalingEventsCounter.inc({ action });
    this.lastScalingTimestamp.set(Date.now());
  }

  /**
   * Get metrics in Prometheus format
   */
  public async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  /**
   * Get registry for custom use
   */
  public getRegistry(): Registry {
    return this.registry;
  }

  /**
   * Reset all metrics (useful for testing)
   */
  public reset(): void {
    this.registry.resetMetrics();
    this.lastCompletedCount = 0;
    this.lastCollectionTime = Date.now();
  }
}

// Singleton instance
let metricsCollector: MetricsCollector | null = null;

/**
 * Get metrics collector instance
 */
export function getMetricsCollector(): MetricsCollector {
  if (!metricsCollector) {
    metricsCollector = new MetricsCollector();
  }
  return metricsCollector;
}
