/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getBangumiSchedule } from '@/lib/bangumi-schedule';
import { getAvailableApiSites, getConfig } from '@/lib/config';
import { db } from '@/lib/db';
import { fetchVideoDetail } from '@/lib/fetchVideoDetail';
import { Favorite } from '@/lib/types';
import type {
  ScheduleItem,
  UpdateItem,
  UpdatesResponse,
  UpdatesSnapshot,
} from '@/lib/updates.types';
import {
  compareEpisodeCounts,
  latestUpdateTime,
  mapWithConcurrency,
  markDuplicates,
  parseRemark,
  resolveEpisodeCount,
  sortByManualOrder,
  splitFavoriteKey,
} from '@/lib/updates-logic';
import {
  readUpdatesOrder,
  readUpdatesSnapshot,
  UPDATES_CACHE_SECONDS,
  writeUpdatesSnapshot,
} from '@/lib/updates-store';
import { fetchVodMetadata } from '@/lib/vod-metadata';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DETAIL_CONCURRENCY = 4;

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

function baseItem(
  key: string,
  favorite: Favorite,
  watchedEpisode: number | null
): UpdateItem {
  const parts = splitFavoriteKey(key);
  return {
    key,
    source: parts?.source ?? '',
    id: parts?.id ?? '',
    title: favorite.title,
    year: favorite.year || '',
    cover: favorite.cover || '',
    sourceName: favorite.source_name || '',
    totalEpisodes: favorite.total_episodes || 0,
    previousEpisodes: favorite.total_episodes || 0,
    watchedEpisode,
    hasUpdate: false,
    updatedAt: 0,
    weekday: null,
    weekdays: [],
    bangumiId: null,
    bangumiTitle: null,
    matchStatus: 'unmatched',
    scheduleSource: null,
    sourceUpdatedAt: 0,
    remark: '',
    isFinished: false,
    duplicateOf: null,
    error: null,
  };
}

function applySchedule(
  item: UpdateItem,
  schedule: ScheduleItem
): UpdateItem {
  const weekdays =
    Array.isArray(schedule.weekdays) && schedule.weekdays.length > 0
      ? schedule.weekdays
      : schedule.weekday
        ? [schedule.weekday]
        : [];
  return {
    ...item,
    weekday: schedule.weekday || weekdays[0] || null,
    weekdays,
    bangumiId: schedule.bangumiId || null,
    bangumiTitle: schedule.bangumiTitle || null,
    matchStatus: schedule.matchStatus,
    scheduleSource: schedule.scheduleSource,
  };
}

/**
 * 补齐旧快照缺失的字段。
 *
 * 快照会在 Redis 里躺 6 小时，如果期间升级了代码（新增了 weekdays / isFinished
 * 之类字段），旧快照读出来就是缺字段的对象，前端 `item.isFinished` 直接读 undefined
 * 会让卡片显示错乱。这里统一按当前 schema 兜底，而不是假设快照一定是新版写进去的。
 */
function hydrateSnapshot(snapshot: UpdatesSnapshot): UpdatesSnapshot {
  return {
    ...snapshot,
    items: (snapshot.items ?? []).map((item) => ({
      ...item,
      weekdays:
        Array.isArray(item.weekdays) && item.weekdays.length > 0
          ? item.weekdays
          : item.weekday
            ? [item.weekday]
            : [],
      weekday: typeof item.weekday === 'number' ? item.weekday : null,
      sourceUpdatedAt: item.sourceUpdatedAt || 0,
      remark: item.remark || '',
      isFinished: Boolean(item.isFinished),
      duplicateOf: item.duplicateOf ?? null,
      scheduleSource: item.scheduleSource ?? null,
      bangumiId: item.bangumiId ?? null,
      bangumiTitle: item.bangumiTitle ?? null,
      matchStatus: item.matchStatus ?? 'unmatched',
      error: item.error ?? null,
    })),
  };
}

function buildResponse(
  snapshot: UpdatesSnapshot,
  fromCache: boolean,
  order: string[]
): UpdatesResponse {
  const hydrated = hydrateSnapshot(snapshot);
  const withDuplicates = markDuplicates(hydrated.items);
  return {
    items: sortByManualOrder(withDuplicates, order),
    refreshedAt: snapshot.refreshedAt,
    fromCache,
    totalFavorites: snapshot.totalFavorites,
    failed: hydrated.items.filter((item) => item.error).length,
    order,
  };
}

