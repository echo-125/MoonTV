import {
  candidateTotalEpisodes,
  candidateWeekday,
  candidateWeekdays,
} from '@/lib/bangumi-schedule';
import {
  BangumiCandidate,
  compareEpisodeCounts,
  dateToWeekday,
  infoboxToWeekday,
  infoboxToWeekdays,
  latestUpdateTime,
  markDuplicates,
  matchBangumiTitle,
  moveInOrder,
  normalizeTitle,
  parseRemark,
  parseWeekdayText,
  resolveEpisodeCount,
  sortByManualOrder,
  splitFavoriteKey,
} from '@/lib/updates-logic';
import { parseSourceTime } from '@/lib/vod-metadata';

const candidate = (
  overrides: Partial<BangumiCandidate> & { id: number; name: string }
): BangumiCandidate => ({ ...overrides });

describe('splitFavoriteKey', () => {
  it('只在第一个加号处拆分，id 里允许出现加号', () => {
    expect(splitFavoriteKey('jisu+562')).toEqual({ source: 'jisu', id: '562' });
    expect(splitFavoriteKey('lzi+12+34')).toEqual({ source: 'lzi', id: '12+34' });
  });

  it('缺少源或 id 时返回 null', () => {
    expect(splitFavoriteKey('jisu')).toBeNull();
    expect(splitFavoriteKey('+562')).toBeNull();
    expect(splitFavoriteKey('jisu+')).toBeNull();
  });
});

describe('compareEpisodeCounts', () => {
  const now = 1_700_000_000_000;

  it('首次没有快照时不标记为更新，只登记基线', () => {
    expect(compareEpisodeCounts(0, 12, false, null)).toEqual({
      previousEpisodes: 12,
      hasUpdate: false,
      error: null,
      shouldSaveFavorite: true,
    });
  });

  it('集数增加时标记更新并要求回收藏', () => {
    const result = compareEpisodeCounts(12, 13, true, null);
    expect(result.hasUpdate).toBe(true);
    expect(result.shouldSaveFavorite).toBe(true);
    expect(result.previousEpisodes).toBe(12);
  });

  it('集数不变时不打扰用户，并保留上一轮的更新时间', () => {
    const result = compareEpisodeCounts(
      13,
      13,
      true,
      { hasUpdate: true, updatedAt: now - 1000 }
    );
    expect(result.hasUpdate).toBe(true);
    expect(result.shouldSaveFavorite).toBe(false);
  });

  it('集数减少视为源站异常，保留旧结论且不写回收藏', () => {
    const result = compareEpisodeCounts(20, 19, true, null);
    expect(result.hasUpdate).toBe(false);
    expect(result.shouldSaveFavorite).toBe(false);
    expect(result.error).toContain('异常减少');
  });

  it('源未返回有效集数时报告错误', () => {
    expect(compareEpisodeCounts(20, 0, true, null).error).toBeTruthy();
  });
});

describe('dateToWeekday', () => {
  it('把日期换算成 1=周一 … 7=周日', () => {
    expect(dateToWeekday('2026-11-09')).toBe(1);
    expect(dateToWeekday('2026-11-15')).toBe(7);
  });

  it('非法日期返回 null', () => {
    expect(dateToWeekday('')).toBeNull();
    expect(dateToWeekday('2026-13-01')).toBeNull();
    expect(dateToWeekday('2026-02-30')).toBeNull();
  });
});

describe('infoboxToWeekday', () => {
  it('支持中文「放送星期」', () => {
    expect(
      infoboxToWeekday([{ key: '放送星期', value: '星期五' }])
    ).toBe(5);
  });

  it('支持日文曜日', () => {
    expect(infoboxToWeekday([{ key: '放送星期', value: '月曜日' }])).toBe(1);
  });

  it('缺少字段时返回 null', () => {
    expect(infoboxToWeekday(undefined)).toBeNull();
    expect(infoboxToWeekday([{ key: '别名', value: '星期一' }])).toBeNull();
  });
});

describe('normalizeTitle', () => {
  it('忽略大小写、空白、标点与零宽字符', () => {
    expect(normalizeTitle('​一念永恒完结季​')).toBe('一念永恒完结季');
    expect(normalizeTitle('ABC  Tom & Jerry')).toBe('abctomjerry');
  });
});

