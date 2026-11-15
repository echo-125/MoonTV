'use client';

import {
  ArrowDownToLine,
  ArrowUpToLine,
  CalendarDays,
  CheckCircle2,
  Clock3,
  RefreshCw,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  Favorite,
  getAllFavorites,
  getAllPlayRecords,
} from '@/lib/db.client';
import {
  UpdateItem,
  UpdatesResponse,
} from '@/lib/updates.types';
import { moveInOrder, sortByManualOrder } from '@/lib/updates-logic';

import PageLayout from '@/components/PageLayout';

const WEEKDAYS = [
  { value: 1, label: '周一', short: '一' },
  { value: 2, label: '周二', short: '二' },
  { value: 3, label: '周三', short: '三' },
  { value: 4, label: '周四', short: '四' },
  { value: 5, label: '周五', short: '五' },
  { value: 6, label: '周六', short: '六' },
  { value: 7, label: '周日', short: '日' },
];

const LOCAL_SCHEDULES_KEY = 'moontv_updates_schedules';
const LOCAL_ORDER_KEY = 'moontv_updates_order';

/** 「最近更新」只看 7 天内有动静的收藏，避免把整份收藏都列出来。 */
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type Schedule = Pick<
  UpdateItem,
  | 'weekday'
  | 'weekdays'
  | 'bangumiId'
  | 'bangumiTitle'
  | 'matchStatus'
  | 'scheduleSource'
>;

type ViewMode = 'week' | 'recent';

type MovePosition = 'top' | 'bottom';

function todayWeekday() {
  return ((new Date().getDay() + 6) % 7) + 1;
}

/**
 * 同一部番在多个视频源被收藏时，只保留主条目参与排播。
 * 「逆天至尊」在 bfzy 和 dyttzy 各有一条，若都进周历，同一天会出现两张一样的海报，
 * 「本周放送 N 部」也会虚高。副条目仍留在快照里，可在搜索结果或收藏页换源播放。
 */
function isPrimary(item: UpdateItem): boolean {
  return !item.duplicateOf;
}

/**
 * 条目的全部放送星期。
 * 多档期番（Bangumi 写「星期日、星期二」）会同时出现在两天，
 * 老快照没有 weekdays 字段时退回单个 weekday。
 */
function itemWeekdays(item: UpdateItem): number[] {
  if (Array.isArray(item.weekdays) && item.weekdays.length > 0) {
    return item.weekdays;
  }
  return typeof item.weekday === 'number' && item.weekday > 0
    ? [item.weekday]
    : [];
}

function dateForWeekday(weekday: number) {
  const date = new Date();
  date.setDate(date.getDate() + weekday - todayWeekday());
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function formatTime(timestamp: number) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const hasClock = date.getHours() !== 0 || date.getMinutes() !== 0;
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    ...(hasClock
      ? { hour: '2-digit' as const, minute: '2-digit' as const, hour12: false }
      : {}),
  }).format(date);
}

function readLocalOrder(): string[] {
  try {
    const raw = localStorage.getItem(LOCAL_ORDER_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((key) => typeof key === 'string') : [];
  } catch {
    return [];
  }
}

function writeLocalOrder(order: string[]) {
  try {
    if (order.length === 0) localStorage.removeItem(LOCAL_ORDER_KEY);
    else localStorage.setItem(LOCAL_ORDER_KEY, JSON.stringify(order));
  } catch {
    // 隐私模式下 localStorage 不可写，排序只在本次会话生效。
  }
}

function OrderButtons({
  item,
  onMove,
}: {
  item: UpdateItem;
  onMove: (key: string, position: MovePosition) => void;
}) {
  return (
    <div className='absolute right-1.5 top-1.5 z-10 flex flex-col gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover/card:opacity-100 sm:group-focus-within/card:opacity-100'>
      <button
        type='button'
        data-testid={`card-top-${item.key}`}
        title='置顶'
        aria-label={`把 ${item.title} 置顶`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onMove(item.key, 'top');
        }}
        className='rounded-md bg-black/55 p-1 text-white shadow-sm backdrop-blur transition hover:bg-green-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-green-400'
      >
        <ArrowUpToLine className='h-3.5 w-3.5' />
      </button>
      <button
        type='button'
        data-testid={`card-bottom-${item.key}`}
        title='置底'
        aria-label={`把 ${item.title} 置底`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onMove(item.key, 'bottom');
        }}
        className='rounded-md bg-black/55 p-1 text-white shadow-sm backdrop-blur transition hover:bg-green-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-green-400'
      >
        <ArrowDownToLine className='h-3.5 w-3.5' />
      </button>
    </div>
  );
}

