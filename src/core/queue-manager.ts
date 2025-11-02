/**
 * Queue Manager
 * Handles priority-based job queuing, DLQ, retry mechanism, and message deduplication
 */

import { v4 as uuidv4 } from 'uuid';
import {
  Job,
  JobPriority,
  JobStatus,
  JobOptions,
  QueueConfig,
  QueueMetrics,
  JobMetadata,
  QueueFlowError
} from '../types';
import { RedisClientManager } from '../utils/redis-client';
import { Logger } from '../utils/logger';

export class QueueManager {
  private redis: RedisClientManager;
  private config: QueueConfig;
  private logger: Logger;

  // Redis key patterns
  private readonly QUEUE_KEY = 'queue';
  private readonly JOB_DATA_KEY = 'job:data';
  private readonly JOB_METADATA_KEY = 'job:metadata';
  private readonly DLQ_KEY = 'dlq';
  private readonly PROCESSING_KEY = 'processing';
  private readonly COMPLETED_KEY = 'completed';
  private readonly DEDUP_KEY = 'dedup';
  private readonly STATS_KEY = 'stats';

  constructor(redis: RedisClientManager, config: QueueConfig) {
    this.redis = redis;
    this.config = config;
    this.logger = Logger.forComponent('QueueManager');
  }

  /**
   * Enqueue a new job with priority and options
   */
  public async enqueue<T = any>(
    type: string,
    payload: T,
    options: JobOptions = {}
  ): Promise<Job<T>> {
    const jobId = uuidv4();
    const priority = options.priority || JobPriority.NORMAL;
    const maxRetries = options.maxRetries ?? this.config.defaultMaxRetries;
    const ttl = options.ttl;

    // Check for deduplication
    if (options.deduplicationKey) {
      const isDuplicate = await this.checkDuplication(options.deduplicationKey);
      if (isDuplicate) {
        throw new QueueFlowError(
          'Duplicate job detected',
          'DUPLICATE_JOB',
          { deduplicationKey: options.deduplicationKey }
        );
      }
    }

    const job: Job<T> = {
      id: jobId,
      type,
      payload,
      options: { ...options, priority, maxRetries },
      status: JobStatus.PENDING,
      attempts: 0,
      createdAt: Date.now()
    };

    const metadata: JobMetadata = {
      jobId,
      enqueuedAt: Date.now(),
      priority,
      attempts: 0
    };

    try {
      const client = this.redis.getClient();
      const pipeline = this.redis.pipeline();

      // Store job data
      pipeline.hset(this.JOB_DATA_KEY, jobId, JSON.stringify(job));

      // Store job metadata
      pipeline.hset(this.JOB_METADATA_KEY, jobId, JSON.stringify(metadata));

      // Add to priority queue (using sorted set with priority score)
      const score = this.calculatePriorityScore(priority, Date.now());
      pipeline.zadd(`${this.QUEUE_KEY}:${priority}`, score, jobId);

      // Set TTL if specified
      if (ttl) {
        pipeline.expire(`${this.JOB_DATA_KEY}:${jobId}`, Math.floor(ttl / 1000));
      }

      // Set deduplication key if specified
      if (options.deduplicationKey) {
        pipeline.setex(
          `${this.DEDUP_KEY}:${options.deduplicationKey}`,
          ttl ? Math.floor(ttl / 1000) : 3600,
          jobId
        );
      }

      // Increment stats
      pipeline.hincrby(this.STATS_KEY, 'total', 1);
      pipeline.hincrby(this.STATS_KEY, 'pending', 1);
      pipeline.hincrby(this.STATS_KEY, `priority:${priority}`, 1);

      await pipeline.exec();

      // Publish event
      await this.publishEvent('job:enqueued', { jobId, type, priority });

      this.logger.info('Job enqueued', { jobId, type, priority });

      return job;
    } catch (error) {
      this.logger.error('Failed to enqueue job', { error, type });
      throw new QueueFlowError('Failed to enqueue job', 'ENQUEUE_ERROR', { error });
    }
  }

