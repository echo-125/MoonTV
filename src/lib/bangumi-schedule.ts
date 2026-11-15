import type { ScheduleItem } from './updates.types';
import {
  BangumiCandidate,
  dateToWeekday,
  infoboxToWeekday,
  infoboxToWeekdays,
  matchBangumiTitle,
  normalizeTitle,
} from './updates-logic';

/**
 * Bangumi 官方域名在部分网络下会解析失败（DNS ECONNREFUSED / 连接超时），
 * 因此按顺序回退到可用镜像。首个成功的主机记下来，后续请求直接命中，
 * 避免每次刷新都先白等一个超时。
 */
const BANGUMI_HOSTS = ['https://api.bgm.tv', 'https://bgmapi.anibt.net'];
let preferredHostIndex = 0;
const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SEARCH_CONCURRENCY = 4;

interface CalendarGroup {
  items?: BangumiCandidate[];
}

interface CachedValue<T> {
  expiresAt: number;
  promise: Promise<T>;
}

let calendarCache: CachedValue<BangumiCandidate[]> | null = null;
const searchCache = new Map<string, CachedValue<BangumiCandidate[]>>();
let activeSearches = 0;
const searchQueue: Array<() => void> = [];

function candidateDate(candidate: BangumiCandidate): string {
  return candidate.date || candidate.air_date || '';
}

/**
 * 放送星期判定顺序很重要：
 * 1. /calendar 的 `air_weekday` 是 Bangumi 追番表直接给出的当天档期，最权威
 *    （calendar 条目普遍没有 infobox，不看这个字段等于把权威数据丢掉）；
 * 2. infobox 的「放送星期」是编辑者维护的当前档期，年番/改档时也准确；
 * 3. 都没有时才退回用开播日期的星期（日番通常开播日即放送日）。
 * 旧实现只有 3 和 2，导致长篇动画的星期被开播日期钉死。
 */
export function candidateWeekday(candidate: BangumiCandidate): number | null {
  const airWeekday = Number(candidate.air_weekday);
  if (Number.isInteger(airWeekday) && airWeekday >= 1 && airWeekday <= 7) {
    return airWeekday;
  }
  return (
    infoboxToWeekday(candidate.infobox) ??
    dateToWeekday(candidateDate(candidate))
  );
}

/** 「放送星期」的全部取值；多档期番（如「星期日、星期二」）会有多个。 */
export function candidateWeekdays(candidate: BangumiCandidate): number[] {
  const airWeekday = Number(candidate.air_weekday);
  if (Number.isInteger(airWeekday) && airWeekday >= 1 && airWeekday <= 7) {
    return [airWeekday];
  }
  const fromInfobox = infoboxToWeekdays(candidate.infobox);
  if (fromInfobox.length > 0) return fromInfobox;
  const fromDate = dateToWeekday(candidateDate(candidate));
  return fromDate === null ? [] : [fromDate];
}

/** Bangumi 条目声明的总集数（eps 或 total_episodes），缺失为 0。 */
export function candidateTotalEpisodes(candidate: BangumiCandidate): number {
  const record = candidate as BangumiCandidate & {
    eps?: number;
    total_episodes?: number;
  };
  const total = Number(record.total_episodes) || Number(record.eps) || 0;
  return Number.isInteger(total) && total > 0 ? total : 0;
}

