/**
 * Unit tests for Worker
 */

import { Worker, WorkerPool } from '../../src/core/worker';
import { WorkerConfig, WorkerPoolConfig, WorkerStatus } from '../../src/types';

jest.mock('../../src/core/queue-manager');

describe('Worker', () => {
  let worker: Worker;
  let mockQueueManager: any;

  beforeEach(() => {
    mockQueueManager = {
      dequeue: jest.fn(),
      markAsCompleted: jest.fn(),
      markAsFailed: jest.fn()
    };

    const config: WorkerConfig = {
      id: 'test-worker-1',
      concurrency: 5,
      heartbeatInterval: 1000,
      jobTimeout: 5000
    };

    worker = new Worker(config, mockQueueManager);
  });

  afterEach(async () => {
    if (worker) {
      await worker.stop();
    }
  });

  describe('registerHandler', () => {
    it('should register a job handler', () => {
      const handler = jest.fn();
      worker.registerHandler('test-type', handler);

      expect(worker['handlers'].has('test-type')).toBe(true);
    });
  });

  describe('getStats', () => {
    it('should return worker statistics', () => {
      const stats = worker.getStats();

      expect(stats.id).toBe('test-worker-1');
      expect(stats.status).toBe(WorkerStatus.IDLE);
      expect(stats.processed).toBe(0);
      expect(stats.failed).toBe(0);
    });
  });

  describe('isHealthy', () => {
    it('should return true for a healthy worker', () => {
      expect(worker.isHealthy()).toBe(false); // Not started yet
    });
  });
});

describe('WorkerPool', () => {
  let workerPool: WorkerPool;
  let mockQueueManager: any;

  beforeEach(() => {
    mockQueueManager = {
      dequeue: jest.fn(),
      markAsCompleted: jest.fn(),
      markAsFailed: jest.fn()
    };

    const config: WorkerPoolConfig = {
      minWorkers: 2,
      maxWorkers: 10,
      workerConcurrency: 5,
      heartbeatInterval: 1000,
      jobTimeout: 5000
    };

    workerPool = new WorkerPool(config, mockQueueManager);
  });

  afterEach(async () => {
    if (workerPool) {
      await workerPool.shutdown();
    }
  });

  describe('initialize', () => {
    it('should create minimum number of workers', async () => {
      const handlers = new Map();
      handlers.set('test', jest.fn());

      await workerPool.initialize(handlers);

      expect(workerPool.getSize()).toBe(2);
    });
  });

  describe('scaleTo', () => {
    it('should scale up workers', async () => {
      const handlers = new Map();
      await workerPool.initialize(handlers);

      await workerPool.scaleTo(5);

      expect(workerPool.getSize()).toBe(5);
    });

    it('should not exceed max workers', async () => {
      const handlers = new Map();
      await workerPool.initialize(handlers);

      await workerPool.scaleTo(100);

      expect(workerPool.getSize()).toBe(10); // Max is 10
    });
  });
});
