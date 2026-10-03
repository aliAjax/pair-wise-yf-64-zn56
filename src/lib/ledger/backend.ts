import type {
  Caption,
  CommitResult,
  DiffEntry,
  HallLedger,
  LedgerFile,
  Operation,
  PendingMerge,
  Speech
} from './types';

export const LEDGER_KEY = 'conf-ledger-v2';
export const FAILURE_KEY = 'conf-simulate-failure';

const nowIso = () => new Date().toISOString();

export const uid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function isFailureOn(): boolean {
  return typeof localStorage !== 'undefined' && localStorage.getItem(FAILURE_KEY) === '1';
}

export function setFailure(on: boolean): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(FAILURE_KEY, on ? '1' : '0');
}

function seedHall(hallId: string, at: string): HallLedger {
  if (hallId === 'hall-b') {
    return {
      hallId,
      version: 1,
      contextEpoch: 1,
      queue: [
        { id: 'speech-b1', hallId, speaker: 'Maria Silva', delegation: '巴西', language: '葡萄牙语', topic: '边缘算力与能源', plannedSeconds: 420, remainingSeconds: 420, status: 'queued', updatedAt: at }
      ],
      captions: [],
      duty: [
        { channelId: 'ch-b-zh', hallId, language: '中文', interpreter: '何佳', status: 'active', health: 94, since: at }
      ],
      appliedOps: [],
      updatedAt: at
    };
  }
  return {
    hallId,
    version: 1,
    contextEpoch: 1,
    queue: [
      { id: 'speech-1', hallId, speaker: 'Amina Diallo', delegation: '塞内加尔', language: '英语', topic: '适应性融资缺口', plannedSeconds: 600, remainingSeconds: 214, status: 'speaking', updatedAt: at },
      { id: 'speech-2', hallId, speaker: '李明远', delegation: '中国', language: '中文', topic: '绿色基础设施机制', plannedSeconds: 600, remainingSeconds: 600, status: 'queued', updatedAt: at },
      { id: 'speech-3', hallId, speaker: 'Jonas Weber', delegation: '德国', language: '德语', topic: '跨境电网投资', plannedSeconds: 480, remainingSeconds: 480, status: 'queued', updatedAt: at }
    ],
    captions: [
      { id: 'caption-1', hallId, speechId: 'speech-1', language: '中文', interpreter: '周雨', text: '我们需要把适应资金与可衡量的社区韧性目标绑定。', revision: 2, confirmed: true, stale: false, epoch: 1, at },
      { id: 'caption-2', hallId, speechId: 'speech-1', language: '中文', interpreter: '周雨', text: '草稿：社区韧性目标需要季度披露。', revision: 1, confirmed: false, stale: false, epoch: 1, at }
    ],
    duty: [
      { channelId: 'ch-a-zh', hallId, language: '中文', interpreter: '周雨', status: 'active', health: 96, since: at },
      { channelId: 'ch-a-es', hallId, language: '西班牙语', interpreter: 'Lucía M.', status: 'active', health: 91, since: at },
      { channelId: 'ch-a-fr', hallId, language: '法语', interpreter: 'Noah B.', status: 'standby', health: 88, since: at }
    ],
    appliedOps: [],
    updatedAt: at
  };
}

export function seedLedger(): LedgerFile {
  const at = nowIso();
  return {
    halls: { 'hall-a': seedHall('hall-a', at), 'hall-b': seedHall('hall-b', at) },
    pendingMerges: [],
    events: [
      { id: uid(), hallId: 'hall-a', at, message: 'Amina Diallo 开始发言，中文频道由周雨接续' },
      { id: uid(), hallId: 'hall-a', at, message: '临时插话申请已插入队列第2位' }
    ]
  };
}

function persist(file: LedgerFile): void {
  localStorage.setItem(LEDGER_KEY, JSON.stringify(file));
}

/** 写账的唯一出口。模拟故障开启时拒绝写入，调用方负责把操作留在待办里重试。 */
export function saveLedger(file: LedgerFile): void {
  if (isFailureOn()) throw new Error('模拟存储故障：版本账写入被拒绝');
  persist(file);
}