  /**
   * Dequeue the next job based on weighted priority distribution
   */
  public async dequeue(): Promise<Job | null> {
    try {
      const priority = this.selectPriorityWeighted();
      const client = this.redis.getClient();

      // Try to get a job from the selected priority queue
      let jobId = await this.popFromQueue(priority);

      // If no job found, try other priorities
      if (!jobId) {
        const priorities = [JobPriority.HIGH, JobPriority.NORMAL, JobPriority.LOW];
        for (const p of priorities) {
          if (p !== priority) {
            jobId = await this.popFromQueue(p);
            if (jobId) break;
          }
        }
      }

      if (!jobId) {
        return null;
      }

      // Get job data
      const jobDataStr = await client.hget(this.JOB_DATA_KEY, jobId);
      if (!jobDataStr) {
        this.logger.warn('Job data not found', { jobId });
        return null;
      }

      const job: Job = JSON.parse(jobDataStr);

      // Check if job has expired
      if (job.options.ttl) {
        const age = Date.now() - job.createdAt;
        if (age > job.options.ttl) {
          await this.markAsExpired(jobId);
          this.logger.warn('Job expired', { jobId, age, ttl: job.options.ttl });
          return this.dequeue(); // Try next job
        }
      }

      // Update job status
      job.status = JobStatus.PROCESSING;
      job.startedAt = Date.now();
      job.attempts++;

      const pipeline = this.redis.pipeline();

      // Update job data
      pipeline.hset(this.JOB_DATA_KEY, jobId, JSON.stringify(job));

      // Add to processing set
      pipeline.zadd(this.PROCESSING_KEY, Date.now(), jobId);

      // Update stats
      pipeline.hincrby(this.STATS_KEY, 'pending', -1);
      pipeline.hincrby(this.STATS_KEY, 'processing', 1);

      await pipeline.exec();

      // Publish event
      await this.publishEvent('job:processing', { jobId, type: job.type });

      this.logger.debug('Job dequeued', { jobId, type: job.type, attempt: job.attempts });

      return job;
    } catch (error) {
      this.logger.error('Failed to dequeue job', { error });
      return null;
    }
  }

  /**
   * Mark a job as completed
   */
  public async markAsCompleted(jobId: string, result?: any): Promise<void> {
    try {
      const client = this.redis.getClient();
      const jobDataStr = await client.hget(this.JOB_DATA_KEY, jobId);

      if (!jobDataStr) {
        throw new QueueFlowError('Job not found', 'JOB_NOT_FOUND', { jobId });
      }

      const job: Job = JSON.parse(jobDataStr);
      job.status = JobStatus.COMPLETED;
      job.completedAt = Date.now();
      job.result = result;

      const processingTime = job.completedAt - (job.startedAt || job.createdAt);

      const pipeline = this.redis.pipeline();

      // Update job data
      pipeline.hset(this.JOB_DATA_KEY, jobId, JSON.stringify(job));

      // Remove from processing
      pipeline.zrem(this.PROCESSING_KEY, jobId);

      // Add to completed set
      pipeline.zadd(this.COMPLETED_KEY, Date.now(), jobId);

      // Update stats
      pipeline.hincrby(this.STATS_KEY, 'processing', -1);
      pipeline.hincrby(this.STATS_KEY, 'completed', 1);
      pipeline.hincrby(this.STATS_KEY, 'totalProcessingTime', processingTime);

      await pipeline.exec();

      // Publish event
      await this.publishEvent('job:completed', { jobId, type: job.type, processingTime });

      this.logger.info('Job completed', { jobId, type: job.type, processingTime });
    } catch (error) {
      this.logger.error('Failed to mark job as completed', { error, jobId });
      throw error;
    }
  }

  /**
   * Mark a job as failed and handle retry logic
   */
  public async markAsFailed(jobId: string, error: Error): Promise<void> {
    try {
      const client = this.redis.getClient();
      const jobDataStr = await client.hget(this.JOB_DATA_KEY, jobId);

      if (!jobDataStr) {
        throw new QueueFlowError('Job not found', 'JOB_NOT_FOUND', { jobId });
      }

      const job: Job = JSON.parse(jobDataStr);
      const maxRetries = job.options.maxRetries ?? this.config.defaultMaxRetries;

      if (job.attempts < maxRetries) {
        // Retry the job with exponential backoff
        await this.retryJob(job);
      } else {
        // Move to DLQ
        await this.moveToDeadLetterQueue(job, error.message);
      }
    } catch (err) {
      this.logger.error('Failed to mark job as failed', { error: err, jobId });
      throw err;
    }
  }

