import type { UpdateItem, UpdateMatchStatus } from './updates.types';

export interface FavoriteUpdateInput {
  total_episodes: number;
  title: string;
  year: string;
  cover: string;
  source_name: string;
  save_time: number;
  search_title: string;
  origin?: 'vod' | 'live';
}

export interface EpisodeComparison {
  previousEpisodes: number;
  hasUpdate: boolean;
  error: string | null;
  shouldSaveFavorite: boolean;
}

/** Favorite ids may contain '+'; only the first '+' separates source and id. */
export function splitFavoriteKey(
  key: string
): { source: string; id: string } | null {
  const separator = key.indexOf('+');
  if (separator <= 0 || separator === key.length - 1) return null;
  return {
    source: key.slice(0, separator),
    id: key.slice(separator + 1),
  };
}

export function compareEpisodeCounts(
  previousEpisodes: number,
  totalEpisodes: number,
  hasSnapshot: boolean,
  previousUpdate: Pick<UpdateItem, 'hasUpdate' | 'updatedAt'> | null
): EpisodeComparison {
  if (!Number.isInteger(totalEpisodes) || totalEpisodes <= 0) {
    return {
      previousEpisodes,
      hasUpdate: previousUpdate?.hasUpdate ?? false,
      error: '源未返回有效集数',
      shouldSaveFavorite: false,
    };
  }

  // A snapshot is the only trustworthy baseline. A favorite's total_episodes
  // may have been initialized by a client and must not create false updates.
  if (!hasSnapshot) {
    return {
      previousEpisodes: totalEpisodes,
      hasUpdate: false,
      error: null,
      shouldSaveFavorite: previousEpisodes !== totalEpisodes,
    };
  }

  if (totalEpisodes < previousEpisodes) {
    return {
      previousEpisodes,
      hasUpdate: previousUpdate?.hasUpdate ?? false,
      error: `源集数异常减少（${previousEpisodes} → ${totalEpisodes}）`,
      shouldSaveFavorite: false,
    };
  }

  if (totalEpisodes > previousEpisodes) {
    return {
      previousEpisodes,
      hasUpdate: true,
      error: null,
      shouldSaveFavorite: true,
    };
  }

  return {
    previousEpisodes,
    hasUpdate: previousUpdate?.hasUpdate ?? false,
    error: null,
    shouldSaveFavorite: false,
  };
}

export function normalizeTitle(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    // \p{Cf} 覆盖零宽字符（如收藏标题里的 U+200B），\p{P}/\p{S} 覆盖标点与符号。
    .replace(/[\s\p{P}\p{S}\p{Cf}]+/gu, '');
}

export interface RemarkSignals {
  /** 备注里声明的集数；解析不出为 null。 */
  episodes: number | null;
  /** 备注声明已完结。 */
  finished: boolean;
}

/**
 * 解析采集站的 vod_remarks。
 * 实测形态：「更新至第109集」「第189集」「更新至12集」「更新至第08集」「已完结」。
 * vod_isend / vod_total 在实测里全为 0 或与真实集数矛盾，只有 remarks 可信。
 */
export function parseRemark(remark: string): RemarkSignals {
  const text = (remark || '').trim();
  if (!text) return { episodes: null, finished: false };

  const finished = /完结|全集|全\s*\d+\s*集|已完/.test(text);
  const match = /第?\s*(\d{1,4})\s*集/.exec(text);
  const episodes = match ? Number(match[1]) : null;
  if (episodes !== null && (!Number.isInteger(episodes) || episodes <= 0)) {
    return { episodes: null, finished };
  }
  return { episodes, finished };
}

/**
 * 集数取信：源站备注里的集数与 m3u8 分集数取较大者。
 * 备注偶尔落后一集（如「更新至第565集」而实际 566），也可能比 m3u8 更早知道新集，
 * 两者取大不会漏报，也不会因为一条偏差把集数改小。
 */
export function resolveEpisodeCount(
  detailEpisodes: number,
  remarkEpisodes: number | null
): number {
  const detail = Number.isInteger(detailEpisodes) && detailEpisodes > 0 ? detailEpisodes : 0;
  const remark = remarkEpisodes !== null && remarkEpisodes > 0 ? remarkEpisodes : 0;
  return Math.max(detail, remark);
}

