/**
 * Redis Client Utility
 * Provides connection pooling and circuit breaker for Redis operations
 */

import Redis, { Redis as RedisClient, Cluster } from 'ioredis';
import { RedisConfig, CircuitBreakerState, CircuitBreakerConfig, RedisConnectionError } from '../types';
import { logger } from './logger';
import { MockRedisClient } from './mock-redis';

class CircuitBreaker {
  private state: CircuitBreakerState = CircuitBreakerState.CLOSED;
  private failures = 0;
  private lastFailureTime = 0;
  private successCount = 0;

  constructor(private config: CircuitBreakerConfig) {}

  public async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.config.enabled) {
      return operation();
    }

    if (this.state === CircuitBreakerState.OPEN) {
      const now = Date.now();
      if (now - this.lastFailureTime >= this.config.timeout) {
        this.state = CircuitBreakerState.HALF_OPEN;
        this.successCount = 0;
        logger.info('Circuit breaker transitioning to HALF_OPEN');
      } else {
        throw new RedisConnectionError('Circuit breaker is OPEN', {
          state: this.state,
          failures: this.failures
        });
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    if (this.state === CircuitBreakerState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= 3) {
        this.state = CircuitBreakerState.CLOSED;
        logger.info('Circuit breaker transitioning to CLOSED');
      }
    }
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.failures >= this.config.threshold) {
      this.state = CircuitBreakerState.OPEN;
      logger.error('Circuit breaker transitioning to OPEN', {
        failures: this.failures,
        threshold: this.config.threshold
      });
    }
  }

  public getState(): CircuitBreakerState {
    return this.state;
  }

  public reset(): void {
    this.state = CircuitBreakerState.CLOSED;
    this.failures = 0;
    this.successCount = 0;
  }
}

export class RedisClientManager {
  private client: RedisClient | any | null = null;
  private subscriber: RedisClient | any | null = null;
  private publisher: RedisClient | any | null = null;
  private circuitBreaker: CircuitBreaker;
  private config: RedisConfig;
  private isConnected = false;
  private useMock = false;

  constructor(config: RedisConfig, circuitBreakerConfig: CircuitBreakerConfig) {
    this.config = config;
    this.circuitBreaker = new CircuitBreaker(circuitBreakerConfig);
  }