describe('matchBangumiTitle', () => {
  it('精确命中时直接返回', () => {
    const match = matchBangumiTitle('仙逆', [
      candidate({ id: 345802, name: '仙逆', name_cn: '仙逆' }),
    ]);
    expect(match.matchStatus).toBe('matched');
    expect(match.candidate?.id).toBe(345802);
  });

  it('绝不把「仙逆剧场版」当成「仙逆」', () => {
    const match = matchBangumiTitle('仙逆', [
      candidate({ id: 577237, name: '仙逆剧场版 弑仙之战' }),
    ]);
    expect(match.candidate).toBeNull();
    expect(match.matchStatus).toBe('unmatched');
  });

  it('续作后缀可以被识别为同一部作品', () => {
    const match = matchBangumiTitle('诛仙第四季', [
      candidate({ id: 312298, name: '诛仙', date: '2022-11-28' }),
    ]);
    expect(match.candidate?.id).toBe(312298);
  });

  it('用收藏时的搜索词补齐被截断的标题', () => {
    const match = matchBangumiTitle(
      '牧神记',
      [candidate({ id: 456159, name: '牧神记', date: '2024-10-27' })],
      { alias: '牧神' }
    );
    expect(match.candidate?.id).toBe(456159);
  });

  it('多个续作时选中最近一次已开播的档期', () => {
    const match = matchBangumiTitle(
      '凡人修仙传',
      [
        candidate({ id: 348240, name: '凡人修仙传 年番', date: '2021-11-14' }),
        candidate({ id: 518425, name: '凡人修仙传 第四季', date: '2025-01-18' }),
        candidate({ id: 607915, name: '凡人修仙传 第五季', date: '2029-06-13' }),
      ],
      { now: Date.UTC(2026, 10, 15) }
    );
    expect(match.matchStatus).toBe('matched');
    expect(match.candidate?.id).toBe(518425);
  });

  it('同名条目可用年份消歧', () => {
    const match = matchBangumiTitle(
      '择天记',
      [
        candidate({ id: 526975, name: '择天记3D', name_cn: '择天记', date: '2026-01-31' }),
        candidate({ id: 140217, name: '择天记', date: '2015-07-15' }),
      ],
      { year: '2015' }
    );
    expect(match.candidate?.id).toBe(140217);
  });

  it('没有任何候选时返回 unmatched', () => {
    expect(matchBangumiTitle('不存在的番', []).matchStatus).toBe('unmatched');
  });
});

describe('parseRemark', () => {
  it('解析「更新至第N集」与不补零的写法', () => {
    expect(parseRemark('更新至第109集')).toEqual({ episodes: 109, finished: false });
    expect(parseRemark('第189集')).toEqual({ episodes: 189, finished: false });
    expect(parseRemark('更新至12集')).toEqual({ episodes: 12, finished: false });
  });

  it('补零写法也能解析（龙魂实测为「更新至第08集」）', () => {
    expect(parseRemark('更新至第08集').episodes).toBe(8);
  });

  it('识别已完结', () => {
    expect(parseRemark('已完结')).toEqual({ episodes: null, finished: true });
    expect(parseRemark('全集').finished).toBe(true);
    expect(parseRemark('全12集')).toEqual({ episodes: 12, finished: true });
  });

  it('空备注与无数字备注不返回集数', () => {
    expect(parseRemark('')).toEqual({ episodes: null, finished: false });
    expect(parseRemark('更新中')).toEqual({ episodes: null, finished: false });
    expect(parseRemark('第0集').episodes).toBeNull();
  });
});

describe('resolveEpisodeCount', () => {
  it('备注比 m3u8 多一集时取备注（remarks 领先于分集）', () => {
    expect(resolveEpisodeCount(108, 109)).toBe(109);
  });

  it('备注落后一集时取 m3u8（逆天至尊实测 565 vs 566）', () => {
    expect(resolveEpisodeCount(566, 565)).toBe(566);
  });

  it('备注缺失或非法时用分集数', () => {
    expect(resolveEpisodeCount(12, null)).toBe(12);
    expect(resolveEpisodeCount(12, 0)).toBe(12);
    expect(resolveEpisodeCount(0, 12)).toBe(12);
    expect(resolveEpisodeCount(0, null)).toBe(0);
  });
});

