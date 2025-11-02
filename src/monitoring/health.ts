/**
 * Health Check System
 * Monitors system health and provides detailed health status
 */

import { HealthCheckResult } from '../types';
import { RedisClientManager } from '../utils/redis-client';
import { QueueManager } from '../core/queue-manager';
import { WorkerPool } from '../core/worker';
import { Logger } from '../utils/logger';

export class HealthChecker {
  private logger: Logger;
  private redis: RedisClientManager | null = null;
  private queueManager: QueueManager | null = null;
  private workerPool: WorkerPool | null = null;

  constructor() {
    this.logger = Logger.forComponent('HealthChecker');
  }

  /**
   * Set Redis client manager
   */
  public setRedis(redis: RedisClientManager): void {
    this.redis = redis;
  }

  /**
   * Set queue manager
   */
  public setQueueManager(queueManager: QueueManager): void {
    this.queueManager = queueManager;
  }

  /**
   * Set worker pool
   */
  public setWorkerPool(workerPool: WorkerPool): void {
    this.workerPool = workerPool;
  }

  /**
   * Perform comprehensive health check
   */
  public async check(): Promise<HealthCheckResult> {
    const timestamp = Date.now();
    const checks = {
      redis: false,
      workers: false,
      queue: false,
      api: true // Assumed healthy if this code is running
    };

    const details: any = {};

    try {
      // Check Redis
      if (this.redis) {
        const redisStartTime = Date.now();
        checks.redis = await this.checkRedis();
        details.redisLatency = Date.now() - redisStartTime;
      }

      // Check Workers
      if (this.workerPool) {
        checks.workers = this.checkWorkers();
        details.activeWorkers = this.workerPool.getSize();
        details.healthyWorkers = this.workerPool.getHealthyWorkerCount();
      }

      // Check Queue
      if (this.queueManager) {
        checks.queue = await this.checkQueue();
        const metrics = await this.queueManager.getMetrics();
        details.queueDepth = metrics.pendingJobs;
        details.dlqDepth = metrics.dlqJobs;
      }

      // Determine overall status
      const status = this.determineOverallStatus(checks);

      const result: HealthCheckResult = {
        status,
        timestamp,
        checks,
        details
      };

      if (status !== 'healthy') {
        this.logger.warn('Health check degraded or unhealthy', result);
      }

      return result;
    } catch (error) {
      this.logger.error('Health check failed', { error });

      return {
        status: 'unhealthy',
        timestamp,
        checks,
        details: {
          error: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  /**
   * Check Redis health
   */
  private async checkRedis(): Promise<boolean> {
    if (!this.redis) return false;

    try {
      const isHealthy = this.redis.isHealthy();
      if (!isHealthy) return false;

      const pingResult = await this.redis.ping();
      return pingResult;
    } catch (error) {
      this.logger.error('Redis health check failed', { error });
      return false;
    }
  }

  /**
   * Check worker pool health
   */
  private checkWorkers(): boolean {
    if (!this.workerPool) return false;

    try {
      return this.workerPool.isHealthy();
    } catch (error) {
      this.logger.error('Worker health check failed', { error });
      return false;
    }
  }

  /**
   * Check queue health
   */
  private async checkQueue(): Promise<boolean> {
    if (!this.queueManager) return false;

    try {
      // Try to get metrics as a health check
      await this.queueManager.getMetrics();
      return true;
    } catch (error) {
      this.logger.error('Queue health check failed', { error });
      return false;
    }
  }

  /**
   * Determine overall system status
   */
  private determineOverallStatus(
    checks: HealthCheckResult['checks']
  ): 'healthy' | 'degraded' | 'unhealthy' {
    // Critical components: redis and workers
    if (!checks.redis || !checks.workers) {
      return 'unhealthy';
    }

    // Non-critical components
    if (!checks.queue) {
      return 'degraded';
    }

    return 'healthy';
  }

  /**
   * Quick liveness check (for K8s liveness probe)
   */
  public async liveness(): Promise<boolean> {
    // Just check if the process is alive and Redis is connected
    if (!this.redis) return false;
    return this.redis.isHealthy();
  }

  /**
   * Readiness check (for K8s readiness probe)
   */
  public async readiness(): Promise<boolean> {
    // Check if system is ready to accept traffic
    const health = await this.check();
    return health.status === 'healthy' || health.status === 'degraded';
  }
}

// Singleton instance
let healthChecker: HealthChecker | null = null;

/**
 * Get health checker instance
 */
export function getHealthChecker(): HealthChecker {
  if (!healthChecker) {
    healthChecker = new HealthChecker();
  }
  return healthChecker;
}
