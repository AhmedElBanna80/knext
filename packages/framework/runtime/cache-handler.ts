import { createClient } from 'redis';

// This matches the Next.js CacheHandler interface
// Reference: https://nextjs.org/docs/app/api-reference/next-config-js/incrementalCacheHandlerPath
export default class RedisCacheHandler {
  private client: any;
  private options: any;

  constructor(options: any) {
    this.options = options;
    this.client = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
    });

    this.client.on('error', (err: any) => console.error('Redis Client Error', err));
    this.client.connect();
  }

  async get(key: string) {
    try {
      const data = await this.client.get(key);
      if (!data) return null;
      return JSON.parse(data);
    } catch (error) {
      console.error('Cache get error:', error);
      return null;
    }
  }

  async set(key: string, data: any, ctx: any) {
    try {
      // ctx.tags could be used for tag-based revalidation if we implement it
      const ttl = ctx.revalidate || 31536000; // Default 1 year if not specified
      await this.client.set(key, JSON.stringify(data), {
        EX: ttl,
      });
    } catch (error) {
      console.error('Cache set error:', error);
    }
  }

  async revalidateTag(_tag: string) {}
}
