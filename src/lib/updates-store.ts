import { Redis } from '@upstash/redis';
import type { RedisClientType } from 'redis';

import { createRedisClient } from './redis-base.db';
import type { UpdatesOrder, UpdatesSnapshot } from './updates.types';

/** 快照保留 6 小时；过期后页面会重新回源核对集数。 */
export const UPDATES_CACHE_SECONDS = 6 * 60 * 60;

export function updatesStorageKey(username: string): string {
  return `u:${username}:updates`;
}

/** 手动排序不属于缓存，不设过期时间，跟着用户走。 */
export function updatesOrderKey(username: string): string {
  return `u:${username}:updates:order`;
}

const REDIS_GLOBAL_SYMBOL = Symbol.for('__MOONTV_REDIS_CLIENT__');
const KVROCKS_GLOBAL_SYMBOL = Symbol.for('__MOONTV_KVROCKS_CLIENT__');

let upstashClient: Redis | null = null;

function getUpstashClient(): Redis {
  if (upstashClient) return upstashClient;
  const url = process.env.UPSTASH_URL;
  const token = process.env.UPSTASH_TOKEN;
  if (!url || !token) {
    throw new Error('UPSTASH_URL and UPSTASH_TOKEN env variables must be set');
  }
  upstashClient = new Redis({ url, token });
  return upstashClient;
}

export type UpdatesStorageType = 'redis' | 'upstash' | 'kvrocks' | 'localstorage';

export function updatesStorageType(): UpdatesStorageType {
  return (process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage') as UpdatesStorageType;
}

/**
 * 复用数据层已经建立的 Redis 连接（同一个 globalSymbol 客户端），
 * 避免为更新快照再开一条连接，也避免重复 connect() 抛 "Socket already opened"。
 */
async function getRedisClient(type: 'redis' | 'kvrocks'): Promise<RedisClientType> {
  const url =
    type === 'kvrocks' ? process.env.KVROCKS_URL || '' : process.env.REDIS_URL || '';
  const client = createRedisClient(
    { url, clientName: type === 'kvrocks' ? 'Kvrocks' : 'Redis' },
    type === 'kvrocks' ? KVROCKS_GLOBAL_SYMBOL : REDIS_GLOBAL_SYMBOL
  );
  if (client.isReady) return client;

  const deadline = Date.now() + 10_000;
  while (!client.isReady) {
    if (Date.now() > deadline) throw new Error('Redis 连接超时');
    if (!client.isOpen) await client.connect().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return client;
}

export async function readUpdatesSnapshot(
  username: string
): Promise<UpdatesSnapshot | null> {
  const type = updatesStorageType();
  if (type === 'localstorage') return null;

  const key = updatesStorageKey(username);

  if (type === 'upstash') {
    const value = await getUpstashClient().get<UpdatesSnapshot>(key);
    return value || null;
  }

  const client = await getRedisClient(type);
  const value = await client.get(key);
  if (!value) return null;
  try {
    return JSON.parse(value) as UpdatesSnapshot;
  } catch {
    return null;
  }
}

export async function writeUpdatesSnapshot(
  username: string,
  snapshot: UpdatesSnapshot
): Promise<void> {
  const type = updatesStorageType();
  if (type === 'localstorage') return;

  const key = updatesStorageKey(username);

  if (type === 'upstash') {
    await getUpstashClient().set(key, snapshot, { ex: UPDATES_CACHE_SECONDS });
    return;
  }

  const client = await getRedisClient(type);
  await client.set(key, JSON.stringify(snapshot), { EX: UPDATES_CACHE_SECONDS });
}

/** 读取用户手动排序；没有时返回空顺序。 */
export async function readUpdatesOrder(username: string): Promise<string[]> {
  const type = updatesStorageType();
  if (type === 'localstorage') return [];

  const key = updatesOrderKey(username);

  if (type === 'upstash') {
    const value = await getUpstashClient().get<UpdatesOrder>(key);
    if (!value) return [];
    return Array.isArray(value.order) ? value.order : [];
  }

  const client = await getRedisClient(type);
  const value = await client.get(key);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as UpdatesOrder;
    return Array.isArray(parsed?.order) ? parsed.order : [];
  } catch {
    return [];
  }
}

/** 写入用户手动排序；传空数组等同于清空自定义顺序。 */
export async function writeUpdatesOrder(
  username: string,
  order: string[]
): Promise<void> {
  const type = updatesStorageType();
  if (type === 'localstorage') return;

  const key = updatesOrderKey(username);
  const payload: UpdatesOrder = { order };

  if (type === 'upstash') {
    if (order.length === 0) {
      await getUpstashClient().del(key);
      return;
    }
    await getUpstashClient().set(key, payload);
    return;
  }

  const client = await getRedisClient(type);
  if (order.length === 0) {
    await client.del(key);
    return;
  }
  await client.set(key, JSON.stringify(payload));
}

