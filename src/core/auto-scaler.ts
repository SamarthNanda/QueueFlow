/**
 * Auto-Scaler Implementation
 * Monitors queue metrics and scales workers based on configured strategy
 */

import { EventEmitter } from 'events';
import {
  ScalingConfig,
  ScalingMetrics,
  ScalingDecision,
  ScalingStrategy,
  QueueMetrics
} from '../types';
import { WorkerPool } from './worker';
import { QueueManager } from './queue-manager';
import { Logger } from '../utils/logger';

interface MetricsHistory {
  queueDepth: number[];
  processingRate: number[];
  errorRate: number[];
  timestamps: number[];
}

/**
 * Base Scaling Strategy Interface
 */
interface IScalingStrategy {
  evaluate(metrics: ScalingMetrics, history: MetricsHistory): ScalingDecision;
}

/**
 * Default Scaling Strategy
 * Simple threshold-based scaling
 */
class DefaultStrategy implements IScalingStrategy {
  constructor(private config: ScalingConfig) {}

  evaluate(metrics: ScalingMetrics): ScalingDecision {
    const { queueDepth, activeWorkers, errorRate } = metrics;
    const { scaleUpThreshold, scaleDownThreshold, minWorkers, maxWorkers } = this.config;

    // Emergency scale up if error rate is high
    if (errorRate > 20) {
      const targetWorkers = Math.min(activeWorkers + 2, maxWorkers);
      return {
        action: 'scale_up',
        targetWorkers,
        currentWorkers: activeWorkers,
        reason: `High error rate: ${errorRate.toFixed(2)}%`
      };
    }

    // Scale up if queue depth exceeds threshold
    if (queueDepth > scaleUpThreshold) {
      const increment = Math.ceil((queueDepth - scaleUpThreshold) / scaleUpThreshold);
      const targetWorkers = Math.min(activeWorkers + increment, maxWorkers);

      return {
        action: 'scale_up',
        targetWorkers,
        currentWorkers: activeWorkers,
        reason: `Queue depth (${queueDepth}) exceeds threshold (${scaleUpThreshold})`
      };
    }

    // Scale down if queue depth is below threshold
    if (queueDepth < scaleDownThreshold && activeWorkers > minWorkers) {
      const targetWorkers = Math.max(activeWorkers - 1, minWorkers);

      return {
        action: 'scale_down',
        targetWorkers,
        currentWorkers: activeWorkers,
        reason: `Queue depth (${queueDepth}) below threshold (${scaleDownThreshold})`
      };
    }

    return {
      action: 'none',
      targetWorkers: activeWorkers,
      currentWorkers: activeWorkers,
      reason: 'Queue depth within thresholds'
    };
  }
}

/**
 * Aggressive Scaling Strategy
 * Scales more aggressively to handle bursts
 */
class AggressiveStrategy implements IScalingStrategy {
  constructor(private config: ScalingConfig) {}

  evaluate(metrics: ScalingMetrics): ScalingDecision {
    const { queueDepth, activeWorkers, processingRate, errorRate } = metrics;
    const { scaleUpThreshold, scaleDownThreshold, minWorkers, maxWorkers } = this.config;

    // Very aggressive on error rate
    if (errorRate > 15) {
      const targetWorkers = Math.min(activeWorkers + 3, maxWorkers);
      return {
        action: 'scale_up',
        targetWorkers,
        currentWorkers: activeWorkers,
        reason: `Aggressive: High error rate ${errorRate.toFixed(2)}%`
      };
    }

    // Scale up aggressively if queue is growing
    if (queueDepth > scaleUpThreshold * 0.7) {
      const scaleFactor = Math.ceil(queueDepth / scaleUpThreshold);
      const targetWorkers = Math.min(activeWorkers + scaleFactor * 2, maxWorkers);

      return {
        action: 'scale_up',
        targetWorkers,
        currentWorkers: activeWorkers,
        reason: `Aggressive: Queue depth ${queueDepth}`
      };
    }

    // Conservative scale down (only when very low)
    if (queueDepth < scaleDownThreshold * 0.5 && activeWorkers > minWorkers) {
      const targetWorkers = Math.max(activeWorkers - 1, minWorkers);

      return {
        action: 'scale_down',
        targetWorkers,
        currentWorkers: activeWorkers,
        reason: `Aggressive: Very low queue depth ${queueDepth}`
      };
    }

    return {
      action: 'none',
      targetWorkers: activeWorkers,
      currentWorkers: activeWorkers,
      reason: 'Aggressive: Within acceptable range'
    };
  }
}