function UpdateCard({
  item,
  onMove,
  variant = 'week',
}: {
  item: UpdateItem;
  onMove: (key: string, position: MovePosition) => void;
  variant?: ViewMode;
}) {
  const watched = item.watchedEpisode ?? 0;
  const remaining = Math.max(0, item.totalEpisodes - watched);
  const added = Math.max(0, item.totalEpisodes - item.previousEpisodes);

  return (
    <div className='group/card relative min-w-0'>
      <Link
        href={`/play?source=${encodeURIComponent(item.source)}&id=${encodeURIComponent(item.id)}&title=${encodeURIComponent(item.title)}&year=${encodeURIComponent(item.year || '')}`}
        className='block min-w-0 focus:outline-none'
      >
        <div className='relative aspect-[3/4] w-full overflow-hidden rounded-lg bg-gray-100 shadow-sm transition-shadow group-hover/card:shadow-md group-focus-visible/card:ring-2 group-focus-visible/card:ring-green-500 dark:bg-gray-800'>
          {item.cover ? (
            // 第三方视频源没有固定图片域名，沿用项目的普通图片加载方式。
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.cover}
              alt={item.title}
              loading='lazy'
              className='h-full w-full object-cover transition-transform duration-300 group-hover/card:scale-105'
            />
          ) : (
            <div className='flex h-full items-center justify-center text-xs text-gray-400'>
              暂无海报
            </div>
          )}
          <span className='absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-2 pb-1.5 pt-4 text-[11px] font-medium text-white'>
            {item.isFinished
              ? `已完结 · ${item.totalEpisodes} 集`
              : item.totalEpisodes > 0
                ? `更新至 ${item.totalEpisodes} 集`
                : '暂无剧集'}
          </span>
          {item.hasUpdate && (
            <span className='absolute left-1.5 top-1.5 rounded bg-green-500 px-1.5 py-0.5 text-[10px] font-medium text-white shadow-sm'>
              新
            </span>
          )}
          {item.duplicateOf && (
            <span
              className='absolute bottom-6 left-1.5 rounded bg-amber-500/90 px-1.5 py-0.5 text-[10px] font-medium text-white'
              title='同一部番在别的视频源也有收藏，更新以另一条为准'
            >
              同步源
            </span>
          )}
        </div>
        <h3 className='mt-2 line-clamp-2 text-[13px] font-medium leading-[18px] text-gray-800 transition-colors group-hover/card:text-green-600 dark:text-gray-100 dark:group-hover/card:text-green-400'>
          {item.title}
        </h3>
        {item.hasUpdate ? (
          <p className='mt-1 truncate text-[11px] font-medium text-green-600 dark:text-green-400'>
            {formatTime(item.updatedAt)} 新增 {added} 集
          </p>
        ) : variant === 'recent' && item.sourceUpdatedAt > 0 ? (
          <p className='mt-1 truncate text-[11px] text-gray-500 dark:text-gray-400'>
            源站 {formatTime(item.sourceUpdatedAt)} 更新
          </p>
        ) : remaining > 0 && watched > 0 ? (
          <p className='mt-1 text-[11px] text-amber-600 dark:text-amber-400'>
            还有 {remaining} 集可看
          </p>
        ) : watched > 0 ? (
          <p className='mt-1 text-[11px] text-gray-400'>已看到 {watched} 集</p>
        ) : item.error ? (
          <p className='mt-1 truncate text-[11px] text-gray-400' title={item.error}>
            源站暂不可用
          </p>
        ) : item.remark ? (
          <p className='mt-1 truncate text-[11px] text-gray-400' title={item.remark}>
            {item.remark}
          </p>
        ) : null}
      </Link>
      <OrderButtons item={item} onMove={onMove} />
    </div>
  );
}