function usableCandidate(candidate: BangumiCandidate): boolean {
  return (
    Number.isInteger(candidate.id) &&
    candidate.id > 0 &&
    typeof candidate.name === 'string' &&
    candidateWeekday(candidate) !== null
  );
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'MoonTV/updates-calendar',
        ...init?.headers,
      },
    });
    if (!response.ok) {
      throw new Error(`Bangumi HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 依次尝试各镜像主机，第一个成功的成为之后的默认主机。
 * 全部失败时抛最后一个错误，交由调用方保留历史结论。
 */
async function requestBangumi(path: string, init?: RequestInit): Promise<unknown> {
  let lastError: unknown = null;
  for (let offset = 0; offset < BANGUMI_HOSTS.length; offset += 1) {
    const index = (preferredHostIndex + offset) % BANGUMI_HOSTS.length;
    try {
      const data = await fetchJson(`${BANGUMI_HOSTS[index]}${path}`, init);
      preferredHostIndex = index;
      return data;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Bangumi 不可达');
}

async function loadCalendar(): Promise<BangumiCandidate[]> {
  const now = Date.now();
  if (calendarCache && calendarCache.expiresAt > now) {
    return calendarCache.promise;
  }
  const promise = requestBangumi('/calendar').then((data) => {
    if (!Array.isArray(data)) throw new Error('Bangumi calendar 格式无效');
    return (data as CalendarGroup[]).flatMap((group) =>
      Array.isArray(group.items) ? group.items.filter(usableCandidate) : []
    );
  });
  calendarCache = { expiresAt: now + CACHE_TTL_MS, promise };
  try {
    return await promise;
  } catch (error) {
    if (calendarCache?.promise === promise) calendarCache = null;
    throw error;
  }
}

async function runLimitedSearch<T>(task: () => Promise<T>): Promise<T> {
  if (activeSearches >= SEARCH_CONCURRENCY) {
    await new Promise<void>((resolve) => searchQueue.push(resolve));
  }
  activeSearches++;
  try {
    return await task();
  } finally {
    activeSearches--;
    searchQueue.shift()?.();
  }
}

async function loadSearch(title: string): Promise<BangumiCandidate[]> {
  const cacheKey = normalizeTitle(title);
  const cached = searchCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.promise;
  if (cached) searchCache.delete(cacheKey);

  const promise = runLimitedSearch(async () => {
    const data = await requestBangumi('/v0/search/subjects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keyword: title,
        sort: 'rank',
        filter: { type: [2] },
      }),
    });
    if (!data || typeof data !== 'object' || !('data' in data)) {
      throw new Error('Bangumi search 格式无效');
    }
    const list = (data as { data: unknown }).data;
    if (!Array.isArray(list)) throw new Error('Bangumi search 格式无效');
    return (list as BangumiCandidate[]).filter(
      (candidate) =>
        usableCandidate(candidate) &&
        (!('type' in candidate) || (candidate as { type?: number }).type === 2)
    );
  });
  searchCache.set(cacheKey, { expiresAt: now + CACHE_TTL_MS, promise });
  try {
    return await promise;
  } catch (error) {
    if (searchCache.get(cacheKey)?.promise === promise) {
      searchCache.delete(cacheKey);
    }
    throw error;
  }
}

function toSchedule(
  matchStatus: ScheduleItem['matchStatus'],
  candidate: BangumiCandidate | null,
  scheduleSource: Exclude<ScheduleItem['scheduleSource'], null>
): ScheduleItem {
  const weekdays = candidate ? candidateWeekdays(candidate) : [];
  return {
    weekday: weekdays[0] ?? 0,
    weekdays,
    bangumiId: candidate?.id ?? 0,
    bangumiTitle: candidate ? candidate.name_cn || candidate.name : '',
    matchStatus,
    scheduleSource,
    bangumiEpisodes: candidate ? candidateTotalEpisodes(candidate) : 0,
  };
}

/** 去重后的候选查询词：源站标题和用户收藏时的搜索词都值得一试。 */
function queryKeywords(title: string, searchTitle?: string): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const raw of [title, searchTitle ?? '']) {
    const value = (raw ?? '').trim();
    const normalized = normalizeTitle(value);
    if (!value || !normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    list.push(value);
  }
  return list;
}

/** Returns null when Bangumi could not be reached, so callers can retain history. */
export async function getBangumiSchedule(input: {
  title: string;
  searchTitle?: string;
  year?: string;
}): Promise<ScheduleItem | null> {
  const keywords = queryKeywords(input.title, input.searchTitle);
  if (keywords.length === 0) return toSchedule('unmatched', null, 'search');

  let calendarError: unknown = null;
  try {
    const calendar = await loadCalendar();
    // The calendar deliberately uses exact title matching only. In particular,
    // "仙逆" must never acquire the weekday of "仙逆剧场版".
    const exact = calendar.filter((candidate) =>
      keywords.some((keyword) => {
        const normalized = normalizeTitle(keyword);
        return [candidate.name, candidate.name_cn || ''].some(
          (candidateTitle) => normalizeTitle(candidateTitle) === normalized
        );
      })
    );
    if (exact.length === 1) {
      return toSchedule('matched', exact[0], 'calendar');
    }
  } catch (error) {
    calendarError = error;
  }

  try {
    // 同时用正名和别名检索：别名常被用户截断（如「牧神」），单用别名会漏匹配。
    const results = await Promise.allSettled(keywords.map(loadSearch));
    const merged = new Map<number, BangumiCandidate>();
    let succeeded = false;
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      succeeded = true;
      for (const candidate of result.value) merged.set(candidate.id, candidate);
    }
    if (!succeeded) return null;

    const match = matchBangumiTitle(input.title, Array.from(merged.values()), {
      alias: input.searchTitle,
      year: input.year,
    });
    // 检索出来的星期只是推断（可能是开播日的星期），标记来源让前端区分。
    return toSchedule(match.matchStatus, match.candidate, 'search');
  } catch {
    if (calendarError) return null;
    return null;
  }
}