describe('latestUpdateTime', () => {
  it('取集数变化时间与源站入库时间的较大者', () => {
    expect(latestUpdateTime(1000, 2000)).toBe(2000);
    expect(latestUpdateTime(3000, 2000)).toBe(3000);
    expect(latestUpdateTime(0, 2000)).toBe(2000);
    expect(latestUpdateTime(0, 0)).toBe(0);
  });
});

describe('markDuplicates', () => {
  const item = (
    key: string,
    bangumiId: number | null,
    sourceUpdatedAt: number,
    totalEpisodes: number
  ) => ({ key, bangumiId, sourceUpdatedAt, totalEpisodes });

  it('同一 Bangumi 条目只保留源站时间最新的一条', () => {
    const marked = markDuplicates([
      item('dyttzy+10798', 339302, 1_700_000_000_000, 566),
      item('bfzy+24961', 339302, 1_700_000_100_000, 566),
    ]);
    expect(marked.map((entry) => entry.duplicateOf)).toEqual([
      'bfzy+24961',
      null,
    ]);
  });

  it('时间相同时保留集数更多的一条', () => {
    const marked = markDuplicates([
      item('a+1', 491578, 1000, 18),
      item('b+2', 491578, 1000, 20),
    ]);
    expect(marked[0].duplicateOf).toBe('b+2');
    expect(marked[1].duplicateOf).toBeNull();
  });

  it('没有 bangumiId 或条目唯一时不标记重复', () => {
    const marked = markDuplicates([
      item('a+1', null, 1, 2),
      item('b+2', 123, 1, 2),
    ]);
    expect(marked.every((entry) => entry.duplicateOf === null)).toBe(true);
  });
});