  /**
   * Retry a failed job with exponential backoff
   */
  private async retryJob(job: Job): Promise<void> {
    const retryDelay = this.calculateRetryDelay(job.attempts);
    const nextRetryAt = Date.now() + retryDelay;

    job.status = JobStatus.PENDING;

    const metadata: JobMetadata = {
      jobId: job.id,
      enqueuedAt: Date.now(),
      priority: job.options.priority || JobPriority.NORMAL,
      attempts: job.attempts,
      lastAttemptAt: Date.now(),
      nextRetryAt
    };

    const pipeline = this.redis.pipeline();

    // Update job data
    pipeline.hset(this.JOB_DATA_KEY, job.id, JSON.stringify(job));

    // Update metadata
    pipeline.hset(this.JOB_METADATA_KEY, job.id, JSON.stringify(metadata));

    // Remove from processing
    pipeline.zrem(this.PROCESSING_KEY, job.id);

    // Re-add to queue with delayed score
    const score = this.calculatePriorityScore(metadata.priority, nextRetryAt);
    pipeline.zadd(`${this.QUEUE_KEY}:${metadata.priority}`, score, job.id);

    // Update stats
    pipeline.hincrby(this.STATS_KEY, 'processing', -1);
    pipeline.hincrby(this.STATS_KEY, 'pending', 1);

    await pipeline.exec();

    // Publish event
    await this.publishEvent('job:retry', {
      jobId: job.id,
      attempt: job.attempts,
      nextRetryAt
    });

    this.logger.warn('Job scheduled for retry', {
      jobId: job.id,
      attempt: job.attempts,
      retryDelay,
      nextRetryAt
    });
  }

  /**
   * Move a job to the Dead Letter Queue
   */
  private async moveToDeadLetterQueue(job: Job, errorMessage: string): Promise<void> {
    job.status = JobStatus.FAILED;
    job.error = errorMessage;
    job.completedAt = Date.now();

    const pipeline = this.redis.pipeline();

    // Update job data
    pipeline.hset(this.JOB_DATA_KEY, job.id, JSON.stringify(job));

    // Remove from processing
    pipeline.zrem(this.PROCESSING_KEY, job.id);

    // Add to DLQ
    pipeline.zadd(this.DLQ_KEY, Date.now(), job.id);

    // Update stats
    pipeline.hincrby(this.STATS_KEY, 'processing', -1);
    pipeline.hincrby(this.STATS_KEY, 'failed', 1);
    pipeline.hincrby(this.STATS_KEY, 'dlq', 1);

    await pipeline.exec();

    // Publish event
    await this.publishEvent('job:failed', {
      jobId: job.id,
      type: job.type,
      error: errorMessage,
      attempts: job.attempts
    });

    this.logger.error('Job moved to DLQ', {
      jobId: job.id,
      type: job.type,
      error: errorMessage,
      attempts: job.attempts
    });
  }

