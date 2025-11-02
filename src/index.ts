/**
 * QueueFlow - Distributed Task Queue with Auto-Scaling
 * Main Entry Point
 */

import dotenv from 'dotenv';
import http from 'http';
import { QueueManager } from './core/queue-manager';
import { WorkerPool } from './core/worker';
import { AutoScaler } from './core/auto-scaler';
import { APIServer } from './api/server';
import { WebSocketHandler } from './api/websocket';
import { initializeRedis, disconnectRedis } from './utils/redis-client';
import { logger, Logger } from './utils/logger';
import { getMetricsCollector } from './monitoring/metrics';
import { getHealthChecker } from './monitoring/health';
import {
  QueueConfig,
  WorkerPoolConfig,
  ScalingConfig,
  RedisConfig,
  CircuitBreakerConfig,
  JobHandler
} from './types';

// Load environment variables
dotenv.config();

/**
 * QueueFlow Application Class
 */
class QueueFlowApp {
  private queueManager!: QueueManager;
  private workerPool!: WorkerPool;
  private autoScaler!: AutoScaler;
  private apiServer!: APIServer;
  private websocketHandler!: WebSocketHandler;
  private httpServer!: http.Server;
  private logger: Logger;
  private isShuttingDown = false;

  constructor() {
    this.logger = Logger.forComponent('QueueFlowApp');
  }

  /**
   * Initialize all components
   */
  public async initialize(): Promise<void> {
    try {
      this.logger.info('Initializing QueueFlow...');

      // Load configuration
      const config = this.loadConfiguration();

      // Initialize Redis
      this.logger.info('Connecting to Redis...');
      const redis = initializeRedis(config.redis, config.circuitBreaker);
      await redis.connect();

      // Initialize Queue Manager
      this.logger.info('Initializing Queue Manager...');
      this.queueManager = new QueueManager(redis, config.queue);

      // Initialize Worker Pool
      this.logger.info('Initializing Worker Pool...');
      this.workerPool = new WorkerPool(config.workerPool, this.queueManager);

      // Register job handlers
      const handlers = this.registerJobHandlers();
      await this.workerPool.initialize(handlers);

      // Initialize Auto-Scaler
      this.logger.info('Initializing Auto-Scaler...');
      this.autoScaler = new AutoScaler(
        config.scaling,
        this.workerPool,
        this.queueManager
      );

      // Initialize Monitoring
      this.logger.info('Initializing monitoring...');
      const metricsCollector = getMetricsCollector();
      metricsCollector.setQueueManager(this.queueManager);
      metricsCollector.setWorkerPool(this.workerPool);
      metricsCollector.startCollection();

      const healthChecker = getHealthChecker();
      healthChecker.setRedis(redis);
      healthChecker.setQueueManager(this.queueManager);
      healthChecker.setWorkerPool(this.workerPool);

      // Initialize API Server
      this.logger.info('Initializing API Server...');
      this.apiServer = new APIServer(
        config.apiPort,
        this.queueManager,
        this.workerPool,
        this.autoScaler
      );

      // Create HTTP server for WebSocket
      this.httpServer = http.createServer(this.apiServer.getApp());

      // Initialize WebSocket
      if (config.enableWebSocket) {
        this.logger.info('Initializing WebSocket...');
        this.websocketHandler = new WebSocketHandler(
          this.httpServer,
          this.queueManager,
          this.workerPool,
          this.autoScaler
        );
      }

      this.logger.info('QueueFlow initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize QueueFlow', { error });
      throw error;
    }
  }

  /**
   * Start the application
   */
  public async start(): Promise<void> {
    try {
      this.logger.info('Starting QueueFlow...');

      // Start Auto-Scaler
      this.autoScaler.start();

      // Start API Server
      await this.startHTTPServer();

      // Start WebSocket metrics broadcast
      if (this.websocketHandler) {
        this.websocketHandler.startMetricsBroadcast();
      }

      // Setup graceful shutdown
      this.setupGracefulShutdown();

      this.logger.info('QueueFlow started successfully', {
        apiPort: process.env.API_PORT,
        workers: this.workerPool.getSize()
      });

      // Log system info
      this.logSystemInfo();

    } catch (error) {
      this.logger.error('Failed to start QueueFlow', { error });
      throw error;
    }
  }

