/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';
import { moveInOrder } from '@/lib/updates-logic';
import { readUpdatesOrder, writeUpdatesOrder } from '@/lib/updates-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_ORDER = 500;

async function authorize(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) return null;

  const config = await getConfig();
  if (authInfo.username !== process.env.USERNAME) {
    const user = config.UserConfig.Users.find(
      (u) => u.username === authInfo.username
    );
    if (!user || user.banned) return null;
  }
  return authInfo.username;
}

function sanitizeOrder(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const order: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const key = entry.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    order.push(key);
    if (order.length >= MAX_ORDER) break;
  }
  return order;
}

/** GET /api/updates/order —— 读取当前用户的手动排序。 */
export async function GET(request: NextRequest) {
  const username = await authorize(request);
  if (!username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const order = await readUpdatesOrder(username);
    return NextResponse.json({ order }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('读取更新排序失败', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

/**
 * POST /api/updates/order
 *
 * 两种调用方式：
 * - `{ order: string[] }` 整体覆盖（「重置排序」传空数组）；
 * - `{ move: string, position: 'top' | 'bottom', keys: string[] }` 把某一项移到首/末，
 *   服务端基于当前顺序与 keys 重新计算，避免前端与后端顺序不一致时丢项。
 */
export async function POST(request: NextRequest) {
  const username = await authorize(request);
  if (!username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
    }

    const payload = body as {
      order?: unknown;
      move?: unknown;
      position?: unknown;
      keys?: unknown;
    };

    if (payload.move !== undefined) {
      if (typeof payload.move !== 'string' || !payload.move.trim()) {
        return NextResponse.json({ error: 'move 必须是收藏键' }, { status: 400 });
      }
      if (payload.position !== 'top' && payload.position !== 'bottom') {
        return NextResponse.json(
          { error: "position 只能是 'top' 或 'bottom'" },
          { status: 400 }
        );
      }
      const keys = sanitizeOrder(payload.keys) ?? [];
      if (!keys.includes(payload.move)) {
        return NextResponse.json({ error: 'move 不在 keys 中' }, { status: 400 });
      }
      const current = await readUpdatesOrder(username);
      const next = moveInOrder(current, keys, payload.move, payload.position);
      await writeUpdatesOrder(username, next);
      return NextResponse.json(
        { order: next },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const order = sanitizeOrder(payload.order);
    if (!order) {
      return NextResponse.json(
        { error: 'order 必须是字符串数组' },
        { status: 400 }
      );
    }
    // 只保留仍然存在的收藏，避免收藏被删后留下死键。
    const favorites = await db.getAllFavorites(username);
    const alive = order.filter((key) => key in favorites);
    await writeUpdatesOrder(username, alive);
    return NextResponse.json(
      { order: alive },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('保存更新排序失败', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