describe('sortByManualOrder', () => {
  const items = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];

  it('空顺序时保持原顺序', () => {
    expect(sortByManualOrder(items, [])).toEqual(items);
  });

  it('按顺序数组重排，未列出的保持原有相对次序排在后面', () => {
    expect(sortByManualOrder(items, ['c', 'a']).map((item) => item.key)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('顺序里包含已不存在的条目时忽略它', () => {
    expect(sortByManualOrder(items, ['gone', 'b']).map((item) => item.key)).toEqual([
      'b',
      'a',
      'c',
    ]);
  });
});

describe('moveInOrder', () => {
  const keys = ['a', 'b', 'c'];

  it('置顶把目标移到首位', () => {
    expect(moveInOrder([], keys, 'c', 'top')).toEqual(['c', 'a', 'b']);
  });

  it('置底把目标移到末位，并保留已有顺序', () => {
    expect(moveInOrder(['c', 'a', 'b'], keys, 'a', 'bottom')).toEqual([
      'c',
      'b',
      'a',
    ]);
  });

  it('混合状态时把未记录顺序的条目按当前展示顺序补齐', () => {
    expect(moveInOrder(['b'], keys, 'a', 'bottom')).toEqual(['b', 'c', 'a']);
  });
});

describe('parseWeekdayText', () => {
  it('解析单个「星期X」', () => {
    expect(parseWeekdayText('星期三')).toEqual([3]);
  });

  it('解析日文曜日', () => {
    expect(parseWeekdayText('月曜日')).toEqual([1]);
  });

  it('多档期番返回全部星期（升序去重）', () => {
    // 武神主宰、双生武魂在 Bangumi 上确实登记了两个放送日。
    expect(parseWeekdayText('星期日、星期二')).toEqual([2, 7]);
    expect(parseWeekdayText('星期三、星期四')).toEqual([3, 4]);
  });

  it('识别列表里省略前缀的裸星期字', () => {
    // 武碎星河的原文是「星期四、日」，旧实现解析不到这个「日」。
    expect(parseWeekdayText('星期四、日')).toEqual([4, 7]);
  });

  it('空文本返回空数组', () => {
    expect(parseWeekdayText('')).toEqual([]);
    expect(parseWeekdayText('   ')).toEqual([]);
  });
});

describe('infoboxToWeekdays', () => {
  it('保留全部放送星期', () => {
    expect(infoboxToWeekdays([{ key: '放送星期', value: '星期日、星期二' }])).toEqual([2, 7]);
  });

  it('缺少字段时返回空数组', () => {
    expect(infoboxToWeekdays(undefined)).toEqual([]);
  });
});

describe('candidateWeekdays', () => {
  it('多值「放送星期」全部保留', () => {
    expect(
      candidateWeekdays(
        candidate({
          id: 286354,
          name: '武神主宰',
          infobox: [{ key: '放送星期', value: '星期日、星期二' }],
        })
      )
    ).toEqual([2, 7]);
  });

  it('只有开播日期时退化为单值', () => {
    expect(candidateWeekdays(candidate({ id: 1, name: 'x', date: '2026-11-09' }))).toEqual([1]);
  });

  it('没有任何信息时返回空数组', () => {
    expect(candidateWeekdays(candidate({ id: 1, name: 'x' }))).toEqual([]);
  });
});

describe('parseSourceTime', () => {
  it('把采集站的北京时间换算成 UTC 毫秒', () => {
    // 源站写 2026-11-15 11:05:32 是北京时间，对应 UTC 03:05:32。
    expect(parseSourceTime('2026-11-15 11:05:32')).toBe(
      Date.UTC(2026, 10, 15, 3, 5, 32)
    );
  });

  it('只有日期时按当天 08:00 前的 UTC 换算', () => {
    expect(parseSourceTime('2026-05-06')).toBe(Date.UTC(2026, 4, 5, 16, 0, 0));
  });

  it('非法输入返回 0', () => {
    expect(parseSourceTime('')).toBe(0);
    expect(parseSourceTime('2026/11/15')).toBe(0);
    expect(parseSourceTime(null)).toBe(0);
  });
});

describe('candidateWeekday', () => {
  it('优先使用 calendar 的 air_weekday（最权威的当天档期）', () => {
    // calendar 条目没有 infobox，air_weekday 是唯一可靠来源；
    // 开播日期给出的星期在这里是干扰项，必须被压过。
    expect(
      candidateWeekday(
        candidate({
          id: 712000,
          name: '牧神记 伍',
          date: '2026-11-09',
          air_weekday: 7,
        })
      )
    ).toBe(7);
  });

  it('air_weekday 非法时忽略它', () => {
    expect(
      candidateWeekday(candidate({ id: 1, name: 'x', date: '2026-11-09', air_weekday: 0 }))
    ).toBe(1);
    expect(
      candidateWeekday(candidate({ id: 1, name: 'x', date: '2026-11-09', air_weekday: 9 }))
    ).toBe(1);
  });

  it('优先使用 infobox 的放送星期，而不是开播日期的星期', () => {
    // 遮天：2023-07-27 是周四，但实际放送是周三。
    expect(
      candidateWeekday(
        candidate({
          id: 345768,
          name: '遮天',
          date: '2023-07-27',
          infobox: [{ key: '放送星期', value: '星期三' }],
        })
      )
    ).toBe(3);
  });

  it('没有放送星期时退回开播日期的星期', () => {
    expect(candidateWeekday(candidate({ id: 1, name: 'x', date: '2026-11-09' }))).toBe(1);
  });

  it('两处信息都没有时返回 null', () => {
    expect(candidateWeekday(candidate({ id: 1, name: 'x' }))).toBeNull();
  });
});

describe('candidateTotalEpisodes', () => {
  it('优先取 total_episodes，其次 eps', () => {
    expect(candidateTotalEpisodes({ id: 1, name: 'x', total_episodes: 26, eps: 12 })).toBe(26);
    expect(candidateTotalEpisodes({ id: 1, name: 'x', eps: 12 })).toBe(12);
  });

  it('缺失或非法时返回 0', () => {
    expect(candidateTotalEpisodes({ id: 1, name: 'x' })).toBe(0);
    expect(candidateTotalEpisodes({ id: 1, name: 'x', eps: 0 })).toBe(0);
  });
});
