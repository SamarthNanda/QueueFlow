/**
 * Mock Redis Client for Development/Testing
 * Allows running QueueFlow without Redis installed
 */

import { EventEmitter } from 'events';

export class MockRedisClient extends EventEmitter {
  private data: Map<string, any> = new Map();
  private sortedSets: Map<string, Map<string, number>> = new Map();
  private connected = true;

  async connect() {
    this.connected = true;
    this.emit('connect');
    this.emit('ready');
    return 'OK';
  }

  async ping(): Promise<string> {
    return 'PONG';
  }

  async quit(): Promise<string> {
    this.connected = false;
    this.emit('close');
    return 'OK';
  }

  // String operations
  async get(key: string): Promise<string | null> {
    return this.data.get(key) || null;
  }

  async set(key: string, value: string): Promise<string> {
    this.data.set(key, value);
    return 'OK';
  }

  async setex(key: string, seconds: number, value: string): Promise<string> {
    this.data.set(key, value);
    setTimeout(() => this.data.delete(key), seconds * 1000);
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    keys.forEach(key => {
      if (this.data.delete(key)) deleted++;
    });
    return deleted;
  }

  async exists(...keys: string[]): Promise<number> {
    return keys.filter(key => this.data.has(key)).length;
  }

  async expire(key: string, seconds: number): Promise<number> {
    if (this.data.has(key)) {
      setTimeout(() => this.data.delete(key), seconds * 1000);
      return 1;
    }
    return 0;
  }

  // Hash operations
  async hset(key: string, field: string, value: string): Promise<number> {
    let hash = this.data.get(key);
    if (!hash) {
      hash = new Map();
      this.data.set(key, hash);
    }
    const isNew = !hash.has(field);
    hash.set(field, value);
    return isNew ? 1 : 0;
  }

  async hget(key: string, field: string): Promise<string | null> {
    const hash = this.data.get(key);
    return hash ? hash.get(field) || null : null;
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    const hash = this.data.get(key);
    if (!hash) return 0;
    let deleted = 0;
    fields.forEach(field => {
      if (hash.delete(field)) deleted++;
    });
    return deleted;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const hash = this.data.get(key);
    if (!hash) return {};
    const result: Record<string, string> = {};
    hash.forEach((value: string, field: string) => {
      result[field] = value;
    });
    return result;
  }

  async hincrby(key: string, field: string, increment: number): Promise<number> {
    let hash = this.data.get(key);
    if (!hash) {
      hash = new Map();
      this.data.set(key, hash);
    }
    const current = parseInt(hash.get(field) || '0', 10);
    const newValue = current + increment;
    hash.set(field, newValue.toString());
    return newValue;
  }

  // Sorted Set operations
  async zadd(key: string, score: number, member: string): Promise<number> {
    let zset = this.sortedSets.get(key);
    if (!zset) {
      zset = new Map();
      this.sortedSets.set(key, zset);
    }
    const isNew = !zset.has(member);
    zset.set(member, score);
    return isNew ? 1 : 0;
  }

  async zrem(key: string, member: string): Promise<number> {
    const zset = this.sortedSets.get(key);
    return zset && zset.delete(member) ? 1 : 0;
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    const zset = this.sortedSets.get(key);
    if (!zset) return [];

    const sorted = Array.from(zset.entries()).sort((a, b) => a[1] - b[1]);
    const end = stop === -1 ? sorted.length : stop + 1;
    return sorted.slice(start, end).map(([member]) => member);
  }

  async zrangebyscore(key: string, min: number, max: number, ...args: any[]): Promise<string[]> {
    const zset = this.sortedSets.get(key);
    if (!zset) return [];

    let filtered = Array.from(zset.entries())
      .filter(([_, score]) => score >= min && score <= max)
      .sort((a, b) => a[1] - b[1])
      .map(([member]) => member);

    // Handle LIMIT option
    if (args.includes('LIMIT')) {
      const limitIndex = args.indexOf('LIMIT');
      const offset = args[limitIndex + 1];
      const count = args[limitIndex + 2];
      filtered = filtered.slice(offset, offset + count);
    }

    return filtered;
  }

  async zcard(key: string): Promise<number> {
    const zset = this.sortedSets.get(key);
    return zset ? zset.size : 0;
  }

  // Pub/Sub operations
  async publish(channel: string, message: string): Promise<number> {
    // Mock: just emit event, don't actually publish
    return 1;
  }

  async subscribe(...channels: string[]): Promise<void> {
    // Mock subscription
  }

  // Info
  async info(): Promise<string> {
    return 'redis_version:7.0.0-mock\r\nredis_mode:standalone\r\n';
  }

  // Pipeline
  pipeline() {
    const commands: any[] = [];
    const mock = {
      hset: (...args: any[]) => { commands.push(['hset', ...args]); return mock; },
      zadd: (...args: any[]) => { commands.push(['zadd', ...args]); return mock; },
      zrem: (...args: any[]) => { commands.push(['zrem', ...args]); return mock; },
      hdel: (...args: any[]) => { commands.push(['hdel', ...args]); return mock; },
      hincrby: (...args: any[]) => { commands.push(['hincrby', ...args]); return mock; },
      expire: (...args: any[]) => { commands.push(['expire', ...args]); return mock; },
      setex: (...args: any[]) => { commands.push(['setex', ...args]); return mock; },
      exec: async () => {
        const results = [];
        for (const [cmd, ...args] of commands) {
          const result = await (this as any)[cmd](...args);
          results.push([null, result]);
        }
        return results;
      }
    };
    return mock;
  }

  // Multi (transactions)
  multi() {
    return this.pipeline();
  }
}

export function createMockRedis() {
  return new MockRedisClient();
}