export function loadLedger(): LedgerFile {
  if (typeof localStorage === 'undefined') return seedLedger();
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    if (!raw) {
      const seeded = seedLedger();
      try { persist(seeded); } catch { /* 首次播种失败不阻塞渲染 */ }
      return seeded;
    }
    return JSON.parse(raw) as LedgerFile;
  } catch {
    return seedLedger();
  }
}

const currentSpeaking = (hall: HallLedger): Speech | undefined => hall.queue.find((s) => s.status === 'speaking');

const indexAfterCurrent = (hall: HallLedger): number => {
  const i = hall.queue.findIndex((s) => s.status === 'speaking');
  return i >= 0 ? i + 1 : 0;
};

/** 上下文变化后：未确认草稿失效，并重归属到当前发言人与当前在岗译员 */
function reassignStaleDrafts(hall: HallLedger): void {
  const speaking = currentSpeaking(hall);
  for (const caption of hall.captions) {
    if (caption.confirmed || caption.epoch === hall.contextEpoch) continue;
    const duty = hall.duty.find((d) => d.language === caption.language);
    caption.reassignedFrom = { speechId: caption.speechId, interpreter: caption.interpreter, epoch: caption.epoch };
    caption.stale = true;
    if (speaking) caption.speechId = speaking.id;
    if (duty) caption.interpreter = duty.interpreter;
    caption.epoch = hall.contextEpoch;
  }
}

/** 发言人切换、译员交接完成、队列顺序变化 → 上下文纪元 +1，未确认草稿失效重归属 */
function bumpContext(hall: HallLedger): void {
  hall.contextEpoch += 1;
  reassignStaleDrafts(hall);
}

/** 应用操作到账上（调用前已校验 baseVersion）。返回时间线消息。 */
function applyOp(hall: HallLedger, op: Operation): string {
  const p = op.payload;
  switch (p.type) {
    case 'queue.add': {
      const speech: Speech = {
        id: uid(),
        hallId: hall.hallId,
        ...p.speech,
        remainingSeconds: p.speech.plannedSeconds,
        status: 'queued',
        updatedAt: op.at
      };
      const insertAt = p.insertAfterCurrent ? indexAfterCurrent(hall) : hall.queue.length;
      hall.queue.splice(insertAt, 0, speech);
      if (insertAt < hall.queue.length - 1) bumpContext(hall);
      return `${speech.speaker} 加入发言队列${p.insertAfterCurrent ? '（临时插话，插到当前发言之后）' : ''}`;
    }
    case 'queue.advance': {
      const before = currentSpeaking(hall)?.id;
      const target = hall.queue.find((s) => s.id === p.speechId);
      if (!target) return `发言 ${p.speechId} 不存在，未变更`;
      if (p.status === 'speaking') {
        for (const s of hall.queue) {
          if (s.status === 'speaking' && s.id !== p.speechId) s.status = 'done';
        }
      }
      target.status = p.status;
      target.updatedAt = op.at;
      if (currentSpeaking(hall)?.id !== before) bumpContext(hall);
      return `${target.speaker} 状态更新为 ${p.status}`;
    }
    case 'queue.reorder': {
      const idx = hall.queue.findIndex((s) => s.id === p.speechId);
      const swap = idx + p.direction;
      if (idx < 0 || swap < 0 || swap >= hall.queue.length) return '队列顺序未变化';
      const moved = hall.queue[idx];
      hall.queue[idx] = hall.queue[swap];
      hall.queue[swap] = moved;
      bumpContext(hall);
      return `队列顺序调整：${moved.speaker} ${p.direction < 0 ? '上移' : '下移'}一位`;
    }
    case 'queue.adjustTime': {
      const target = hall.queue.find((s) => s.id === p.speechId);
      if (!target) return `发言 ${p.speechId} 不存在，未变更`;
      target.remainingSeconds = Math.max(0, target.remainingSeconds + p.deltaSeconds);
      target.updatedAt = op.at;
      return `${target.speaker} 剩余时间调整 ${p.deltaSeconds} 秒（现 ${target.remainingSeconds} 秒）`;
    }
    case 'caption.saveDraft': {
      const duty = hall.duty.find((d) => d.language === p.language);
      const existing = hall.captions.find((c) => c.speechId === p.speechId && c.language === p.language && !c.confirmed);
      if (existing) {
        existing.text = p.text;
        existing.revision += 1;
        existing.interpreter = duty?.interpreter ?? existing.interpreter;
        existing.epoch = hall.contextEpoch;
        existing.stale = false;
        existing.at = op.at;
      } else {
        const draft: Caption = {
          id: uid(),
          hallId: hall.hallId,
          speechId: p.speechId,
          language: p.language,
          interpreter: duty?.interpreter ?? '未指派',
          text: p.text,
          revision: 1,
          confirmed: false,
          stale: false,
          epoch: hall.contextEpoch,
          at: op.at
        };
        hall.captions.unshift(draft);
      }
      return `字幕草稿已保存（${p.language}）`;
    }
    case 'caption.confirm': {
      const caption = hall.captions.find((c) => c.id === p.captionId);
      if (!caption) return `字幕 ${p.captionId} 不存在，未变更`;
      caption.confirmed = true;
      caption.stale = false;
      caption.epoch = hall.contextEpoch;
      caption.revision += 1;
      caption.at = op.at;
      return `字幕已确认发布（${caption.language} v${caption.revision}）`;
    }
    case 'duty.handoffStart': {
      const duty = hall.duty.find((d) => d.channelId === p.channelId);
      if (!duty) return `频道 ${p.channelId} 不存在，未变更`;
      duty.status = 'handoff';
      return `${duty.language} 频道开始译员交接，在岗译文版本冻结`;
    }
    case 'duty.handoffComplete': {
      const duty = hall.duty.find((d) => d.channelId === p.channelId);
      if (!duty) return `频道 ${p.channelId} 不存在，未变更`;
      const previous = duty.interpreter;
      duty.interpreter = p.interpreter;
      duty.status = 'active';
      duty.since = op.at;
      duty.health = Math.min(100, duty.health + 2);
      bumpContext(hall);
      return `${duty.language} 频道由 ${previous} 交接给 ${p.interpreter}，后续字幕归属新译员`;
    }
  }
}