  /**
   * Initialize Redis connections
   */
  public async connect(): Promise<void> {
    // Check if user wants to force mock mode
    const forceMock = process.env.USE_MOCK_REDIS === 'true';

    if (forceMock) {
      logger.warn('Using Mock Redis (USE_MOCK_REDIS=true)');
      return this.connectMock();
    }

    try {
      logger.info('Connecting to Redis...', {
        host: this.config.host,
        port: this.config.port,
        db: this.config.db
      });

      const redisOptions = {
        host: this.config.host,
        port: this.config.port,
        password: this.config.password,
        db: this.config.db,
        keyPrefix: this.config.keyPrefix,
        retryStrategy: (times: number) => {
          if (times > 2) {
            logger.warn('Redis connection failed, falling back to Mock Redis');
            return null; // Stop retrying
          }
          const delay = Math.min(times * 50, 500);
          return delay;
        },
        maxRetriesPerRequest: 2,
        enableReadyCheck: true,
        enableOfflineQueue: false,
        lazyConnect: true,
        connectTimeout: 3000
      };

      // Main client for commands
      this.client = new Redis(redisOptions);

      // Separate client for pub/sub subscriber
      this.subscriber = new Redis(redisOptions);

      // Separate client for pub/sub publisher
      this.publisher = new Redis(redisOptions);

      // Set up event handlers
      this.setupEventHandlers(this.client, 'main');
      this.setupEventHandlers(this.subscriber, 'subscriber');
      this.setupEventHandlers(this.publisher, 'publisher');

      // Try to connect with timeout
      await Promise.race([
        Promise.all([
          this.client.connect(),
          this.subscriber.connect(),
          this.publisher.connect()
        ]),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Connection timeout')), 5000)
        )
      ]);

      await Promise.all([
        this.client.ping(),
        this.subscriber.ping(),
        this.publisher.ping()
      ]);

      this.isConnected = true;
      this.circuitBreaker.reset();
      this.useMock = false;

      logger.info('Redis connected successfully');
    } catch (error) {
      logger.warn('Failed to connect to Redis, using Mock Redis for development', { error });
      // Fall back to mock Redis
      await this.connectMock();
    }
  }

  /**
   * Connect using Mock Redis (for development/testing)
   */
  private async connectMock(): Promise<void> {
    logger.info('Initializing Mock Redis (in-memory storage)...');

    this.client = new MockRedisClient() as any;
    this.subscriber = new MockRedisClient() as any;
    this.publisher = new MockRedisClient() as any;

    await this.client.connect();
    await this.subscriber.connect();
    await this.publisher.connect();

    this.isConnected = true;
    this.useMock = true;
    this.circuitBreaker.reset();

    logger.info('Mock Redis initialized successfully - Running in DEVELOPMENT MODE');
  }

  /**
   * Set up event handlers for Redis client
   */
  private setupEventHandlers(client: RedisClient, name: string): void {
    client.on('error', (error) => {
      logger.error(`Redis ${name} client error`, { error: error.message });
      this.isConnected = false;
    });

    client.on('connect', () => {
      logger.info(`Redis ${name} client connected`);
    });

    client.on('ready', () => {
      logger.info(`Redis ${name} client ready`);
      this.isConnected = true;
    });

    client.on('close', () => {
      logger.warn(`Redis ${name} client closed`);
      this.isConnected = false;
    });

    client.on('reconnecting', () => {
      logger.info(`Redis ${name} client reconnecting...`);
    });
  }

  /**
   * Execute a Redis command with circuit breaker
   */
  public async execute<T>(operation: (client: RedisClient) => Promise<T>): Promise<T> {
    if (!this.client) {
      throw new RedisConnectionError('Redis client not initialized');
    }

    return this.circuitBreaker.execute(() => operation(this.client!));
  }

  /**
   * Get the main Redis client
   */
  public getClient(): RedisClient {
    if (!this.client) {
      throw new RedisConnectionError('Redis client not initialized');
    }
    return this.client;
  }

  /**
   * Get the subscriber client for pub/sub
   */
  public getSubscriber(): RedisClient {
    if (!this.subscriber) {
      throw new RedisConnectionError('Redis subscriber not initialized');
    }
    return this.subscriber;
  }

  /**
   * Get the publisher client for pub/sub
   */
  public getPublisher(): RedisClient {
    if (!this.publisher) {
      throw new RedisConnectionError('Redis publisher not initialized');
    }
    return this.publisher;
  }

  /**
   * Check if Redis is connected
   */
  public isHealthy(): boolean {
    return this.isConnected && this.circuitBreaker.getState() !== CircuitBreakerState.OPEN;
  }

  /**
   * Get circuit breaker state
   */
  public getCircuitBreakerState(): CircuitBreakerState {
    return this.circuitBreaker.getState();
  }

  /**
   * Ping Redis to check connectivity
   */
  public async ping(): Promise<boolean> {
    try {
      if (!this.client) return false;
      const result = await this.client.ping();
      return result === 'PONG';
    } catch (error) {
      logger.error('Redis ping failed', { error });
      return false;
    }
  }

  /**
   * Get Redis info
   */
  public async getInfo(): Promise<string> {
    if (!this.client) {
      throw new RedisConnectionError('Redis client not initialized');
    }
    return this.client.info();
  }

  /**
   * Gracefully disconnect from Redis
   */
  public async disconnect(): Promise<void> {
    logger.info('Disconnecting from Redis...');

    const disconnectPromises: Promise<any>[] = [];

    if (this.client) {
      disconnectPromises.push(this.client.quit());
    }
    if (this.subscriber) {
      disconnectPromises.push(this.subscriber.quit());
    }
    if (this.publisher) {
      disconnectPromises.push(this.publisher.quit());
    }

    await Promise.all(disconnectPromises);

    this.client = null;
    this.subscriber = null;
    this.publisher = null;
    this.isConnected = false;

    logger.info('Redis disconnected successfully');
  }

  /**
   * Create a Redis pipeline for batch operations
   */
  public pipeline() {
    if (!this.client) {
      throw new RedisConnectionError('Redis client not initialized');
    }
    return this.client.pipeline();
  }

  /**
   * Create a Redis multi (transaction)
   */
  public multi() {
    if (!this.client) {
      throw new RedisConnectionError('Redis client not initialized');
    }
    return this.client.multi();
  }
}

// Singleton instance
let redisClientManager: RedisClientManager | null = null;

/**
 * Initialize the Redis client manager
 */
export function initializeRedis(
  config: RedisConfig,
  circuitBreakerConfig: CircuitBreakerConfig
): RedisClientManager {
  if (!redisClientManager) {
    redisClientManager = new RedisClientManager(config, circuitBreakerConfig);
  }
  return redisClientManager;
}

/**
 * Get the Redis client manager instance
 */
export function getRedisClient(): RedisClientManager {
  if (!redisClientManager) {
    throw new RedisConnectionError('Redis client manager not initialized. Call initializeRedis first.');
  }
  return redisClientManager;
}

/**
 * Disconnect and cleanup Redis
 */
export async function disconnectRedis(): Promise<void> {
  if (redisClientManager) {
    await redisClientManager.disconnect();
    redisClientManager = null;
  }
}