  /**
   * Start HTTP server
   */
  private async startHTTPServer(): Promise<void> {
    return new Promise((resolve) => {
      const port = parseInt(process.env.API_PORT || '3000', 10);
      this.httpServer.listen(port, () => {
        this.logger.info('HTTP Server started', { port });
        resolve();
      });
    });
  }

  /**
   * Graceful shutdown
   */
  public async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      this.logger.warn('Shutdown already in progress');
      return;
    }

    this.isShuttingDown = true;

    this.logger.info('Shutting down QueueFlow...');

    try {
      // Stop accepting new requests
      this.logger.info('Stopping API server...');
      await this.apiServer.stop();

      // Stop WebSocket
      if (this.websocketHandler) {
        this.logger.info('Stopping WebSocket...');
        await this.websocketHandler.shutdown();
      }

      // Stop Auto-Scaler
      this.logger.info('Stopping Auto-Scaler...');
      this.autoScaler.stop();

      // Stop metrics collection
      this.logger.info('Stopping metrics collection...');
      getMetricsCollector().stopCollection();

      // Stop Worker Pool
      this.logger.info('Stopping workers...');
      await this.workerPool.shutdown(30000);

      // Disconnect from Redis
      this.logger.info('Disconnecting from Redis...');
      await disconnectRedis();

      this.logger.info('QueueFlow shut down successfully');

      process.exit(0);
    } catch (error) {
      this.logger.error('Error during shutdown', { error });
      process.exit(1);
    }
  }

  /**
   * Setup graceful shutdown handlers
   */
  private setupGracefulShutdown(): void {
    const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

    signals.forEach((signal) => {
      process.on(signal, async () => {
        this.logger.info(`Received ${signal}, shutting down gracefully...`);
        await this.shutdown();
      });
    });

    process.on('uncaughtException', (error) => {
      this.logger.error('Uncaught exception', { error });
      this.shutdown();
    });

    process.on('unhandledRejection', (reason, promise) => {
      this.logger.error('Unhandled rejection', { reason, promise });
      this.shutdown();
    });
  }

  /**
   * Load configuration from environment
   */
  private loadConfiguration() {
    const redisConfig: RedisConfig = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD,
      db: parseInt(process.env.REDIS_DB || '0', 10),
      keyPrefix: process.env.REDIS_KEY_PREFIX || 'queueflow:',
      poolSize: parseInt(process.env.REDIS_POOL_SIZE || '10', 10)
    };

    const queueConfig: QueueConfig = {
      redisHost: redisConfig.host,
      redisPort: redisConfig.port,
      redisPassword: redisConfig.password,
      redisDb: redisConfig.db,
      keyPrefix: redisConfig.keyPrefix,
      highPriorityWeight: parseInt(process.env.HIGH_PRIORITY_WEIGHT || '60', 10),
      normalPriorityWeight: parseInt(process.env.NORMAL_PRIORITY_WEIGHT || '30', 10),
      lowPriorityWeight: parseInt(process.env.LOW_PRIORITY_WEIGHT || '10', 10),
      defaultMaxRetries: parseInt(process.env.DEFAULT_MAX_RETRIES || '3', 10),
      dlqRetentionDays: parseInt(process.env.DLQ_RETENTION_DAYS || '7', 10),
      batchSize: parseInt(process.env.BATCH_SIZE || '100', 10)
    };

    const workerPoolConfig: WorkerPoolConfig = {
      minWorkers: parseInt(process.env.MIN_WORKERS || '2', 10),
      maxWorkers: parseInt(process.env.MAX_WORKERS || '20', 10),
      workerConcurrency: parseInt(process.env.WORKER_CONCURRENCY || '5', 10),
      heartbeatInterval: parseInt(process.env.WORKER_HEARTBEAT_INTERVAL || '5000', 10),
      jobTimeout: parseInt(process.env.JOB_TIMEOUT || '30000', 10)
    };

    const scalingConfig: ScalingConfig = {
      minWorkers: workerPoolConfig.minWorkers,
      maxWorkers: workerPoolConfig.maxWorkers,
      scaleUpThreshold: parseInt(process.env.SCALE_UP_THRESHOLD || '100', 10),
      scaleDownThreshold: parseInt(process.env.SCALE_DOWN_THRESHOLD || '10', 10),
      cooldownPeriod: parseInt(process.env.COOLDOWN_PERIOD || '60000', 10),
      strategy: (process.env.SCALING_STRATEGY || 'default') as any,
      enableKubernetes: process.env.ENABLE_KUBERNETES === 'true',
      enablePredictive: process.env.ENABLE_PREDICTIVE === 'true'
    };

    const circuitBreakerConfig: CircuitBreakerConfig = {
      threshold: parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD || '5', 10),
      timeout: parseInt(process.env.CIRCUIT_BREAKER_TIMEOUT || '30000', 10),
      enabled: process.env.ENABLE_CIRCUIT_BREAKER === 'true'
    };

    return {
      redis: redisConfig,
      queue: queueConfig,
      workerPool: workerPoolConfig,
      scaling: scalingConfig,
      circuitBreaker: circuitBreakerConfig,
      apiPort: parseInt(process.env.API_PORT || '3000', 10),
      metricsPort: parseInt(process.env.METRICS_PORT || '9090', 10),
      enableWebSocket: process.env.ENABLE_WEBSOCKET !== 'false'
    };
  }

  /**
   * Register job handlers
   * This is where you define how different job types are processed
   */
  private registerJobHandlers(): Map<string, JobHandler> {
    const handlers = new Map<string, JobHandler>();

    // Example: Image processing job
    handlers.set('process-image', async (payload, job) => {
      this.logger.info('Processing image', { jobId: job.id, payload });

      // Simulate processing
      await new Promise(resolve => setTimeout(resolve, 1000));

      return {
        success: true,
        processedAt: Date.now(),
        operations: payload.operations
      };
    });

    // Example: Email sending job
    handlers.set('send-email', async (payload, job) => {
      this.logger.info('Sending email', { jobId: job.id, to: payload.to });

      // Simulate email sending
      await new Promise(resolve => setTimeout(resolve, 500));

      return {
        success: true,
        sentAt: Date.now(),
        messageId: `msg-${Date.now()}`
      };
    });

    // Example: Data processing job
    handlers.set('process-data', async (payload, job) => {
      this.logger.info('Processing data', { jobId: job.id, recordCount: payload.records?.length });

      // Simulate data processing
      await new Promise(resolve => setTimeout(resolve, 2000));

      return {
        success: true,
        recordsProcessed: payload.records?.length || 0,
        processedAt: Date.now()
      };
    });

    // Example: Report generation job
    handlers.set('generate-report', async (payload, job) => {
      this.logger.info('Generating report', { jobId: job.id, reportType: payload.type });

      // Simulate report generation
      await new Promise(resolve => setTimeout(resolve, 5000));

      return {
        success: true,
        reportUrl: `https://example.com/reports/${job.id}.pdf`,
        generatedAt: Date.now()
      };
    });

    // Default handler for unknown job types
    handlers.set('default', async (payload, job) => {
      this.logger.warn('Using default handler', { jobId: job.id, type: job.type });

      return {
        success: true,
        message: 'Processed with default handler',
        processedAt: Date.now()
      };
    });

    return handlers;
  }

  /**
   * Log system information
   */
  private logSystemInfo(): void {
    const info = {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      memory: {
        total: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB`,
        used: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`
      },
      uptime: process.uptime()
    };

    this.logger.info('System Information', info);
  }
}

/**
 * Main execution
 */
async function main() {
  const app = new QueueFlowApp();

  try {
    await app.initialize();
    await app.start();
  } catch (error) {
    logger.error('Failed to start application', { error });
    process.exit(1);
  }
}

// Start the application
if (require.main === module) {
  main();
}

export { QueueFlowApp };
