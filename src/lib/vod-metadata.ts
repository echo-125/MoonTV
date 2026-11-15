/* eslint-disable @typescript-eslint/no-explicit-any */

import { API_CONFIG, ApiSite } from '@/lib/config';

/**
 * 采集类视频源（苹果 CMS / macCMS）除了集数，还会返回 vod_remarks 与 vod_time。
 * 这两个字段是「更新时间」唯一的权威信号：vod_weekday / vod_isend / vod_total
 * 在实测里全是空值或与真实集数矛盾，只有 remarks 与 time 稳定可用。
 */
export interface VodMetadata {
  /** m3u8 分集数量，与详情页展示的集数一致。 */
  episodes: number;
  title: string;
  poster: string;
  year: string;
  /** 源站备注原文，如「更新至第109集」「已完结」。 */
  remark: string;
  /** 源站最后入库时间（毫秒，按 UTC 解释，避免容器时区影响）；0 表示无。 */
  updatedAt: number;
  /** 源站自报总集数，可能不准，仅用于「已完结」交叉验证。 */
  declaredTotal: number;
}

/** 与 downstream.ts 保持一致：只统计 m3u8 分集，多线路取最长的一路。 */
function countEpisodes(playUrl: string): number {
  if (!playUrl) return 0;
  let best = 0;
  for (const line of playUrl.split('$$$')) {
    let count = 0;
    for (const entry of line.split('#')) {
      const parts = entry.split('$');
      if (parts.length === 2 && parts[1].endsWith('.m3u8')) count += 1;
    }
    if (count > best) best = count;
  }
  return best;
}

/** 采集站的 vod_time 是北京时间，不带时区信息；按 UTC 解释会让前端显示晚 8 小时。 */
const SOURCE_TIME_OFFSET_MS = 8 * 60 * 60 * 1000;

/** supports "2026-11-15 11:05:32" and "2026-05-06", interpreted as UTC+8. */
export function parseSourceTime(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/.exec(
    value.trim()
  );
  if (!match) return 0;
  const wallClock = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4] ?? 0),
    Number(match[5] ?? 0),
    Number(match[6] ?? 0)
  );
  if (Number.isNaN(wallClock)) return 0;
  return wallClock - SOURCE_TIME_OFFSET_MS;
}

/**
 * 直接读采集接口明细，拿到 fetchVideoDetail 会丢弃的更新元数据。
 * 失败返回 null，让调用方回退到原有详情逻辑。
 */
export async function fetchVodMetadata(
  apiSite: ApiSite,
  id: string,
  timeoutMs = 12_000
): Promise<VodMetadata | null> {
  const url = `${apiSite.api}${API_CONFIG.detail.path}${id}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: API_CONFIG.detail.headers,
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data: any = await response.json();
    const list = data?.list;
    if (!Array.isArray(list) || list.length === 0) return null;
    const item = list[0] as any;
    const playUrl = String(item?.vod_play_url ?? '');
    if (!playUrl) return null;
    return {
      episodes: countEpisodes(playUrl),
      title: typeof item?.vod_name === 'string' ? item.vod_name.trim() : '',
      poster: typeof item?.vod_pic === 'string' ? item.vod_pic : '',
      year: typeof item?.vod_year === 'string'
        ? item.vod_year.match(/\d{4}/)?.[0] || ''
        : '',
      remark: typeof item?.vod_remarks === 'string' ? item.vod_remarks.trim() : '',
      updatedAt: parseSourceTime(item?.vod_time),
      declaredTotal: Number(item?.vod_total) || 0,
    };
  } catch {
    // 源站超时或不可达：交给调用方回退到详情接口，并保留上一次的结论。
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
