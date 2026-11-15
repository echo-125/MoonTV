export type UpdateMatchStatus = 'matched' | 'unmatched' | 'ambiguous';

/** 星期结论的来源：calendar 权威（Bangumi 追番表），search 为标题检索推断。 */
export type ScheduleSource = 'calendar' | 'search' | null;

export interface UpdateItem {
  key: string;
  source: string;
  id: string;
  title: string;
  year: string;
  cover: string;
  sourceName: string;
  totalEpisodes: number;
  previousEpisodes: number;
  watchedEpisode: number | null;
  hasUpdate: boolean;
  updatedAt: number;
  weekday: number | null;
  /** 全部放送星期（升序）；多档期番会同时出现在多天，空数组表示排期未知。 */
  weekdays: number[];
  bangumiId: number | null;
  bangumiTitle: string | null;
  matchStatus: UpdateMatchStatus;
  /** 星期结论的可信来源；前端用来区分权威排期与推断。 */
  scheduleSource: ScheduleSource;
  /** 源站最后入库时间（毫秒）；0 表示源站没有给出时间。 */
  sourceUpdatedAt: number;
  /** 源站 vod_remarks 原文，如「更新至第109集」「已完结」。 */
  remark: string;
  /** 源站备注或 Bangumi 集数表明已完结。 */
  isFinished: boolean;
  /** 同一 Bangumi 条目在别的视频源已有更新，指向保留项的 key；null 表示本项就是保留项。 */
  duplicateOf: string | null;
  error: string | null;
}

export interface UpdatesResponse {
  items: UpdateItem[];
  refreshedAt: number;
  fromCache: boolean;
  totalFavorites: number;
  failed: number;
  /** 用户手动排序（收藏 key 数组），空数组表示默认顺序。 */
  order: string[];
}

export interface UpdatesSnapshot {
  refreshedAt: number;
  totalFavorites: number;
  items: UpdateItem[];
}

export interface ScheduleItem {
  weekday: number;
  /** 全部放送星期（升序）；多档期番如「星期日、星期二」会返回两个。 */
  weekdays: number[];
  bangumiId: number;
  bangumiTitle: string;
  matchStatus: UpdateMatchStatus;
  scheduleSource: Exclude<ScheduleSource, null>;
  /** Bangumi 条目声明的总集数，用于判断是否已完结；0 表示未知。 */
  bangumiEpisodes: number;
}

export interface SchedulesResponse {
  schedules: Record<string, ScheduleItem>;
}

/** 用户手动排序：数组顺序即展示顺序，靠前的置顶、靠后的置底。 */
export interface UpdatesOrder {
  order: string[];
}