/** 最新一次「有据可查」的时间：集数变化时间与源站入库时间取大。 */
export function latestUpdateTime(
  changeTime: number,
  sourceUpdatedAt: number
): number {
  return Math.max(changeTime || 0, sourceUpdatedAt || 0);
}

/**
 * 合并同一部番在不同视频源的收藏：同一 Bangumi 条目只保留信息最新的一条，
 * 其余标记 duplicateOf，避免周历里同一部番出现两次。
 */
export function markDuplicates<T extends {
  key: string;
  bangumiId: number | null;
  totalEpisodes: number;
  sourceUpdatedAt: number;
}>(items: T[]): (T & { duplicateOf: string | null })[] {
  const best = new Map<number, T>();
  for (const item of items) {
    if (!item.bangumiId) continue;
    const current = best.get(item.bangumiId);
    if (
      !current ||
      item.sourceUpdatedAt > current.sourceUpdatedAt ||
      (item.sourceUpdatedAt === current.sourceUpdatedAt &&
        item.totalEpisodes > current.totalEpisodes)
    ) {
      best.set(item.bangumiId, item);
    }
  }
  return items.map((item) => {
    if (!item.bangumiId) return { ...item, duplicateOf: null };
    const keeper = best.get(item.bangumiId);
    return {
      ...item,
      duplicateOf: keeper && keeper.key !== item.key ? keeper.key : null,
    };
  });
}

/** 按用户手动顺序排序；未记录顺序的条目维持原有相对次序排在后面。 */
export function sortByManualOrder<T extends { key: string }>(
  items: T[],
  order: string[]
): T[] {
  if (order.length === 0) return items;
  const rank = new Map<string, number>();
  order.forEach((key, index) => {
    if (!rank.has(key)) rank.set(key, index);
  });
  return items
    .map((item, index) => ({ item, index, rank: rank.get(item.key) }))
    .sort((a, b) => {
      const rankA = a.rank ?? Number.MAX_SAFE_INTEGER;
      const rankB = b.rank ?? Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}

/** 把某个 key 移到顺序数组的首位或末位，返回新的完整顺序。 */
export function moveInOrder(
  order: string[],
  keys: string[],
  key: string,
  position: 'top' | 'bottom'
): string[] {
  const rest = keys.filter((item) => item !== key);
  const next = order.filter((item) => item !== key && keys.includes(item));
  // 未记录顺序的条目按当前展示顺序补齐，保证「置顶/置底」在混合状态下也可预期。
  const missing = rest.filter((item) => !next.includes(item));
  const base = [...next, ...missing];
  return position === 'top' ? [key, ...base] : [...base, key];
}

export interface BangumiCandidate {
  id: number;
  name: string;
  name_cn?: string;
  date?: string;
  air_date?: string;
  /**
   * /calendar 接口给出的放送星期（1=周一 … 7=周日）。
   * 检索接口的这个字段是 null，calendar 条目又没有 infobox，
   * 所以对当天在播的条目来说它是唯一的权威星期来源。
   */
  air_weekday?: number | null;
  eps?: number;
  total_episodes?: number;
  infobox?: { key: string; value: unknown }[];
}

export interface TitleMatch {
  candidate: BangumiCandidate | null;
  matchStatus: UpdateMatchStatus;
}

function isExactTitle(candidate: BangumiCandidate, normalized: string): boolean {
  return [candidate.name, candidate.name_cn ?? ''].some(
    (title) => normalizeTitle(title) === normalized
  );
}

/**
 * 只在多出来的部分确实是「续作标记」时才允许前缀匹配。
 * 「仙逆」与「仙逆剧场版」不同档期，剧场版一律不算续作。
 * 双向比较：源站标题可能是「诛仙第四季」而 Bangumi 是「诛仙」，反之亦然。
 */
const SEQUEL_SUFFIX =
  /^(第[0-9一二三四五六七八九十百]+[季部篇章]|[0-9]+|年番[0-9]*|新番|完结[季篇]|最终[季章]|[iv]+)$/;

/** 返回 true 表示两个标题除了续作标记外完全一致。 */
export function isSequelTitle(
  left: string,
  right: string
): boolean {
  const a = normalizeTitle(left);
  const b = normalizeTitle(right);
  if (!a || !b || a === b) return false;
  const [longer, shorter] = a.length > b.length ? [a, b] : [b, a];
  if (!longer.startsWith(shorter)) return false;
  const suffix = longer.slice(shorter.length);
  return SEQUEL_SUFFIX.test(suffix);
}

function candidateYear(candidate: BangumiCandidate): string {
  const date = candidate.date || candidate.air_date || '';
  return /^(\d{4})/.exec(date)?.[1] ?? '';
}

/** UTC 毫秒时间戳；日期缺失时返回 null，避免参与「最近开播」排序。 */
function candidateTime(candidate: BangumiCandidate): number | null {
  const date = candidate.date || candidate.air_date || '';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const time = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3])
  );
  return Number.isNaN(time) ? null : time;
}

