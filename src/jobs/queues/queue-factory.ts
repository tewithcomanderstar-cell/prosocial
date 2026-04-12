import { Queue, Worker, QueueEvents, JobsOptions, WorkerOptions, Processor } from 'bullmq';
import { getRedisClient } from '@/src/lib/redis/client';
import type { QueueName } from './queue-names';

const sharedConnection = getRedisClient();

export function createQueue<T = unknown>(name: QueueName, defaultJobOptions?: JobsOptions) {
  return new Queue<T>(name, {
    connection: sharedConnection,
    defaultJobOptions,
  });
}

export function createWorker<T = unknown>(name: QueueName, processor: Processor<T, any, string>, options?: Omit<WorkerOptions, 'connection'>) {
  return new Worker<T>(name, processor, {
    connection: sharedConnection,
    ...options,
  });
}

export function createQueueEvents(name: QueueName) {
  return new QueueEvents(name, { connection: sharedConnection });
}