/** 冲突时为待合并条目计算字段级差异：当前账上值 vs 本次提交值 */
export function diffOp(hall: HallLedger, op: Operation): DiffEntry[] {
  const p = op.payload;
  const speakerOf = (id: string) => hall.queue.find((s) => s.id === id)?.speaker ?? id;
  const speaking = currentSpeaking(hall);
  switch (p.type) {
    case 'queue.add': {
      const insertAt = p.insertAfterCurrent ? indexAfterCurrent(hall) : hall.queue.length;
      return [
        { label: '队列长度', current: `${hall.queue.length} 条`, incoming: `依据 v${op.baseVersion} 追加 1 条` },
        { label: '新发言人', current: '—', incoming: `${p.speech.speaker}（${p.speech.delegation}）· 第 ${insertAt + 1} 位` }
      ];
    }
    case 'queue.advance': {
      const target = hall.queue.find((s) => s.id === p.speechId);
      return [
        { label: `发言人 ${target?.speaker ?? p.speechId}`, current: `状态 ${target?.status ?? '不存在'}`, incoming: `设为 ${p.status}` },
        { label: '当前发言人', current: speaking?.speaker ?? '无', incoming: p.status === 'speaking' ? speakerOf(p.speechId) : speaking?.id === p.speechId ? '无（结束当前发言）' : speaking?.speaker ?? '无' }
      ];
    }
    case 'queue.reorder':
      return [
        { label: '队列顺序', current: hall.queue.map((s) => s.speaker).join(' → ') || '（空）', incoming: `${speakerOf(p.speechId)} ${p.direction < 0 ? '上移' : '下移'}一位` }
      ];
    case 'queue.adjustTime': {
      const target = hall.queue.find((s) => s.id === p.speechId);
      return [
        { label: `${target?.speaker ?? p.speechId} 剩余时间`, current: `${target?.remainingSeconds ?? 0} 秒`, incoming: `调整 ${p.deltaSeconds} 秒（依据 v${op.baseVersion}）` }
      ];
    }
    case 'caption.saveDraft': {
      const current = hall.captions.find((c) => c.speechId === p.speechId && c.language === p.language && !c.confirmed);
      return [
        { label: `${speakerOf(p.speechId)} · ${p.language} 草稿`, current: current ? `v${current.revision}：${current.text}` : '（暂无草稿）', incoming: p.text }
      ];
    }
    case 'caption.confirm': {
      const caption = hall.captions.find((c) => c.id === p.captionId);
      return [
        { label: `字幕 ${p.captionId.slice(0, 8)}…`, current: caption ? `${caption.confirmed ? '已确认' : '草稿'} v${caption.revision}${caption.stale ? ' · 已失效重归属' : ''}` : '不存在', incoming: '确认发布' }
      ];
    }
    case 'duty.handoffStart': {
      const duty = hall.duty.find((d) => d.channelId === p.channelId);
      return [
        { label: `${duty?.language ?? p.channelId} 频道`, current: `${duty?.interpreter ?? '?'}（${duty?.status ?? '?'}）`, incoming: '开始交接' }
      ];
    }
    case 'duty.handoffComplete': {
      const duty = hall.duty.find((d) => d.channelId === p.channelId);
      return [
        { label: `${duty?.language ?? p.channelId} 频道译员`, current: `${duty?.interpreter ?? '?'}（${duty?.status ?? '?'}）`, incoming: `${p.interpreter} 接续` }
      ];
    }
  }
}