export interface TitleMatchOptions {
  /** 用户收藏时实际使用的搜索词，通常比源站标题更接近 Bangumi 条目名。 */
  alias?: string;
  /** 收藏年份，用于在多个续作之间消歧。 */
  year?: string;
  /** 覆盖「当前时间」，便于测试。 */
  now?: number;
}

export function matchBangumiTitle(
  title: string,
  candidates: BangumiCandidate[],
  options: TitleMatchOptions = {}
): TitleMatch {
  const normalized = normalizeTitle(title);
  const alias = normalizeTitle(options.alias ?? '');
  if (!normalized && !alias) {
    return { candidate: null, matchStatus: 'unmatched' };
  }

  const exact = candidates.filter(
    (candidate) =>
      (normalized && isExactTitle(candidate, normalized)) ||
      (alias && isExactTitle(candidate, alias))
  );
  const resolve = (
    pool: BangumiCandidate[]
  ): BangumiCandidate | null => {
    if (pool.length === 1) return pool[0];
    if (pool.length === 0) return null;
    if (options.year) {
      const sameYear = pool.filter(
        (candidate) => candidateYear(candidate) === options.year
      );
      if (sameYear.length === 1) return sameYear[0];
    }
    // 同名多版本（如「择天记」与「择天记3D」）：取最近一次开播且已开播的那部，
    // 追番时间表关心的是当下在播的档期。
    const now = options.now ?? Date.now();
    const aired = pool
      .map((candidate) => ({ candidate, time: candidateTime(candidate) }))
      .filter((entry) => entry.time !== null && entry.time <= now)
      .sort((a, b) => (b.time as number) - (a.time as number));
    return aired.length > 0 ? aired[0].candidate : pool[0];
  };

  const exactPool = Array.from(
    new Map(exact.map((candidate) => [candidate.id, candidate])).values()
  );
  if (exactPool.length === 1) {
    return { candidate: exactPool[0], matchStatus: 'matched' };
  }
  if (exactPool.length > 1) {
    // 同名多条目确实无法消歧时才报 ambiguous，交由界面提示人工确认。
    if (options.year || exactPool.some((item) => candidateTime(item) !== null)) {
      return { candidate: resolve(exactPool), matchStatus: 'matched' };
    }
    return { candidate: null, matchStatus: 'ambiguous' };
  }

  // 前缀只接受续作后缀（第四季 / 年番2 / 3），绝不接受「包含」或「剧场版」。
  const prefixed = [
    ...(normalized
      ? candidates.filter((candidate) =>
        [candidate.name, candidate.name_cn ?? ''].some((value) =>
          isSequelTitle(value, title)
        )
      )
      : []),
    ...(alias
      ? candidates.filter((candidate) =>
        [candidate.name, candidate.name_cn ?? ''].some((value) =>
          isSequelTitle(value, options.alias ?? '')
        )
      )
      : []),
  ];
  const uniquePrefixed = Array.from(
    new Map(prefixed.map((candidate) => [candidate.id, candidate])).values()
  );
  if (uniquePrefixed.length === 1) {
    return { candidate: uniquePrefixed[0], matchStatus: 'matched' };
  }
  if (uniquePrefixed.length > 1 && options.year) {
    const sameYear = uniquePrefixed.filter(
      (candidate) => candidateYear(candidate) === options.year
    );
    if (sameYear.length === 1) {
      return { candidate: sameYear[0], matchStatus: 'matched' };
    }
  }
  if (uniquePrefixed.length > 1) {
    // 多个续作时取「最近一次开播且已开播」的那部：
    // 追番时间表关心的是当下在播的档期，例如凡人修仙传年番而非第一季。
    const now = options.now ?? Date.now();
    const aired = uniquePrefixed
      .map((candidate) => ({ candidate, time: candidateTime(candidate) }))
      .filter((entry) => entry.time !== null && entry.time <= now)
      .sort((a, b) => (b.time as number) - (a.time as number));
    if (aired.length > 0) {
      return { candidate: aired[0].candidate, matchStatus: 'matched' };
    }
  }
  return {
    candidate: null,
    matchStatus: uniquePrefixed.length > 0 ? 'ambiguous' : 'unmatched',
  };
}

