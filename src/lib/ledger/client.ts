import { commitOp, dropPendingMerge, loadLedger } from './backend';
import type { Operation, OpPayload, OutboxEntry } from './types';
import { OP_LABELS } from './types';

const CLIENT_KEY = 'conf-client-id';
const OUTBOX_KEY = 'conf-outbox-v1';

let counter = 0;

/** 每个标签页一个身份（两位主持人 = 两个标签页），重开页面会换新身份 */
export function getClientId(): string {
  if (typeof sessionStorage === 'undefined') return 'server';
  let id = sessionStorage.getItem(CLIENT_KEY);
  if (!id) {
    id = `主持-${Math.random().toString(36).slice(2, 6)}`;
    sessionStorage.setItem(CLIENT_KEY, id);
  }
  return id;
}

const newOpId = (): string => `${getClientId()}-${Date.now().toString(36)}-${++counter}`;

export function loadOutbox(): OutboxEntry[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    return (JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? '[]') as OutboxEntry[]) ?? [];
  } catch {
    return [];
  }
}

function saveOutbox(entries: OutboxEntry[]): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(entries));
}

/**
 * 发起一次写入：以当前账上 version 为依据版本，先登记到待办（持久化），再立即尝试落账。
 * 落账失败时操作留在待办里，之后按厅 + 操作编号重试，重开页面也会继续。
 */
export function submitOp(hallId: string, payload: OpPayload): void {
  const hall = loadLedger().halls[hallId];
  const op: Operation = {
    hallId,
    opId: newOpId(),
    baseVersion: hall?.version ?? 0,
    actor: getClientId(),
    at: new Date().toISOString(),
    payload
  };
  const outbox = loadOutbox();
  outbox.push({ op, attempts: 0 });
  saveOutbox(outbox);
  flushOutbox();
}

/** 把待办里的操作逐条落账。成功 / 重复 / 冲突进待合并都算了结；只有写账抛错才保留待办。 */
export function flushOutbox(): void {
  const keep: OutboxEntry[] = [];
  for (const entry of loadOutbox()) {
    try {
      commitOp(entry.op);
    } catch (err) {
      entry.attempts += 1;
      entry.lastError = err instanceof Error ? err.message : String(err);
      keep.push(entry);
    }
  }
  saveOutbox(keep);
}

/** 按厅 + 操作编号重试一条待办 */
export function retryOp(hallId: string, opId: string): void {
  const outbox = loadOutbox();
  const entry = outbox.find((e) => e.op.hallId === hallId && e.op.opId === opId);
  if (!entry) return;
  try {
    commitOp(entry.op);
    saveOutbox(outbox.filter((e) => e !== entry));
  } catch (err) {
    entry.attempts += 1;
    entry.lastError = err instanceof Error ? err.message : String(err);
    saveOutbox(outbox);
  }
}

export function discardOp(hallId: string, opId: string): void {
  saveOutbox(loadOutbox().filter((e) => !(e.op.hallId === hallId && e.op.opId === opId)));
}

/** 待合并的解决：以当前账上 version 为依据版本重新提交同一内容（显式动作，不静默覆盖） */
export function rebasePendingMerge(mergeId: string): void {
  const file = loadLedger();
  const merge = file.pendingMerges.find((m) => m.id === mergeId);
  if (!merge) return;
  const hall = file.halls[merge.hallId];
  const op: Operation = {
    ...merge.op,
    opId: newOpId(),
    baseVersion: hall?.version ?? merge.op.baseVersion,
    actor: getClientId(),
    at: new Date().toISOString()
  };
  const outbox = loadOutbox();
  outbox.push({ op, attempts: 0 });
  saveOutbox(outbox);
  dropPendingMerge(mergeId, `${getClientId()} 将「${OP_LABELS[merge.op.payload.type]}」以 v${op.baseVersion} 为据重新提交`);
  flushOutbox();
}