/**
 * Conservative Scaling Strategy
 * Scales slowly to avoid oscillation
 */
class ConservativeStrategy implements IScalingStrategy {
  constructor(private config: ScalingConfig) {}

  evaluate(metrics: ScalingMetrics): ScalingDecision {
    const { queueDepth, activeWorkers, errorRate } = metrics;
    const { scaleUpThreshold, scaleDownThreshold, minWorkers, maxWorkers } = this.config;

    // Only scale up on very high error rate
    if (errorRate > 30) {
      const targetWorkers = Math.min(activeWorkers + 1, maxWorkers);
      return {
        action: 'scale_up',
        targetWorkers,
        currentWorkers: activeWorkers,
        reason: `Conservative: Very high error rate ${errorRate.toFixed(2)}%`
      };
    }

    // Scale up only when significantly over threshold
    if (queueDepth > scaleUpThreshold * 1.5) {
      const targetWorkers = Math.min(activeWorkers + 1, maxWorkers);

      return {
        action: 'scale_up',
        targetWorkers,
        currentWorkers: activeWorkers,
        reason: `Conservative: Queue depth ${queueDepth} significantly over threshold`
      };
    }

    // Scale down more readily
    if (queueDepth < scaleDownThreshold * 0.8 && activeWorkers > minWorkers) {
      const targetWorkers = Math.max(activeWorkers - 1, minWorkers);

      return {
        action: 'scale_down',
        targetWorkers,
        currentWorkers: activeWorkers,
        reason: `Conservative: Low queue depth ${queueDepth}`
      };
    }

    return {
      action: 'none',
      targetWorkers: activeWorkers,
      currentWorkers: activeWorkers,
      reason: 'Conservative: Stable state'
    };
  }
}

/**
 * Predictive Scaling Strategy
 * Uses linear regression to predict future queue depth
 */
class PredictiveStrategy implements IScalingStrategy {
  private readonly LOOKBACK_POINTS = 10;
  private readonly PREDICTION_WINDOW = 60000; // 60 seconds

  constructor(private config: ScalingConfig) {}

  evaluate(metrics: ScalingMetrics, history: MetricsHistory): ScalingDecision {
    const { queueDepth, activeWorkers, errorRate } = metrics;
    const { scaleUpThreshold, scaleDownThreshold, minWorkers, maxWorkers } = this.config;

    // Need enough history for prediction
    if (history.queueDepth.length < 3) {
      // Fall back to default strategy
      return new DefaultStrategy(this.config).evaluate(metrics);
    }

    // Predict future queue depth
    const predictedDepth = this.predictQueueDepth(history);
    const growthRate = this.calculateGrowthRate(history);

    // Emergency scale on high error rate
    if (errorRate > 20) {
      const targetWorkers = Math.min(activeWorkers + 2, maxWorkers);
      return {
        action: 'scale_up',
        targetWorkers,
        currentWorkers: activeWorkers,
        reason: `Predictive: High error rate ${errorRate.toFixed(2)}%`,
        confidence: 0.9
      };
    }

    // Proactive scale up if prediction shows growth
    if (predictedDepth > scaleUpThreshold || growthRate > 0.3) {
      const urgency = Math.min(predictedDepth / scaleUpThreshold, 3);
      const increment = Math.ceil(urgency);
      const targetWorkers = Math.min(activeWorkers + increment, maxWorkers);

      return {
        action: 'scale_up',
        targetWorkers,
        currentWorkers: activeWorkers,
        reason: `Predictive: Predicted depth ${Math.round(predictedDepth)}, growth rate ${(growthRate * 100).toFixed(1)}%`,
        confidence: this.calculateConfidence(history)
      };
    }

    // Scale down if prediction shows decline
    if (predictedDepth < scaleDownThreshold && growthRate < -0.2 && activeWorkers > minWorkers) {
      const targetWorkers = Math.max(activeWorkers - 1, minWorkers);

      return {
        action: 'scale_down',
        targetWorkers,
        currentWorkers: activeWorkers,
        reason: `Predictive: Predicted depth ${Math.round(predictedDepth)}, declining trend`,
        confidence: this.calculateConfidence(history)
      };
    }

    return {
      action: 'none',
      targetWorkers: activeWorkers,
      currentWorkers: activeWorkers,
      reason: `Predictive: Predicted depth ${Math.round(predictedDepth)} within range`,
      confidence: this.calculateConfidence(history)
    };
  }

