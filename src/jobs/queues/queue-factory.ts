import { Queue, Worker, QueueEvents, JobsOptions, WorkerOptions, Processor } from 'bullmq';
import { getRedisClient } from '@/src/lib/redis/client';
import type { QueueName } from './queue-names';

const queueCache = new Map<string, Queue<unknown>>();
const queueEventsCache = new Map<string, QueueEvents>();

function getSharedConnection() {
  return getRedisClient();
}

function getOrCreateQueue<T = unknown>(name: QueueName, defaultJobOptions?: JobsOptions) {
  const cacheKey = `${name}:${JSON.stringify(defaultJobOptions ?? {})}`;
  const existing = queueCache.get(cacheKey);
  if (existing) {
    return existing as Queue<T>;
  }

  const queue = new Queue<T>(name, {
    connection: getSharedConnection(),
    defaultJobOptions,
  });

  queueCache.set(cacheKey, queue as Queue<unknown>);
  return queue;
}

export function createQueue<T = unknown>(name: QueueName, defaultJobOptions?: JobsOptions) {
  return new Proxy({} as Queue<T>, {
    get(_target, property, receiver) {
      const queue = getOrCreateQueue<T>(name, defaultJobOptions);
      const value = Reflect.get(queue, property, receiver);
      return typeof value === 'function' ? value.bind(queue) : value;
    },
  });
}

export function createWorker<T = unknown>(name: QueueName, processor: Processor<T, any, string>, options?: Omit<WorkerOptions, 'connection'>) {
  return new Worker<T>(name, processor, {
    connection: getSharedConnection(),
    ...options,
  });
}

export function createQueueEvents(name: QueueName) {
  const existing = queueEventsCache.get(name);
  if (existing) {
    return existing;
  }

  const events = new QueueEvents(name, { connection: getSharedConnection() });
  queueEventsCache.set(name, events);
  return events;
}