function DaySection({
  weekday,
  items,
  onMove,
}: {
  weekday: (typeof WEEKDAYS)[number];
  items: UpdateItem[];
  onMove: (key: string, position: MovePosition) => void;
}) {
  const isToday = weekday.value === todayWeekday();
  return (
    <section
      id={`weekday-${weekday.value}`}
      className={`scroll-mt-20 rounded-2xl border p-3 sm:p-4 ${
        isToday
          ? 'border-green-300/70 bg-green-50/50 dark:border-green-700/50 dark:bg-green-950/10'
          : 'border-gray-200/60 bg-white/60 dark:border-gray-700/50 dark:bg-gray-900/30'
      }`}
    >
      <div className='mb-3 flex items-center justify-between gap-2 border-b border-gray-200/70 pb-2.5 dark:border-gray-700/60'>
        <div className='flex items-baseline gap-1.5 whitespace-nowrap'>
          <h2 className={`text-base font-semibold ${isToday ? 'text-green-600 dark:text-green-400' : 'text-gray-800 dark:text-gray-200'}`}>
            {weekday.label}
          </h2>
          <span className='text-xs text-gray-400'>{dateForWeekday(weekday.value)}</span>
        </div>
        <span className='shrink-0 text-xs text-gray-400'>{items.length} 部</span>
      </div>
      {items.length > 0 ? (
        <ul className='grid grid-cols-3 gap-x-3 gap-y-4 xl:grid-cols-1 xl:gap-y-5'>
          {items.map((item) => (
            <li key={item.key} className='min-w-0'>
              <UpdateCard item={item} onMove={onMove} />
            </li>
          ))}
        </ul>
      ) : (
        <p className='py-5 text-center text-xs text-gray-400'>
          {isToday ? '今天没有待更新的收藏' : '这一天没有排播'}
        </p>
      )}
    </section>
  );
}

