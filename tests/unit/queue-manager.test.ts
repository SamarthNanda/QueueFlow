/**
 * Unit tests for Queue Manager
 */

import { QueueManager } from '../../src/core/queue-manager';
import { JobPriority, JobStatus, QueueConfig } from '../../src/types';

// Mock Redis client
jest.mock('../../src/utils/redis-client');

describe('QueueManager', () => {
  let queueManager: QueueManager;
  let mockRedis: any;

  beforeEach(() => {
    // Setup mock Redis client
    mockRedis = {
      getClient: jest.fn().mockReturnValue({
        hset: jest.fn(),
        hget: jest.fn(),
        zadd: jest.fn(),
        zrange: jest.fn(),
        zrem: jest.fn(),
        expire: jest.fn(),
        setex: jest.fn(),
        hincrby: jest.fn(),
        hgetall: jest.fn(),
        zcard: jest.fn(),
        exists: jest.fn()
      }),
      getPublisher: jest.fn().mockReturnValue({
        publish: jest.fn()
      }),
      pipeline: jest.fn().mockReturnValue({
        hset: jest.fn().mockReturnThis(),
        zadd: jest.fn().mockReturnThis(),
        expire: jest.fn().mockReturnThis(),
        setex: jest.fn().mockReturnThis(),
        hincrby: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([])
      })
    };

    const config: QueueConfig = {
      redisHost: 'localhost',
      redisPort: 6379,
      redisDb: 0,
      keyPrefix: 'test:',
      highPriorityWeight: 60,
      normalPriorityWeight: 30,
      lowPriorityWeight: 10,
      defaultMaxRetries: 3,
      dlqRetentionDays: 7,
      batchSize: 100
    };

    queueManager = new QueueManager(mockRedis as any, config);
  });

  describe('enqueue', () => {
    it('should enqueue a job successfully', async () => {
      const job = await queueManager.enqueue('test-job', { data: 'test' });

      expect(job.id).toBeDefined();
      expect(job.type).toBe('test-job');
      expect(job.status).toBe(JobStatus.PENDING);
      expect(job.attempts).toBe(0);
    });

    it('should enqueue a job with high priority', async () => {
      const job = await queueManager.enqueue('test-job', { data: 'test' }, {
        priority: JobPriority.HIGH
      });

      expect(job.options.priority).toBe(JobPriority.HIGH);
    });

    it('should throw error for duplicate deduplication key', async () => {
      mockRedis.getClient().exists.mockResolvedValue(1);

      await expect(
        queueManager.enqueue('test-job', { data: 'test' }, {
          deduplicationKey: 'unique-key'
        })
      ).rejects.toThrow('Duplicate job detected');
    });
  });

  describe('dequeue', () => {
    it('should return null when queue is empty', async () => {
      mockRedis.getClient().zrangebyscore = jest.fn().mockResolvedValue([]);

      const job = await queueManager.dequeue();

      expect(job).toBeNull();
    });
  });

  describe('markAsCompleted', () => {
    it('should mark a job as completed', async () => {
      const jobId = 'test-job-id';
      const mockJob = {
        id: jobId,
        type: 'test',
        payload: {},
        status: JobStatus.PROCESSING,
        attempts: 1,
        createdAt: Date.now(),
        startedAt: Date.now(),
        options: {}
      };

      mockRedis.getClient().hget.mockResolvedValue(JSON.stringify(mockJob));

      await queueManager.markAsCompleted(jobId, { result: 'success' });

      expect(mockRedis.pipeline().hset).toHaveBeenCalled();
    });
  });
});