  /**
   * Reprocess jobs from DLQ
   */
  public async reprocessDLQ(jobIds?: string[], maxJobs: number = 100): Promise<string[]> {
    try {
      const client = this.redis.getClient();
      let idsToReprocess: string[];

      if (jobIds && jobIds.length > 0) {
        idsToReprocess = jobIds;
      } else {
        // Get jobs from DLQ
        idsToReprocess = await client.zrange(this.DLQ_KEY, 0, maxJobs - 1);
      }

      const reprocessed: string[] = [];

      for (const jobId of idsToReprocess) {
        const jobDataStr = await client.hget(this.JOB_DATA_KEY, jobId);
        if (!jobDataStr) continue;

        const job: Job = JSON.parse(jobDataStr);

        // Reset job for reprocessing
        job.status = JobStatus.PENDING;
        job.attempts = 0;
        delete job.error;
        delete job.completedAt;

        const priority = job.options.priority || JobPriority.NORMAL;
        const score = this.calculatePriorityScore(priority, Date.now());

        const pipeline = this.redis.pipeline();

        // Update job data
        pipeline.hset(this.JOB_DATA_KEY, jobId, JSON.stringify(job));

        // Remove from DLQ
        pipeline.zrem(this.DLQ_KEY, jobId);

        // Add back to queue
        pipeline.zadd(`${this.QUEUE_KEY}:${priority}`, score, jobId);

        // Update stats
        pipeline.hincrby(this.STATS_KEY, 'dlq', -1);
        pipeline.hincrby(this.STATS_KEY, 'pending', 1);
        pipeline.hincrby(this.STATS_KEY, 'failed', -1);

        await pipeline.exec();

        reprocessed.push(jobId);

        this.logger.info('Job reprocessed from DLQ', { jobId });
      }

      return reprocessed;
    } catch (error) {
      this.logger.error('Failed to reprocess DLQ', { error });
      throw error;
    }
  }

  /**
   * Get queue metrics
   */
  public async getMetrics(): Promise<QueueMetrics> {
    try {
      const client = this.redis.getClient();
      const stats = await client.hgetall(this.STATS_KEY);

      const totalJobs = parseInt(stats.total || '0', 10);
      const completedJobs = parseInt(stats.completed || '0', 10);
      const totalProcessingTime = parseInt(stats.totalProcessingTime || '0', 10);

      // Get queue depths for each priority
      const [highCount, normalCount, lowCount] = await Promise.all([
        client.zcard(`${this.QUEUE_KEY}:${JobPriority.HIGH}`),
        client.zcard(`${this.QUEUE_KEY}:${JobPriority.NORMAL}`),
        client.zcard(`${this.QUEUE_KEY}:${JobPriority.LOW}`)
      ]);

      return {
        totalJobs,
        pendingJobs: parseInt(stats.pending || '0', 10),
        processingJobs: parseInt(stats.processing || '0', 10),
        completedJobs,
        failedJobs: parseInt(stats.failed || '0', 10),
        dlqJobs: parseInt(stats.dlq || '0', 10),
        highPriorityJobs: highCount,
        normalPriorityJobs: normalCount,
        lowPriorityJobs: lowCount,
        averageProcessingTime: completedJobs > 0 ? totalProcessingTime / completedJobs : 0,
        processingRate: 0, // Will be calculated by metrics collector
        errorRate: totalJobs > 0 ? (parseInt(stats.failed || '0', 10) / totalJobs) * 100 : 0
      };
    } catch (error) {
      this.logger.error('Failed to get metrics', { error });
      throw error;
    }
  }

