/**
 * WebSocket Server
 * Provides real-time updates for system metrics and events
 */

import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { WebSocketMessage, MetricsSnapshot } from '../types';
import { QueueManager } from '../core/queue-manager';
import { WorkerPool } from '../core/worker';
import { AutoScaler } from '../core/auto-scaler';
import { Logger } from '../utils/logger';

export class WebSocketHandler {
  private wss: WebSocketServer;
  private logger: Logger;
  private queueManager: QueueManager;
  private workerPool: WorkerPool;
  private autoScaler: AutoScaler;
  private clients: Set<WebSocket> = new Set();
  private metricsInterval: NodeJS.Timeout | null = null;
  private readonly UPDATE_INTERVAL = 2000; // 2 seconds

  constructor(
    server: Server,
    queueManager: QueueManager,
    workerPool: WorkerPool,
    autoScaler: AutoScaler
  ) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.logger = Logger.forComponent('WebSocket');
    this.queueManager = queueManager;
    this.workerPool = workerPool;
    this.autoScaler = autoScaler;

    this.setupWebSocket();
    this.setupEventListeners();
  }

  /**
   * Setup WebSocket server
   */
  private setupWebSocket(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      this.logger.info('WebSocket client connected', {
        totalClients: this.clients.size + 1
      });

      this.clients.add(ws);

      // Send initial data
      this.sendMetricsToClient(ws);

      // Handle messages from client
      ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleClientMessage(ws, message);
        } catch (error) {
          this.logger.error('Invalid WebSocket message', { error });
        }
      });

      // Handle client disconnect
      ws.on('close', () => {
        this.clients.delete(ws);
        this.logger.info('WebSocket client disconnected', {
          totalClients: this.clients.size
        });
      });

      // Handle errors
      ws.on('error', (error) => {
        this.logger.error('WebSocket error', { error });
        this.clients.delete(ws);
      });
    });

    this.logger.info('WebSocket server initialized');
  }

  /**
   * Setup event listeners for real-time updates
   */
  private setupEventListeners(): void {
    // Worker events
    this.workerPool.on('job:completed', (data) => {
      this.broadcast({
        type: 'job_update',
        timestamp: Date.now(),
        data: {
          event: 'completed',
          ...data
        }
      });
    });

    this.workerPool.on('job:failed', (data) => {
      this.broadcast({
        type: 'job_update',
        timestamp: Date.now(),
        data: {
          event: 'failed',
          ...data
        }
      });
    });

    this.workerPool.on('worker:added', (data) => {
      this.broadcast({
        type: 'worker_update',
        timestamp: Date.now(),
        data: {
          event: 'added',
          ...data
        }
      });
    });

    this.workerPool.on('worker:removed', (data) => {
      this.broadcast({
        type: 'worker_update',
        timestamp: Date.now(),
        data: {
          event: 'removed',
          ...data
        }
      });
    });

    // Scaling events
    this.autoScaler.on('scaled', (data) => {
      this.broadcast({
        type: 'scaling_event',
        timestamp: Date.now(),
        data
      });
    });

    this.autoScaler.on('strategy_changed', (data) => {
      this.broadcast({
        type: 'scaling_event',
        timestamp: Date.now(),
        data: {
          event: 'strategy_changed',
          ...data
        }
      });
    });
  }

  /**
   * Start broadcasting metrics periodically
   */
  public startMetricsBroadcast(): void {
    if (this.metricsInterval) {
      this.logger.warn('Metrics broadcast already started');
      return;
    }

    this.logger.info('Starting metrics broadcast', {
      interval: this.UPDATE_INTERVAL
    });

    this.metricsInterval = setInterval(() => {
      this.broadcastMetrics();
    }, this.UPDATE_INTERVAL);
  }

  /**
   * Stop broadcasting metrics
   */
  public stopMetricsBroadcast(): void {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
      this.logger.info('Metrics broadcast stopped');
    }
  }

  /**
   * Broadcast metrics to all connected clients
   */
  private async broadcastMetrics(): Promise<void> {
    if (this.clients.size === 0) return;

    try {
      const queueMetrics = await this.queueManager.getMetrics();
      const workerStats = this.workerPool.getAllStats();

      const snapshot: MetricsSnapshot = {
        timestamp: Date.now(),
        queue: queueMetrics,
        workers: workerStats,
        scaling: {
          currentWorkers: this.workerPool.getSize(),
          targetWorkers: this.workerPool.getSize()
        }
      };

      const message: WebSocketMessage = {
        type: 'metrics',
        timestamp: Date.now(),
        data: snapshot
      };

      this.broadcast(message);
    } catch (error) {
      this.logger.error('Failed to broadcast metrics', { error });
    }
  }

  /**
   * Send metrics to a specific client
   */
  private async sendMetricsToClient(ws: WebSocket): Promise<void> {
    try {
      const queueMetrics = await this.queueManager.getMetrics();
      const workerStats = this.workerPool.getAllStats();

      const snapshot: MetricsSnapshot = {
        timestamp: Date.now(),
        queue: queueMetrics,
        workers: workerStats,
        scaling: {
          currentWorkers: this.workerPool.getSize(),
          targetWorkers: this.workerPool.getSize()
        }
      };

      const message: WebSocketMessage = {
        type: 'metrics',
        timestamp: Date.now(),
        data: snapshot
      };

      this.sendToClient(ws, message);
    } catch (error) {
      this.logger.error('Failed to send metrics to client', { error });
    }
  }

  /**
   * Handle messages from client
   */
  private handleClientMessage(ws: WebSocket, message: any): void {
    this.logger.debug('Received client message', { message });

    switch (message.type) {
      case 'ping':
        this.sendToClient(ws, {
          type: 'metrics',
          timestamp: Date.now(),
          data: { pong: true }
        });
        break;

      case 'request_metrics':
        this.sendMetricsToClient(ws);
        break;

      default:
        this.logger.warn('Unknown message type', { type: message.type });
    }
  }

  /**
   * Broadcast message to all connected clients
   */
  private broadcast(message: WebSocketMessage): void {
    const payload = JSON.stringify(message);

    this.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(payload);
        } catch (error) {
          this.logger.error('Failed to send to client', { error });
        }
      }
    });
  }

  /**
   * Send message to specific client
   */
  private sendToClient(ws: WebSocket, message: WebSocketMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(message));
      } catch (error) {
        this.logger.error('Failed to send to client', { error });
      }
    }
  }

  /**
   * Get number of connected clients
   */
  public getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Close all connections and shutdown
   */
  public async shutdown(): Promise<void> {
    this.logger.info('Shutting down WebSocket server...');

    this.stopMetricsBroadcast();

    // Close all client connections
    this.clients.forEach((client) => {
      try {
        client.close(1000, 'Server shutting down');
      } catch (error) {
        this.logger.error('Error closing client connection', { error });
      }
    });

    this.clients.clear();

    // Close server
    return new Promise((resolve) => {
      this.wss.close(() => {
        this.logger.info('WebSocket server shut down');
        resolve();
      });
    });
  }
}