export default function UpdatesPage() {
  const [items, setItems] = useState<UpdateItem[]>([]);
  const [order, setOrder] = useState<string[]>([]);
  const [orderSaving, setOrderSaving] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [selectedWeekday, setSelectedWeekday] = useState(todayWeekday);
  const [viewMode, setViewMode] = useState<ViewMode>('week');

  const isLocalStorageMode = useCallback(
    () =>
      typeof window !== 'undefined' &&
      (window as typeof window & {
        RUNTIME_CONFIG?: { STORAGE_TYPE?: string };
      }).RUNTIME_CONFIG?.STORAGE_TYPE === 'localstorage',
    []
  );

  const loadLocalUpdates = useCallback(async () => {
    const [favorites, records] = await Promise.all([
      getAllFavorites(),
      getAllPlayRecords(),
    ]);
    const sourceItems = Object.entries(favorites)
      .filter(([key, favorite]: [string, Favorite]) =>
        key.includes('+') && favorite.origin !== 'live'
      )
      .map(([key, favorite]) => {
        const separator = key.indexOf('+');
        const source = key.slice(0, separator);
        const id = key.slice(separator + 1);
        const watchedEpisode = records[key]?.index ?? null;
        const item: UpdateItem = {
          key,
          source,
          id,
          title: favorite.title,
          year: favorite.year,
          cover: favorite.cover,
          sourceName: favorite.source_name,
          totalEpisodes: favorite.total_episodes,
          previousEpisodes: favorite.total_episodes,
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
        return item;
      });

    let schedules: Record<string, Schedule> = {};
    try {
      const cached = localStorage.getItem(LOCAL_SCHEDULES_KEY);
      schedules = cached ? JSON.parse(cached) : {};
    } catch {
      schedules = {};
    }

    const missing = sourceItems.filter((item) => !schedules[item.key]);
    if (missing.length > 0) {
      const response = await fetch('/api/updates/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: missing.map((item) => {
            const favorite = favorites[item.key];
            return {
              key: item.key,
              title: item.title,
              search_title: favorite.search_title,
              year: item.year,
            };
          }),
        }),
      });
      if (!response.ok) throw new Error('获取播出安排失败');
      const data = await response.json();
      schedules = { ...schedules, ...data.schedules };
      localStorage.setItem(LOCAL_SCHEDULES_KEY, JSON.stringify(schedules));
    }

    const localOrder = readLocalOrder();
    const merged = sourceItems.map((item) => ({
      ...item,
      ...schedules[item.key],
    }));

    return {
      items: sortByManualOrder(merged, localOrder),
      refreshedAt: Date.now(),
      fromCache: false,
      totalFavorites: sourceItems.length,
      failed: 0,
      order: localOrder,
    } satisfies UpdatesResponse;
  }, []);

  const loadUpdates = useCallback(async (force = false) => {
    setError('');
    if (force) setRefreshing(true);
    else setLoading(true);
    try {
      const data = isLocalStorageMode()
        ? await loadLocalUpdates()
        : await (async () => {
          const response = await fetch(`/api/updates${force ? '?refresh=1' : ''}`);
          if (!response.ok) throw new Error(`获取更新失败 (${response.status})`);
          return await response.json() as UpdatesResponse;
        })();
      setItems(data.items);
      setOrder(data.order ?? []);
      setRefreshedAt(data.refreshedAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取更新失败，请稍后重试');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [isLocalStorageMode, loadLocalUpdates]);

  useEffect(() => {
    loadUpdates();
  }, [loadUpdates]);

  const orderedItems = useMemo(
    () => sortByManualOrder(items, order),
    [items, order]
  );

  // moveItem 需要当前展示顺序（而不是原始 items 顺序）作为合并基准，
  // 放进 ref 里避免每次排序都重建回调。
  const orderedItemsRef = useRef<UpdateItem[]>([]);
  orderedItemsRef.current = orderedItems;

  /** 手动排序只影响展示顺序，不动快照本身。 */
  const persistOrder = useCallback(
    async (next: string[]) => {
      setOrder(next);
      setOrderSaving(true);
      try {
        if (isLocalStorageMode()) {
          writeLocalOrder(next);
        } else {
          const response = await fetch('/api/updates/order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order: next }),
          });
          if (!response.ok) throw new Error('保存排序失败');
          const data = await response.json();
          if (Array.isArray(data.order)) setOrder(data.order);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : '保存排序失败');
      } finally {
        setOrderSaving(false);
      }
    },
    [isLocalStorageMode]
  );

  const moveItem = useCallback(
    (key: string, position: MovePosition) => {
      const keys = orderedItemsRef.current.map((item) => item.key);
      if (keys.length === 0) return;
      void persistOrder(moveInOrder(order, keys, key, position));
    },
    [order, persistOrder]
  );

  // 已完结的收藏不再占周历格：没有「下一集」可等，留在表里只会把当天的排播挤散。
  // 同一部番的副条目（duplicateOf）也排除，否则同一天会出现两张相同海报。
  const scheduled = useMemo(
    () =>
      orderedItems.filter(
        (item) =>
          isPrimary(item) && !item.isFinished && itemWeekdays(item).length > 0
      ),
    [orderedItems]
  );
  const finished = useMemo(
    () => orderedItems.filter((item) => isPrimary(item) && item.isFinished),
    [orderedItems]
  );
  const recent = useMemo(() => {
    const cutoff = Date.now() - RECENT_WINDOW_MS;
    return orderedItems
      .filter(isPrimary)
      .filter((item) => item.hasUpdate || item.updatedAt >= cutoff)
      .filter((item) => item.updatedAt > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [orderedItems]);
  const unscheduled = useMemo(
    () =>
      orderedItems.filter(
        (item) =>
          isPrimary(item) && !item.isFinished && itemWeekdays(item).length === 0
      ),
    [orderedItems]
  );
  const newCount = useMemo(
    () => orderedItems.filter((item) => isPrimary(item) && item.hasUpdate).length,
    [orderedItems]
  );
  const scheduledToday = useMemo(
    () =>
      scheduled.filter((item) => itemWeekdays(item).includes(todayWeekday()))
        .length,
    [scheduled]
  );

  return (
    <PageLayout activePath='/updates'>
      <div className='mx-auto max-w-[1800px] px-4 py-6 sm:px-8 sm:py-8'>
        <header className='mb-6 flex flex-col gap-5 sm:mb-8 sm:flex-row sm:items-end sm:justify-between'>
          <div>
            <div className='mb-2 flex items-center gap-2 text-green-600 dark:text-green-400'>
              <CalendarDays className='h-5 w-5' />
              <span className='text-xs font-semibold tracking-widest'>我的追番</span>
            </div>
            <h1 className='text-2xl font-bold text-gray-900 dark:text-gray-100 sm:text-3xl'>
              更新时间表
            </h1>
            <p className='mt-2 text-sm text-gray-500 dark:text-gray-400'>
              收藏番剧的每周放送安排，有新集数时在这里提醒你。
            </p>
          </div>
          <div className='flex flex-wrap items-center gap-3'>
            {refreshedAt > 0 && (
              <span className='hidden text-xs text-gray-400 sm:inline'>
                {formatTime(refreshedAt)} 检查
              </span>
            )}
            {order.length > 0 && (
              <button
                type='button'
                data-testid='reset-order'
                onClick={() => void persistOrder([])}
                disabled={orderSaving}
                className='inline-flex h-10 items-center justify-center gap-2 rounded-full border border-gray-300 bg-white px-4 text-sm text-gray-600 transition hover:border-gray-400 hover:text-gray-800 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300'
              >
                <RotateCcw className='h-4 w-4' />
                重置排序
              </button>
            )}
            <button
              type='button'
              onClick={() => loadUpdates(true)}
              disabled={loading || refreshing}
              className='inline-flex h-10 items-center justify-center gap-2 rounded-full bg-green-500 px-5 text-sm font-medium text-white shadow-sm transition hover:bg-green-600 disabled:cursor-not-allowed disabled:opacity-60'
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
              {refreshing ? '正在检查' : '检查更新'}
            </button>
          </div>
        </header>

        <div className='mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3'>
          <div className='rounded-2xl border border-gray-200/60 bg-white/60 p-4 dark:border-gray-700/50 dark:bg-gray-900/30'>
            <div className='flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400'><CalendarDays className='h-4 w-4' />本周放送</div>
            <p className='mt-2 text-2xl font-semibold text-gray-800 dark:text-gray-100'>{scheduled.length}<span className='ml-1 text-xs font-normal text-gray-400'>部</span></p>
          </div>
          <div className='rounded-2xl border border-gray-200/60 bg-white/60 p-4 dark:border-gray-700/50 dark:bg-gray-900/30'>
            <div className='flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400'><Clock3 className='h-4 w-4' />今日安排</div>
            <p className='mt-2 text-2xl font-semibold text-gray-800 dark:text-gray-100'>{scheduledToday}<span className='ml-1 text-xs font-normal text-gray-400'>部</span></p>
          </div>
          <button type='button' onClick={() => setViewMode('recent')} className='col-span-2 rounded-2xl border border-green-200/70 bg-green-50/60 p-4 text-left transition hover:bg-green-50 dark:border-green-800/50 dark:bg-green-950/20 sm:col-span-1'>
            <div className='flex items-center gap-2 text-xs text-green-600 dark:text-green-400'><Sparkles className='h-4 w-4' />最近有动静</div>
            <p className='mt-2 text-2xl font-semibold text-green-700 dark:text-green-300'>{recent.length}<span className='ml-1 text-xs font-normal text-green-500'>部</span></p>
            <p className='mt-1 text-[11px] text-green-600/80 dark:text-green-400/80'>其中新增集数 {newCount} 部</p>
          </button>
        </div>

        {error && (
          <div className='mb-5 flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300' role='alert'>
            <span>{error}</span>
            <button type='button' onClick={() => loadUpdates(true)} className='ml-3 shrink-0 underline'>重试</button>
          </div>
        )}

        <div className='mb-5 flex rounded-full bg-gray-100/80 p-1 dark:bg-gray-800/70 sm:w-fit'>
          {(['week', 'recent'] as ViewMode[]).map((mode) => (
            <button
              key={mode}
              type='button'
              onClick={() => setViewMode(mode)}
              className={`flex-1 rounded-full px-5 py-2 text-sm transition sm:flex-none ${viewMode === mode ? 'bg-white font-medium text-green-600 shadow-sm dark:bg-gray-700 dark:text-green-400' : 'text-gray-500 dark:text-gray-400'}`}
            >
              {mode === 'week' ? '本周时间表' : `最近更新 ${recent.length ? `(${recent.length})` : ''}`}
            </button>
          ))}
        </div>

        {loading ? (
          <div className='rounded-2xl border border-gray-200/60 bg-white/60 p-10 text-center dark:border-gray-700/50 dark:bg-gray-900/30'>
            <RefreshCw className='mx-auto h-6 w-6 animate-spin text-green-500' />
            <p className='mt-3 text-sm text-gray-500 dark:text-gray-400'>正在核对收藏与番剧放送安排…</p>
            <p className='mt-1 text-xs text-gray-400'>首次检查需要读取视频源，请稍候</p>
          </div>
        ) : items.length === 0 ? (
          <div className='rounded-2xl border border-dashed border-gray-300 py-20 text-center dark:border-gray-700'>
            <CalendarDays className='mx-auto h-10 w-10 text-gray-300 dark:text-gray-600' />
            <h2 className='mt-4 font-medium text-gray-700 dark:text-gray-300'>还没有可追的收藏</h2>
            <p className='mt-2 text-sm text-gray-400'>收藏喜欢的番剧后，就能在这里看到更新时间表。</p>
            <Link href='/douban?type=anime' className='mt-5 inline-block rounded-full bg-green-500 px-5 py-2 text-sm text-white'>去发现番剧</Link>
          </div>
        ) : viewMode === 'recent' ? (
          <section className='rounded-2xl border border-gray-200/60 bg-white/60 p-5 dark:border-gray-700/50 dark:bg-gray-900/30 sm:p-6'>
            <div className='mb-2 flex flex-wrap items-center gap-2'>
              <Sparkles className='h-5 w-5 text-green-500' />
              <h2 className='text-lg font-semibold text-gray-800 dark:text-gray-100'>最近更新</h2>
              <span className='text-xs text-gray-400'>按源站入库时间排序，7 天内</span>
            </div>
            <p className='mb-6 text-xs text-gray-400'>
              「新增」表示本地核对出的集数变化；「源站更新」表示源站最近改动过条目（可能只是换线路或修正信息）。
            </p>
            {recent.length > 0 ? (
              <div className='grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8'>
                {recent.map((item) => (
                  <UpdateCard key={item.key} item={item} onMove={moveItem} variant='recent' />
                ))}
              </div>
            ) : (
              <div className='py-10 text-center'>
                <CheckCircle2 className='mx-auto h-8 w-8 text-green-400' />
                <p className='mt-3 text-sm text-gray-600 dark:text-gray-300'>最近 7 天没有发现更新</p>
                <p className='mt-1 text-xs text-gray-400'>已经是最新状态了，过几天再来看看。</p>
              </div>
            )}
          </section>
        ) : (
          <>
            <div className='scrollbar-hide -mx-1 mb-5 flex gap-2 overflow-x-auto px-1 pb-1 lg:hidden' aria-label='选择星期'>
              {WEEKDAYS.map((day) => (
                <button
                  key={day.value}
                  type='button'
                  onClick={() => {
                    setSelectedWeekday(day.value);
                    document.getElementById(`weekday-${day.value}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                  className={`flex shrink-0 items-center gap-1.5 rounded-full px-4 py-2 text-sm ${selectedWeekday === day.value ? 'bg-green-500 text-white' : 'bg-white/70 text-gray-600 dark:bg-gray-800 dark:text-gray-300'}`}
                >
                  {day.label}
                  <span className={`text-xs ${selectedWeekday === day.value ? 'text-green-100' : 'text-gray-400'}`}>{scheduled.filter((item) => itemWeekdays(item).includes(day.value)).length}</span>
                </button>
              ))}
            </div>
            {/* 仿 B 站追番表：宽屏七列并排，窄屏两列堆叠 */}
            <div className='grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-7'>
              {WEEKDAYS.map((day) => (
                <DaySection
                  key={day.value}
                  weekday={day}
                  items={scheduled.filter((item) => itemWeekdays(item).includes(day.value))}
                  onMove={moveItem}
                />
              ))}
            </div>
            {unscheduled.length > 0 && (
              <section className='mt-6 rounded-2xl border border-gray-200/60 bg-white/50 p-5 dark:border-gray-700/50 dark:bg-gray-900/20'>
                <h2 className='font-medium text-gray-700 dark:text-gray-200'>更新日期待确认 <span className='ml-1 text-xs font-normal text-gray-400'>{unscheduled.length} 部</span></h2>
                <p className='mt-1 text-xs text-gray-400'>这些收藏暂未匹配到 Bangumi 播出安排；检查到的新集数仍会保留。</p>
                <div className='mt-5 grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 2xl:grid-cols-8'>
                  {unscheduled.map((item) => (
                    <UpdateCard key={item.key} item={item} onMove={moveItem} />
                  ))}
                </div>
              </section>
            )}
            {finished.length > 0 && (
              <section className='mt-6 rounded-2xl border border-gray-200/60 bg-white/50 p-5 dark:border-gray-700/50 dark:bg-gray-900/20'>
                <h2 className='font-medium text-gray-700 dark:text-gray-200'>已完结 <span className='ml-1 text-xs font-normal text-gray-400'>{finished.length} 部</span></h2>
                <p className='mt-1 text-xs text-gray-400'>源站备注为「已完结」的收藏，不再占据每周排播格。</p>
                <div className='mt-5 grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 2xl:grid-cols-10'>
                  {finished.map((item) => (
                    <UpdateCard key={item.key} item={item} onMove={moveItem} />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
        {!loading && items.length > 0 && (
          <p className='mt-6 text-center text-xs text-gray-400'>
            集数与「已完结」判定来自视频源的备注与分集；放送星期来自 Bangumi，推断得出的星期可能与实际档期有偏差。
          </p>
        )}
      </div>
    </PageLayout>
  );
}
