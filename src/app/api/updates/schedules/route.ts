/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getBangumiSchedule } from '@/lib/bangumi-schedule';
import { getConfig } from '@/lib/config';
import type { ScheduleItem, SchedulesResponse } from '@/lib/updates.types';
import { mapWithConcurrency } from '@/lib/updates-logic';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_ITEMS = 200;
const SCHEDULE_CONCURRENCY = 4;

const STORAGE_TYPE =
  (process.env.NEXT_PUBLIC_STORAGE_TYPE as string | undefined) || 'localstorage';

interface RequestItem {
  key?: unknown;
  title?: unknown;
  search_title?: unknown;
  year?: unknown;
}

function sanitizeText(value: unknown, maxLength = 200): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

async function authorize(request: NextRequest): Promise<boolean> {
  // localStorage 模式没有服务端用户，收藏与排期都在浏览器里。
  if (STORAGE_TYPE === 'localstorage') return true;

  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) return false;

  const config = await getConfig();
  if (authInfo.username === process.env.USERNAME) return true;

  const user = config.UserConfig.Users.find(
    (u) => u.username === authInfo.username
  );
  return Boolean(user) && !user?.banned;
}

/**
 * POST /api/updates/schedules
 *
 * 只为标题补查 Bangumi 放送星期，不触碰收藏和集数。
 * 供 localStorage 模式的前端在本地拼装周历使用。
 */
export async function POST(request: NextRequest) {
  if (!(await authorize(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = (await request.json()) as { items?: unknown };
    if (!Array.isArray(body?.items)) {
      return NextResponse.json(
        { error: 'items 必须是数组' },
        { status: 400 }
      );
    }

    const items = (body.items as RequestItem[])
      .slice(0, MAX_ITEMS)
      .map((item) => ({
        key: sanitizeText(item?.key),
        title: sanitizeText(item?.title),
        searchTitle: sanitizeText(item?.search_title),
        year: sanitizeText(item?.year, 20),
      }))
      .filter((item) => item.key && (item.title || item.searchTitle));

    const results = await mapWithConcurrency(
      items,
      SCHEDULE_CONCURRENCY,
      async (item): Promise<[string, ScheduleItem] | null> => {
        try {
          const schedule = await getBangumiSchedule({
            title: item.title,
            searchTitle: item.searchTitle,
            year: item.year,
          });
          if (!schedule || !schedule.weekday) return null;
          return [item.key, schedule];
        } catch (error) {
          console.error(`查询放送安排失败 (${item.key}):`, error);
          return null;
        }
      }
    );

    const schedules: Record<string, ScheduleItem> = {};
    for (const entry of results) {
      if (entry) schedules[entry[0]] = entry[1];
    }

    const payload: SchedulesResponse = { schedules };
    return NextResponse.json(payload, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('查询放送安排失败', error);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}