/**
 * GET /api/updates
 *
 * 返回当前用户收藏的更新状态。默认读取 6 小时内的快照；
 * `?refresh=1` 强制回源刷新（仍会合并旧快照，避免丢失集数基线）。
 *
 * 数据来源分两层：
 * 1. 采集接口明细（videos 的 ac=detail）给出集数、vod_remarks 与 vod_time；
 * 2. Bangumi 给出放送星期。前者决定「有没有更新」，后者决定「排在哪天」。
 */
export async function GET(request: NextRequest) {
  const username = await authorize(request);
  if (!username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const force =
    searchParams.get('refresh') === '1' || searchParams.get('refresh') === 'true';

  try {
    const [previous, order] = await Promise.all([
      readUpdatesSnapshot(username),
      readUpdatesOrder(username),
    ]);
    const isFresh =
      previous &&
      Date.now() - previous.refreshedAt < UPDATES_CACHE_SECONDS * 1000;

    if (previous && isFresh && !force) {
      return NextResponse.json(buildResponse(previous, true, order), {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    const [favorites, records, apiSites] = await Promise.all([
      db.getAllFavorites(username),
      db.getAllPlayRecords(username),
      getAvailableApiSites(username),
    ]);
    const apiSiteByKey = new Map(apiSites.map((site) => [site.key, site]));

    const previousByKey = new Map<string, UpdateItem>(
      (previous?.items ?? []).map((item) => [item.key, item])
    );

    const entries = Object.entries(favorites)
      .filter(([, favorite]) => favorite.origin !== 'live')
      .filter(([key, favorite]) => {
        const parts = splitFavoriteKey(key);
        return parts !== null && Boolean(favorite?.title);
      })
      .map(([key, favorite]) => ({
        key,
        favorite,
        watchedEpisode: records[key]?.index ?? null,
      }));

    const refreshed = await mapWithConcurrency(
      entries,
      DETAIL_CONCURRENCY,
      async ({ key, favorite, watchedEpisode }): Promise<UpdateItem> => {
        const parts = splitFavoriteKey(key);
        if (!parts) {
          return { ...baseItem(key, favorite, watchedEpisode), error: '收藏键格式异常' };
        }
        const previousItem = previousByKey.get(key) ?? null;
        const current = baseItem(key, favorite, watchedEpisode);
        const now = Date.now();

        let detailEpisodes: number | null = null;
        let remark = '';
        let sourceUpdatedAt = 0;
        let detailError: string | null = null;

        // 采集接口明细比 /api/detail 多带 vod_remarks 与 vod_time，优先用它；
        // 拿不到（源站不支持或超时）再退回原来的详情接口。
        const apiSite = apiSiteByKey.get(parts.source);
        if (apiSite) {
          const metadata = await fetchVodMetadata(apiSite, parts.id);
          if (metadata && metadata.episodes > 0) {
            detailEpisodes = metadata.episodes;
            remark = metadata.remark;
            sourceUpdatedAt = metadata.updatedAt;
            if (metadata.title) current.title = metadata.title || current.title;
            if (metadata.poster) current.cover = metadata.poster || current.cover;
            if (metadata.year) current.year = metadata.year || current.year;
          }
        }

        if (detailEpisodes === null) {
          try {
            const detail = await fetchVideoDetail({
              source: parts.source,
              id: parts.id,
              fallbackTitle: (favorite.search_title || favorite.title).trim(),
            });
            detailEpisodes = detail?.episodes?.length ?? 0;
            if (detail?.title) current.title = detail.title || current.title;
            if (detail?.poster) current.cover = detail.poster || current.cover;
            if (detail?.year) current.year = detail.year || current.year;
          } catch (error) {
            detailError = error instanceof Error ? error.message : '获取详情失败';
          }
        }

        if (detailEpisodes === null) {
          // 源站不可用：保留快照中的结论，不让一次网络抖动清空提醒。
          return {
            ...current,
            previousEpisodes: previousItem?.previousEpisodes ?? current.previousEpisodes,
            hasUpdate: previousItem?.hasUpdate ?? false,
            updatedAt: previousItem?.updatedAt ?? 0,
            weekday: previousItem?.weekday ?? null,
            weekdays: previousItem?.weekdays ?? [],
            bangumiId: previousItem?.bangumiId ?? null,
            bangumiTitle: previousItem?.bangumiTitle ?? null,
            matchStatus: previousItem?.matchStatus ?? 'unmatched',
            scheduleSource: previousItem?.scheduleSource ?? null,
            sourceUpdatedAt: previousItem?.sourceUpdatedAt ?? 0,
            remark: previousItem?.remark ?? '',
            isFinished: previousItem?.isFinished ?? false,
            error: detailError,
          };
        }

        const remarkSignals = parseRemark(remark);
        // 备注与 m3u8 分集数取较大者：备注偶尔落后一集，也可能比 m3u8 先更新。
        const resolvedEpisodes = resolveEpisodeCount(
          detailEpisodes,
          remarkSignals.episodes
        );

        const comparison = compareEpisodeCounts(
          previousItem?.totalEpisodes ?? favorite.total_episodes ?? 0,
          resolvedEpisodes,
          Boolean(previousItem),
          previousItem
        );

        if (comparison.shouldSaveFavorite) {
          try {
            const merged: Favorite = {
              ...favorite,
              title: current.title || favorite.title,
              cover: current.cover || favorite.cover,
              year: current.year || favorite.year,
              total_episodes: resolvedEpisodes,
              save_time: favorite.save_time,
            };
            await db.saveFavorite(username, parts.source, parts.id, merged);
          } catch (error) {
            console.error(`更新收藏集数失败 (${key}):`, error);
          }
        }

        const changeTime = comparison.hasUpdate
          ? previousItem?.hasUpdate
            ? previousItem.updatedAt || now
            : now
          : 0;

        // 「新」角标表示还有没看的新集数；已经追平就不必再提醒，
        // 否则用户看完了角标还挂着，反而看不出哪些真的要补。
        const watchedUpToDate =
          watchedEpisode !== null &&
          resolvedEpisodes > 0 &&
          watchedEpisode >= resolvedEpisodes;
        const hasUpdate = comparison.hasUpdate && !watchedUpToDate;

        // 提醒还没消掉时必须一直保留最初记录的集数基线。
        // 否则每刷新一次基线就跟着集数前移，「新增 N 集」会算成 0，角标却一直亮着。
        const previousEpisodes = !hasUpdate
          ? resolvedEpisodes
          : previousItem?.hasUpdate &&
              (previousItem.previousEpisodes ?? 0) > 0
            ? previousItem.previousEpisodes
            : comparison.previousEpisodes;

        return {
          ...current,
          totalEpisodes: resolvedEpisodes,
          previousEpisodes,
          hasUpdate,
          // 即使本地没检测到集数变化，源站的入库时间也是「最近更新」的有效依据。
          updatedAt: latestUpdateTime(changeTime, sourceUpdatedAt),
          weekday: previousItem?.weekday ?? null,
          weekdays: previousItem?.weekdays ?? [],
          bangumiId: previousItem?.bangumiId ?? null,
          bangumiTitle: previousItem?.bangumiTitle ?? null,
          matchStatus: previousItem?.matchStatus ?? 'unmatched',
          scheduleSource: previousItem?.scheduleSource ?? null,
          sourceUpdatedAt,
          remark,
          isFinished: remarkSignals.finished,
          error: comparison.error,
        };
      }
    );

    // 集数结果一旦拿到就先落盘，Bangumi 关联失败也不影响提醒。
    const withSchedules = await mapWithConcurrency(
      refreshed,
      DETAIL_CONCURRENCY,
      async (item) => {
        // calendar 命中的结论是权威的，不必重查；
        // 检索推断出来的星期可信度低，允许下次刷新纠正。
        if (item.weekday && item.scheduleSource === 'calendar') return item;
        const favorite = favorites[item.key];
        if (!favorite) return item;
        try {
          const schedule = await getBangumiSchedule({
            title: favorite.title,
            searchTitle: favorite.search_title,
            year: favorite.year,
          });
          if (!schedule) return item;
          // 检索没结果时不要用 unmatched 覆盖上一次的有效结论。
          if (!schedule.weekday && item.weekday) return item;
          return applySchedule(item, schedule);
        } catch (error) {
          console.error(`关联 Bangumi 放送安排失败 (${item.key}):`, error);
          return item;
        }
      }
    );

    const snapshot: UpdatesSnapshot = {
      refreshedAt: Date.now(),
      totalFavorites: withSchedules.length,
      items: withSchedules,
    };
    await writeUpdatesSnapshot(username, snapshot);

    return NextResponse.json(buildResponse(snapshot, false, order), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('获取收藏更新失败', error);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}
