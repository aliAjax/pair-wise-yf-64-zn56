export type SpeechStatus = 'queued' | 'speaking' | 'done' | 'skipped';
export type DutyStatus = 'active' | 'handoff' | 'standby';

export interface HallInfo {
  id: string;
  name: string;
  topic: string;
  simultaneousChannels: number;
}

export const HALL_DIRECTORY: HallInfo[] = [
  { id: 'hall-a', name: 'A厅 · 全体会议', topic: '全球气候融资', simultaneousChannels: 6 },
  { id: 'hall-b', name: 'B厅 · 技术分会', topic: '人工智能基础设施', simultaneousChannels: 4 }
];

export interface Speech {
  id: string;
  hallId: string;
  speaker: string;
  delegation: string;
  language: string;
  topic: string;
  plannedSeconds: number;
  remainingSeconds: number;
  status: SpeechStatus;
  updatedAt: string;
}

/** 字幕草稿/译文的归属信息：绑定到某次发言、某位在岗译员、某个上下文纪元 */
export interface CaptionAttribution {
  speechId: string;
  interpreter: string;
  epoch: number;
}

export interface Caption {
  id: string;
  hallId: string;
  speechId: string;
  language: string;
  interpreter: string;
  text: string;
  revision: number;
  /** false = 未确认草稿，会在上下文变化时失效重归属 */
  confirmed: boolean;
  /** 因发言人切换/译员交接/队列顺序变化而失效 */
  stale: boolean;
  epoch: number;
  reassignedFrom?: CaptionAttribution;
  at: string;
}

/** 译员在岗记录（每个同传频道一行） */
export interface DutyRecord {
  channelId: string;
  hallId: string;
  language: string;
  interpreter: string;
  status: DutyStatus;
  health: number;
  since: string;
}

/**
 * 按厅版本账：发言队列、字幕草稿、译员在岗记录共用同一个 version。
 * 任何写入都必须携带 baseVersion，与账上 version 一致才允许落账。
 */
export interface HallLedger {
  hallId: string;
  version: number;
  /** 上下文纪元：发言人切换 / 译员交接完成 / 队列顺序变化时 +1 */
  contextEpoch: number;
  queue: Speech[];
  captions: Caption[];
  duty: DutyRecord[];
  /** 已落账的操作编号，用于重试幂等 */
  appliedOps: string[];
  updatedAt: string;
}

export type OpPayload =
  | { type: 'queue.add'; speech: { speaker: string; delegation: string; language: string; topic: string; plannedSeconds: number }; insertAfterCurrent: boolean }
  | { type: 'queue.advance'; speechId: string; status: SpeechStatus }
  | { type: 'queue.reorder'; speechId: string; direction: -1 | 1 }
  | { type: 'queue.adjustTime'; speechId: string; deltaSeconds: number }
  | { type: 'caption.saveDraft'; speechId: string; language: string; text: string }
  | { type: 'caption.confirm'; captionId: string }
  | { type: 'duty.handoffStart'; channelId: string }
  | { type: 'duty.handoffComplete'; channelId: string; interpreter: string };

export type OpType = OpPayload['type'];

export const OP_LABELS: Record<OpType, string> = {
  'queue.add': '加入发言',
  'queue.advance': '发言状态',
  'queue.reorder': '队列排序',
  'queue.adjustTime': '计时调整',
  'caption.saveDraft': '字幕草稿',
  'caption.confirm': '字幕确认',
  'duty.handoffStart': '开始交接',
  'duty.handoffComplete': '完成交接'
};

/** 一次写入：必须带依据版本 baseVersion，opId 在厅内唯一用于重试与幂等 */
export interface Operation {
  hallId: string;
  opId: string;
  baseVersion: number;
  actor: string;
  at: string;
  payload: OpPayload;
}

export interface DiffEntry {
  label: string;
  current: string;
  incoming: string;
}

/** 冲突后进入的待合并条目：先到内容保留，后到内容只在此列差异等待处理 */
export interface PendingMerge {
  id: string;
  hallId: string;
  op: Operation;
  diffs: DiffEntry[];
  at: string;
}

export interface LedgerEvent {
  id: string;
  hallId: string;
  at: string;
  message: string;
}

export interface LedgerFile {
  halls: Record<string, HallLedger>;
  pendingMerges: PendingMerge[];
  events: LedgerEvent[];
}

/** 写入失败后保留的待办 */
export interface OutboxEntry {
  op: Operation;
  attempts: number;
  lastError?: string;
}

export type CommitResult =
  | { status: 'ok'; version: number }
  | { status: 'duplicate'; version: number }
  | { status: 'conflict'; version: number; mergeId: string };
