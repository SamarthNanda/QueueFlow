/**
 * Integration tests for API Server
 */

import request from 'supertest';
import { APIServer } from '../../src/api/server';
import { QueueManager } from '../../src/core/queue-manager';
import { WorkerPool } from '../../src/core/worker';
import { AutoScaler } from '../../src/core/auto-scaler';

// Mock dependencies
jest.mock('../../src/core/queue-manager');
jest.mock('../../src/core/worker');
jest.mock('../../src/core/auto-scaler');
jest.mock('../../src/monitoring/metrics');
jest.mock('../../src/monitoring/health');

describe('API Server Integration Tests', () => {
  let apiServer: APIServer;
  let mockQueueManager: any;
  let mockWorkerPool: any;
  let mockAutoScaler: any;

  beforeAll(() => {
    // Setup mocks
    mockQueueManager = {
      enqueue: jest.fn().mockResolvedValue({
        id: 'test-job-id',
        status: 'pending',
        createdAt: Date.now()
      }),
      getJob: jest.fn().mockResolvedValue({
        id: 'test-job-id',
        type: 'test',
        status: 'completed'
      }),
      getMetrics: jest.fn().mockResolvedValue({
        totalJobs: 100,
        pendingJobs: 10,
        completedJobs: 85,
        failedJobs: 5
      }),
      reprocessDLQ: jest.fn().mockResolvedValue(['job-1', 'job-2']),
      cleanup: jest.fn().mockResolvedValue(10)
    };

    mockWorkerPool = {
      getSize: jest.fn().mockReturnValue(5),
      getAllStats: jest.fn().mockReturnValue([]),
      scaleTo: jest.fn().mockResolvedValue(undefined)
    };

    mockAutoScaler = {
      manualScale: jest.fn().mockResolvedValue(undefined),
      setStrategy: jest.fn()
    };

    apiServer = new APIServer(
      3000,
      mockQueueManager as any,
      mockWorkerPool as any,
      mockAutoScaler as any
    );
  });

  describe('POST /api/jobs', () => {
    it('should create a new job', async () => {
      const response = await request(apiServer.getApp())
        .post('/api/jobs')
        .send({
          type: 'test-job',
          payload: { data: 'test' }
        });

      expect(response.status).toBe(201);
      expect(response.body.jobId).toBeDefined();
    });

    it('should return 400 for invalid job data', async () => {
      const response = await request(apiServer.getApp())
        .post('/api/jobs')
        .send({
          // Missing required fields
        });

      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/jobs/:jobId', () => {
    it('should get job details', async () => {
      const response = await request(apiServer.getApp())
        .get('/api/jobs/test-job-id');

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('test-job-id');
    });
  });

  describe('GET /api/status', () => {
    it('should return system status', async () => {
      const response = await request(apiServer.getApp())
        .get('/api/status');

      expect(response.status).toBe(200);
      expect(response.body.metrics).toBeDefined();
    });
  });

  describe('GET /api/health', () => {
    it('should return health status', async () => {
      const response = await request(apiServer.getApp())
        .get('/api/health');

      expect(response.status).toBe(200);
    });
  });

  describe('POST /api/scale', () => {
    it('should trigger manual scaling', async () => {
      const response = await request(apiServer.getApp())
        .post('/api/scale')
        .send({ targetWorkers: 10 });

      expect(response.status).toBe(200);
    });
  });
});