  /**
   * Predict future queue depth using linear regression
   */
  private predictQueueDepth(history: MetricsHistory): number {
    const recentDepths = history.queueDepth.slice(-this.LOOKBACK_POINTS);
    const recentTimestamps = history.timestamps.slice(-this.LOOKBACK_POINTS);

    if (recentDepths.length < 2) {
      return recentDepths[recentDepths.length - 1] || 0;
    }

    // Normalize timestamps to start from 0
    const baseTime = recentTimestamps[0];
    const x = recentTimestamps.map(t => (t - baseTime) / 1000); // Convert to seconds
    const y = recentDepths;

    // Calculate linear regression
    const n = x.length;
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumXX = x.reduce((sum, xi) => sum + xi * xi, 0);

    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;

    // Predict for prediction window ahead
    const futureX = (Date.now() + this.PREDICTION_WINDOW - baseTime) / 1000;
    const predicted = slope * futureX + intercept;

    return Math.max(0, predicted);
  }

  /**
   * Calculate queue growth rate
   */
  private calculateGrowthRate(history: MetricsHistory): number {
    const recent = history.queueDepth.slice(-5);
    if (recent.length < 2) return 0;

    const first = recent[0];
    const last = recent[recent.length - 1];

    if (first === 0) return last > 0 ? 1 : 0;

    return (last - first) / first;
  }

  /**
   * Calculate prediction confidence based on data variance
   */
  private calculateConfidence(history: MetricsHistory): number {
    const recent = history.queueDepth.slice(-this.LOOKBACK_POINTS);
    if (recent.length < 3) return 0.5;

    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = recent.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / recent.length;
    const stdDev = Math.sqrt(variance);

    // Lower variance = higher confidence
    const coefficientOfVariation = mean > 0 ? stdDev / mean : 1;
    const confidence = Math.max(0, Math.min(1, 1 - coefficientOfVariation));

    return confidence;
  }
}

/**
 * Auto-Scaler Main Class
 */
export class AutoScaler extends EventEmitter {
  private config: ScalingConfig;
  private workerPool: WorkerPool;
  private queueManager: QueueManager;
  private logger: Logger;
  private strategy: IScalingStrategy;
  private metricsHistory: MetricsHistory = {
    queueDepth: [],
    processingRate: [],
    errorRate: [],
    timestamps: []
  };
  private lastScalingTime = 0;
  private isRunning = false;
  private monitoringInterval: NodeJS.Timeout | null = null;
  private readonly HISTORY_SIZE = 50;
  private readonly MONITORING_INTERVAL = 10000; // 10 seconds

  constructor(
    config: ScalingConfig,
    workerPool: WorkerPool,
    queueManager: QueueManager
  ) {
    super();
    this.config = config;
    this.workerPool = workerPool;
    this.queueManager = queueManager;
    this.logger = Logger.forComponent('AutoScaler');
    this.strategy = this.createStrategy(config.strategy);
  }

  /**
   * Create strategy instance based on config
   */
  private createStrategy(strategyType: ScalingStrategy): IScalingStrategy {
    switch (strategyType) {
      case ScalingStrategy.AGGRESSIVE:
        return new AggressiveStrategy(this.config);
      case ScalingStrategy.CONSERVATIVE:
        return new ConservativeStrategy(this.config);
      case ScalingStrategy.PREDICTIVE:
        return new PredictiveStrategy(this.config);
      case ScalingStrategy.DEFAULT:
      default:
        return new DefaultStrategy(this.config);
    }
  }

  /**
   * Start the auto-scaler
   */
  public start(): void {
    if (this.isRunning) {
      this.logger.warn('Auto-scaler already running');
      return;
    }

    this.isRunning = true;

    this.logger.info('Auto-scaler starting', {
      strategy: this.config.strategy,
      minWorkers: this.config.minWorkers,
      maxWorkers: this.config.maxWorkers,
      scaleUpThreshold: this.config.scaleUpThreshold,
      scaleDownThreshold: this.config.scaleDownThreshold
    });

    // Start monitoring
    this.monitoringInterval = setInterval(
      () => this.evaluate(),
      this.MONITORING_INTERVAL
    );

    this.emit('started');
  }

