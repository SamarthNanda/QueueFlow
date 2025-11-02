/**
 * REST API Server
 * Provides HTTP endpoints for job management and system monitoring
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import Joi from 'joi';
import {
  CreateJobRequest,
  CreateJobResponse,
  StatusResponse,
  ReprocessDLQRequest,
  ReprocessDLQResponse,
  ScaleRequest,
  ScaleResponse,
  CleanupRequest,
  CleanupResponse,
  JobPriority,
  ScalingStrategy
} from '../types';
import { QueueManager } from '../core/queue-manager';
import { WorkerPool } from '../core/worker';
import { AutoScaler } from '../core/auto-scaler';
import { getMetricsCollector } from '../monitoring/metrics';
import { getHealthChecker } from '../monitoring/health';
import { Logger } from '../utils/logger';

// Validation schemas
const createJobSchema = Joi.object({
  type: Joi.string().required(),
  payload: Joi.any().required(),
  options: Joi.object({
    priority: Joi.string().valid('high', 'normal', 'low'),
    maxRetries: Joi.number().integer().min(0).max(10),
    ttl: Joi.number().integer().min(1000),
    timeout: Joi.number().integer().min(1000),
    deduplicationKey: Joi.string()
  })
});

const reprocessDLQSchema = Joi.object({
  jobIds: Joi.array().items(Joi.string()),
  maxJobs: Joi.number().integer().min(1).max(1000).default(100)
});

const scaleSchema = Joi.object({
  targetWorkers: Joi.number().integer().min(1),
  strategy: Joi.string().valid('default', 'aggressive', 'conservative', 'predictive')
});

const cleanupSchema = Joi.object({
  removeExpired: Joi.boolean().default(true),
  removeCompleted: Joi.boolean().default(true),
  olderThan: Joi.number().integer()
});

export class APIServer {
  private app: Express;
  private queueManager: QueueManager;
  private workerPool: WorkerPool;
  private autoScaler: AutoScaler;
  private logger: Logger;
  private port: number;
  private server: any = null;

  constructor(
    port: number,
    queueManager: QueueManager,
    workerPool: WorkerPool,
    autoScaler: AutoScaler
  ) {
    this.app = express();
    this.port = port;
    this.queueManager = queueManager;
    this.workerPool = workerPool;
    this.autoScaler = autoScaler;
    this.logger = Logger.forComponent('APIServer');

    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();
  }

  /**
   * Setup Express middleware
   */
  private setupMiddleware(): void {
    // Security
    this.app.use(helmet());
    this.app.use(cors());

    // Body parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Compression
    this.app.use(compression());

    // Request logging
    this.app.use((req, res, next) => {
      this.logger.info('HTTP Request', {
        method: req.method,
        path: req.path,
        ip: req.ip
      });
      next();
    });
  }

  /**
   * Setup API routes
   */
  private setupRoutes(): void {
    const router = express.Router();

    // Job Management
    router.post('/jobs', this.createJob.bind(this));
    router.get('/jobs/:jobId', this.getJob.bind(this));

    // System Status
    router.get('/status', this.getStatus.bind(this));

    // Dead Letter Queue
    router.post('/dlq/reprocess', this.reprocessDLQ.bind(this));
    router.get('/dlq', this.getDLQJobs.bind(this));

    // Scaling
    router.post('/scale', this.manualScale.bind(this));

    // Cleanup
    router.post('/cleanup', this.cleanup.bind(this));

    // Health
    router.get('/health', this.healthCheck.bind(this));
    router.get('/health/liveness', this.livenessCheck.bind(this));
    router.get('/health/readiness', this.readinessCheck.bind(this));

    // Metrics (Prometheus)
    router.get('/metrics', this.getMetrics.bind(this));

    // Mount router under /api
    this.app.use('/api', router);

    // Root endpoint
    this.app.get('/', (req, res) => {
      res.json({
        name: 'QueueFlow',
        version: '1.0.0',
        status: 'running',
        endpoints: {
          jobs: 'POST /api/jobs',
          status: 'GET /api/status',
          health: 'GET /api/health',
          metrics: 'GET /api/metrics'
        }
      });
    });
  }

  /**
   * Create a new job
   */
  private async createJob(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { error, value } = createJobSchema.validate(req.body);

      if (error) {
        res.status(400).json({
          error: 'Validation error',
          details: error.details.map(d => d.message)
        });
        return;
      }

      const { type, payload, options } = value as CreateJobRequest;

      const job = await this.queueManager.enqueue(type, payload, options);

      // Record metric
      getMetricsCollector().recordJobEnqueued(type);

      const response: CreateJobResponse = {
        jobId: job.id,
        status: job.status,
        enqueuedAt: job.createdAt
      };

      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  }

  /**
   * Get job details
   */
  private async getJob(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { jobId } = req.params;

      const job = await this.queueManager.getJob(jobId);

      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }

      res.json(job);
    } catch (err) {
      next(err);
    }
  }

  /**
   * Get system status
   */
  private async getStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const queueMetrics = await this.queueManager.getMetrics();
      const workerStats = this.workerPool.getAllStats();
      const healthCheck = await getHealthChecker().check();

      const response: StatusResponse = {
        status: 'operational',
        timestamp: Date.now(),
        metrics: {
          timestamp: Date.now(),
          queue: queueMetrics,
          workers: workerStats,
          scaling: {
            currentWorkers: this.workerPool.getSize(),
            targetWorkers: this.workerPool.getSize()
          }
        },
        health: healthCheck
      };

      res.json(response);
    } catch (err) {
      next(err);
    }
  }

  /**
   * Reprocess jobs from DLQ
   */
  private async reprocessDLQ(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { error, value } = reprocessDLQSchema.validate(req.body);

      if (error) {
        res.status(400).json({
          error: 'Validation error',
          details: error.details.map(d => d.message)
        });
        return;
      }

      const { jobIds, maxJobs } = value as ReprocessDLQRequest;

      const reprocessedIds = await this.queueManager.reprocessDLQ(jobIds, maxJobs);

      const response: ReprocessDLQResponse = {
        reprocessed: reprocessedIds.length,
        failed: 0,
        jobIds: reprocessedIds
      };

      res.json(response);
    } catch (err) {
      next(err);
    }
  }

  /**
   * Get DLQ jobs
   */
  private async getDLQJobs(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const metrics = await this.queueManager.getMetrics();

      res.json({
        count: metrics.dlqJobs,
        jobs: [] // Could be enhanced to return actual job details
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Manual scaling trigger
   */
  private async manualScale(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { error, value } = scaleSchema.validate(req.body);

      if (error) {
        res.status(400).json({
          error: 'Validation error',
          details: error.details.map(d => d.message)
        });
        return;
      }

      const { targetWorkers, strategy } = value as ScaleRequest;

      const previousWorkers = this.workerPool.getSize();

      if (targetWorkers !== undefined) {
        await this.autoScaler.manualScale(targetWorkers);
      }

      if (strategy) {
        this.autoScaler.setStrategy(strategy as ScalingStrategy);
      }

      const currentWorkers = this.workerPool.getSize();

      const response: ScaleResponse = {
        previousWorkers,
        currentWorkers,
        targetWorkers: currentWorkers,
        action: targetWorkers ? 'manual_scale' : 'strategy_change'
      };

      res.json(response);
    } catch (err) {
      next(err);
    }
  }

  /**
   * Cleanup old jobs
   */
  private async cleanup(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { error, value } = cleanupSchema.validate(req.body);

      if (error) {
        res.status(400).json({
          error: 'Validation error',
          details: error.details.map(d => d.message)
        });
        return;
      }

      const { removeExpired, removeCompleted, olderThan } = value as CleanupRequest;

      const removed = await this.queueManager.cleanup(
        removeExpired,
        removeCompleted,
        olderThan
      );

      const response: CleanupResponse = {
        removed,
        types: {
          expired: removeExpired ? removed : 0,
          completed: removeCompleted ? removed : 0
        }
      };

      res.json(response);
    } catch (err) {
      next(err);
    }
  }

  /**
   * Health check endpoint
   */
  private async healthCheck(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const health = await getHealthChecker().check();

      const statusCode = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 200 : 503;

      res.status(statusCode).json(health);
    } catch (err) {
      next(err);
    }
  }

  /**
   * Liveness check (K8s probe)
   */
  private async livenessCheck(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const isAlive = await getHealthChecker().liveness();

      if (isAlive) {
        res.status(200).json({ status: 'alive' });
      } else {
        res.status(503).json({ status: 'dead' });
      }
    } catch (err) {
      res.status(503).json({ status: 'dead', error: String(err) });
    }
  }

  /**
   * Readiness check (K8s probe)
   */
  private async readinessCheck(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const isReady = await getHealthChecker().readiness();

      if (isReady) {
        res.status(200).json({ status: 'ready' });
      } else {
        res.status(503).json({ status: 'not_ready' });
      }
    } catch (err) {
      res.status(503).json({ status: 'not_ready', error: String(err) });
    }
  }

  /**
   * Prometheus metrics endpoint
   */
  private async getMetrics(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const metrics = await getMetricsCollector().getMetrics();

      res.set('Content-Type', 'text/plain');
      res.send(metrics);
    } catch (err) {
      next(err);
    }
  }

  /**
   * Error handling middleware
   */
  private setupErrorHandling(): void {
    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({
        error: 'Not found',
        path: req.path
      });
    });

    // Error handler
    this.app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
      this.logger.error('API Error', {
        error: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method
      });

      res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    });
  }

  /**
   * Start the API server
   */
  public async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        this.logger.info('API Server started', { port: this.port });
        resolve();
      });
    });
  }

  /**
   * Stop the API server
   */
  public async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close((err: Error) => {
        if (err) {
          this.logger.error('Error stopping API server', { error: err });
          reject(err);
        } else {
          this.logger.info('API Server stopped');
          resolve();
        }
      });
    });
  }

  /**
   * Get Express app instance (for testing)
   */
  public getApp(): Express {
    return this.app;
  }
}