export function dateToWeekday(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  const sundayBasedDay = parsed.getUTCDay();
  return sundayBasedDay === 0 ? 7 : sundayBasedDay;
}

function infoboxText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object' && 'v' in entry) {
          return String((entry as { v: unknown }).v);
        }
        return '';
      })
      .join(' ');
  }
  return '';
}

const WEEKDAY_CHAR: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
};

const JAPANESE_WEEKDAY: Array<[RegExp, number]> = [
  [/月曜日|月曜/, 1],
  [/火曜日|火曜/, 2],
  [/水曜日|水曜/, 3],
  [/木曜日|木曜/, 4],
  [/金曜日|金曜/, 5],
  [/土曜日|土曜/, 6],
  [/日曜日|日曜/, 7],
];

/**
 * 解析「放送星期」的原始文本，返回全部星期（升序去重）。
 *
 * 实测 Bangumi 的写法远不止「星期三」一种：
 * - 多值：「星期日、星期二」（武神主宰）、「星期三、星期四」（双生武魂）
 * - 省略「星期」：「星期四、日」（武碎星河）
 * - 日文：「月曜日」
 * 旧实现只取第一个「星期X」，多值番会随机落到某一天、后缀裸「日」直接解析失败。
 */
export function parseWeekdayText(text: string): number[] {
  const raw = (text || '').trim();
  if (!raw) return [];

  const found = new Set<number>();

  // 「星期X」「周X」「禮拜X」：X 后面不能再跟汉字，避免把「星期四、日」的「日」误判为第 7 天以外的东西。
  // 项目 target 是 es5，不能用 matchAll（TS2802），这里手动 exec 循环。
  const weekdayPattern = /(?:星期|周|礼拜)([一二三四五六日天])/g;
  let weekdayMatch: RegExpExecArray | null = weekdayPattern.exec(raw);
  while (weekdayMatch !== null) {
    const day = WEEKDAY_CHAR[weekdayMatch[1]];
    if (day) found.add(day);
    weekdayMatch = weekdayPattern.exec(raw);
  }

  // 日文星期（一个条目可能是「月曜日、木曜日」）。
  for (const [pattern, day] of JAPANESE_WEEKDAY) {
    if (pattern.test(raw)) found.add(day);
  }

  // 列表里省略前缀的裸星期字，如「星期四、日」的「日」，以及「一,三」这种简写。
  if (found.size === 0 || /[、,，/／]/.test(raw)) {
    const parts = raw.split(/[、,，/／]/);
    for (const part of parts) {
      const token = part.trim();
      if (WEEKDAY_CHAR[token]) found.add(WEEKDAY_CHAR[token]);
    }
  }

  return Array.from(found).sort((left, right) => left - right);
}

export function infoboxToWeekdays(
  infobox: BangumiCandidate['infobox']
): number[] {
  const broadcast = infobox?.find((entry) => entry.key === '放送星期');
  if (!broadcast) return [];
  return parseWeekdayText(infoboxText(broadcast.value));
}

/** 主星期：取原文里最先出现的那个，保证与历史结论一致（多值时不会来回跳）。 */
export function infoboxToWeekday(
  infobox: BangumiCandidate['infobox']
): number | null {
  const broadcast = infobox?.find((entry) => entry.key === '放送星期');
  if (!broadcast) return null;
  const text = infoboxText(broadcast.value);
  if (!text) return null;

  const candidate = /(?:星期|周|礼拜)([一二三四五六日天])/.exec(text);
  if (candidate) return WEEKDAY_CHAR[candidate[1]] ?? null;

  for (const [pattern, day] of JAPANESE_WEEKDAY) {
    if (pattern.test(text)) return day;
  }

  const tokens = text.split(/[、,，/／]/);
  for (const token of tokens) {
    const day = WEEKDAY_CHAR[token.trim()];
    if (day) return day;
  }
  return null;
}

export async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => worker())
  );
  return results;
}