function trimFile(file: LedgerFile): void {
  file.events = file.events.slice(0, 80);
  file.pendingMerges = file.pendingMerges.slice(0, 50);
  for (const hall of Object.values(file.halls)) {
    hall.appliedOps = hall.appliedOps.slice(-300);
    hall.captions = hall.captions.slice(0, 100);
  }
}

/**
 * 提交一次写入：
 * - opId 已落账 → duplicate（重试幂等，不重复应用）；
 * - baseVersion 与账上 version 不一致 → 先到内容保留，本次写入进待合并并列差异；
 * - 一致 → 应用并 version+1。
 * saveLedger 抛错时账上无任何变化，调用方把操作留在待办里。
 */
export function commitOp(op: Operation): CommitResult {
  const file = loadLedger();
  const hall = file.halls[op.hallId];
  if (!hall) throw new Error(`未知会议厅 ${op.hallId}`);
  if (hall.appliedOps.includes(op.opId)) return { status: 'duplicate', version: hall.version };
  if (op.baseVersion !== hall.version) {
    const merge: PendingMerge = { id: uid(), hallId: op.hallId, op, diffs: diffOp(hall, op), at: op.at };
    file.pendingMerges.unshift(merge);
    file.events.unshift({
      id: uid(),
      hallId: op.hallId,
      at: op.at,
      message: `${op.actor} 的「${op.payload.type}」依据 v${op.baseVersion}，当前 v${hall.version}，已进入待合并（先到内容保留）`
    });
    trimFile(file);
    saveLedger(file);
    return { status: 'conflict', version: hall.version, mergeId: merge.id };
  }
  const message = applyOp(hall, op);
  hall.version += 1;
  hall.appliedOps.push(op.opId);
  hall.updatedAt = op.at;
  file.events.unshift({ id: uid(), hallId: op.hallId, at: op.at, message: `${op.actor}：${message}（v${hall.version}）` });
  trimFile(file);
  saveLedger(file);
  return { status: 'ok', version: hall.version };
}

/** 移除待合并条目（重写提交后或放弃后），并记一条时间线 */
export function dropPendingMerge(mergeId: string, note: string): void {
  const file = loadLedger();
  const merge = file.pendingMerges.find((m) => m.id === mergeId);
  if (!merge) return;
  file.pendingMerges = file.pendingMerges.filter((m) => m.id !== mergeId);
  file.events.unshift({ id: uid(), hallId: merge.hallId, at: nowIso(), message: note });
  trimFile(file);
  saveLedger(file);
}