  /**
   * Stop the auto-scaler
   */
  public stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;

    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    this.logger.info('Auto-scaler stopped');

    this.emit('stopped');
  }

  /**
   * Evaluate metrics and make scaling decision
   */
  public async evaluate(): Promise<ScalingDecision | null> {
    try {
      // Collect current metrics
      const queueMetrics = await this.queueManager.getMetrics();
      const activeWorkers = this.workerPool.getSize();

      const currentMetrics: ScalingMetrics = {
        queueDepth: queueMetrics.pendingJobs,
        processingRate: queueMetrics.processingRate,
        errorRate: queueMetrics.errorRate,
        activeWorkers,
        timestamp: Date.now()
      };

      // Update history
      this.updateHistory(currentMetrics);

      // Check cooldown period
      const timeSinceLastScaling = Date.now() - this.lastScalingTime;
      if (timeSinceLastScaling < this.config.cooldownPeriod) {
        this.logger.debug('In cooldown period', {
          remaining: this.config.cooldownPeriod - timeSinceLastScaling
        });
        return null;
      }

      // Evaluate scaling decision
      const decision = this.strategy.evaluate(currentMetrics, this.metricsHistory);

      this.logger.debug('Scaling decision', decision);

      // Execute scaling action
      if (decision.action !== 'none') {
        await this.executeScaling(decision);
      }

      this.emit('evaluation', { metrics: currentMetrics, decision });

      return decision;
    } catch (error) {
      this.logger.error('Auto-scaler evaluation failed', { error });
      this.emit('error', error);
      return null;
    }
  }

  /**
   * Execute scaling action
   */
  private async executeScaling(decision: ScalingDecision): Promise<void> {
    try {
      this.logger.info('Executing scaling action', decision);

      await this.workerPool.scaleTo(decision.targetWorkers);

      this.lastScalingTime = Date.now();

      this.emit('scaled', {
        action: decision.action,
        from: decision.currentWorkers,
        to: decision.targetWorkers,
        reason: decision.reason,
        confidence: decision.confidence
      });

    } catch (error) {
      this.logger.error('Failed to execute scaling', { error, decision });
      throw error;
    }
  }

  /**
   * Manual scaling trigger
   */
  public async manualScale(targetWorkers: number): Promise<void> {
    const currentWorkers = this.workerPool.getSize();

    this.logger.info('Manual scaling triggered', {
      from: currentWorkers,
      to: targetWorkers
    });

    await this.workerPool.scaleTo(targetWorkers);

    this.lastScalingTime = Date.now();

    this.emit('manual_scaled', {
      from: currentWorkers,
      to: targetWorkers
    });
  }

  /**
   * Update metrics history
   */
  private updateHistory(metrics: ScalingMetrics): void {
    this.metricsHistory.queueDepth.push(metrics.queueDepth);
    this.metricsHistory.processingRate.push(metrics.processingRate);
    this.metricsHistory.errorRate.push(metrics.errorRate);
    this.metricsHistory.timestamps.push(metrics.timestamp);

    // Trim history to max size
    if (this.metricsHistory.queueDepth.length > this.HISTORY_SIZE) {
      this.metricsHistory.queueDepth.shift();
      this.metricsHistory.processingRate.shift();
      this.metricsHistory.errorRate.shift();
      this.metricsHistory.timestamps.shift();
    }
  }

  /**
   * Change scaling strategy
   */
  public setStrategy(strategyType: ScalingStrategy): void {
    this.logger.info('Changing scaling strategy', {
      from: this.config.strategy,
      to: strategyType
    });

    this.config.strategy = strategyType;
    this.strategy = this.createStrategy(strategyType);

    this.emit('strategy_changed', { strategy: strategyType });
  }

  /**
   * Get metrics history
   */
  public getHistory(): MetricsHistory {
    return { ...this.metricsHistory };
  }

  /**
   * Reset cooldown (for manual scaling)
   */
  public resetCooldown(): void {
    this.lastScalingTime = 0;
    this.logger.info('Cooldown reset');
  }
}