  /**
   * Clean up expired and old completed jobs
   */
  public async cleanup(removeExpired = true, removeCompleted = true, olderThan?: number): Promise<number> {
    let removed = 0;

    try {
      const client = this.redis.getClient();
      const cutoffTime = olderThan || (Date.now() - 24 * 60 * 60 * 1000); // Default: 24 hours

      if (removeCompleted) {
        // Remove old completed jobs
        const completedJobs = await client.zrangebyscore(this.COMPLETED_KEY, 0, cutoffTime);
        if (completedJobs.length > 0) {
          const pipeline = this.redis.pipeline();
          for (const jobId of completedJobs) {
            pipeline.hdel(this.JOB_DATA_KEY, jobId);
            pipeline.hdel(this.JOB_METADATA_KEY, jobId);
            pipeline.zrem(this.COMPLETED_KEY, jobId);
          }
          await pipeline.exec();
          removed += completedJobs.length;
          this.logger.info('Cleaned up completed jobs', { count: completedJobs.length });
        }
      }

      if (removeExpired) {
        // Check all pending jobs for expiration
        const priorities = [JobPriority.HIGH, JobPriority.NORMAL, JobPriority.LOW];
        for (const priority of priorities) {
          const jobIds = await client.zrange(`${this.QUEUE_KEY}:${priority}`, 0, -1);
          for (const jobId of jobIds) {
            const jobDataStr = await client.hget(this.JOB_DATA_KEY, jobId);
            if (jobDataStr) {
              const job: Job = JSON.parse(jobDataStr);
              if (job.options.ttl && Date.now() - job.createdAt > job.options.ttl) {
                await this.markAsExpired(jobId);
                removed++;
              }
            }
          }
        }
      }

      return removed;
    } catch (error) {
      this.logger.error('Cleanup failed', { error });
      throw error;
    }
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  /**
   * Calculate priority score for sorted set
   * Lower score = higher priority (processed first)
   */
  private calculatePriorityScore(priority: JobPriority, timestamp: number): number {
    const priorityWeights = {
      [JobPriority.HIGH]: 1000,
      [JobPriority.NORMAL]: 2000,
      [JobPriority.LOW]: 3000
    };

    return priorityWeights[priority] + timestamp / 1000000;
  }

  /**
   * Select priority based on weighted distribution
   */
  private selectPriorityWeighted(): JobPriority {
    const random = Math.random() * 100;
    const highWeight = this.config.highPriorityWeight;
    const normalWeight = this.config.normalPriorityWeight;

    if (random < highWeight) {
      return JobPriority.HIGH;
    } else if (random < highWeight + normalWeight) {
      return JobPriority.NORMAL;
    } else {
      return JobPriority.LOW;
    }
  }

  /**
   * Pop a job from a specific priority queue
   */
  private async popFromQueue(priority: JobPriority): Promise<string | null> {
    const client = this.redis.getClient();
    const queueKey = `${this.QUEUE_KEY}:${priority}`;
    const now = Date.now();

    // Get jobs that are ready to be processed (score <= now)
    const jobs = await client.zrangebyscore(queueKey, 0, now, 'LIMIT', 0, 1);

    if (jobs.length === 0) {
      return null;
    }

    const jobId = jobs[0];

    // Remove from queue atomically
    const removed = await client.zrem(queueKey, jobId);

    return removed > 0 ? jobId : null;
  }

  /**
   * Calculate retry delay with exponential backoff
   */
  private calculateRetryDelay(attempts: number): number {
    const baseDelay = 1000; // 1 second
    const maxDelay = 60000; // 60 seconds
    const delay = Math.min(baseDelay * Math.pow(2, attempts), maxDelay);

    // Add jitter to prevent thundering herd
    const jitter = Math.random() * 0.3 * delay;

    return Math.floor(delay + jitter);
  }

  /**
   * Check for duplicate jobs
   */
  private async checkDuplication(deduplicationKey: string): Promise<boolean> {
    const client = this.redis.getClient();
    const exists = await client.exists(`${this.DEDUP_KEY}:${deduplicationKey}`);
    return exists === 1;
  }

  /**
   * Mark a job as expired
   */
  private async markAsExpired(jobId: string): Promise<void> {
    const client = this.redis.getClient();
    const jobDataStr = await client.hget(this.JOB_DATA_KEY, jobId);

    if (jobDataStr) {
      const job: Job = JSON.parse(jobDataStr);
      job.status = JobStatus.EXPIRED;

      const pipeline = this.redis.pipeline();
      pipeline.hset(this.JOB_DATA_KEY, jobId, JSON.stringify(job));
      pipeline.zrem(`${this.QUEUE_KEY}:${job.options.priority || JobPriority.NORMAL}`, jobId);
      pipeline.hincrby(this.STATS_KEY, 'pending', -1);
      pipeline.hincrby(this.STATS_KEY, 'failed', 1);

      await pipeline.exec();
    }
  }

  /**
   * Publish an event to Redis pub/sub
   */
  private async publishEvent(event: string, data: any): Promise<void> {
    try {
      const publisher = this.redis.getPublisher();
      await publisher.publish(
        `${this.config.keyPrefix}events`,
        JSON.stringify({ event, data, timestamp: Date.now() })
      );
    } catch (error) {
      // Don't fail the operation if event publishing fails
      this.logger.warn('Failed to publish event', { event, error });
    }
  }

  /**
   * Get job by ID
   */
  public async getJob(jobId: string): Promise<Job | null> {
    const client = this.redis.getClient();
    const jobDataStr = await client.hget(this.JOB_DATA_KEY, jobId);
    return jobDataStr ? JSON.parse(jobDataStr) : null;
  }
}
