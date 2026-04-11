import IORedis from 'ioredis';

declare global {
  // eslint-disable-next-line no-var
  var redisClientSingleton: IORedis | undefined;
}

function requireRedisUrl() {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is not configured');
  return url;
}

export function getRedisClient() {
  if (!global.redisClientSingleton) {
    global.redisClientSingleton = new IORedis(requireRedisUrl(), {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: true,
    });
  }
  return global.redisClientSingleton;
}
