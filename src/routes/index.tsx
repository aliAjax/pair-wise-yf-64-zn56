import { $, component$, useSignal, useStore, useVisibleTask$ } from '@builder.io/qwik';
import { Progress } from '@qwik-ui/headless';
import { QueryClient } from '@tanstack/query-core';
import { reset, useForm, zodForm$ } from '@modular-forms/qwik';
import { useSpeakLocale } from 'qwik-speak';
import { z } from 'zod';
import type { DocumentHead } from '@builder.io/qwik-city';
import { HALL_DIRECTORY, OP_LABELS } from '~/lib/ledger/types';
import type { LedgerFile, OutboxEntry, SpeechStatus } from '~/lib/ledger/types';
import { isFailureOn, loadLedger, dropPendingMerge, setFailure } from '~/lib/ledger/backend';
import { discardOp, flushOutbox, getClientId, loadOutbox, rebasePendingMerge, retryOp, submitOp } from '~/lib/ledger/client';
import { approveTerm, loadTerms } from '~/lib/terms';
import type { Term } from '~/lib/terms';

const LOW_LATENCY_KEY = 'conf-low-latency';

interface View {
  ledger: LedgerFile;
  outbox: OutboxEntry[];
  terms: Term[];
  activeHallId: string;
  clientId: string;
  lowLatency: boolean;
  simulateFailure: boolean;
}

const captionSchema = z.object({ text: z.string().min(1, '字幕不能为空') });
const queueSchema = z.object({
  speaker: z.string().min(2, '请输入发言人'),
  delegation: z.string().min(2, '请输入代表团'),
  language: z.string().min(2),
  topic: z.string().min(3, '请输入议题'),
  plannedSeconds: z.coerce.number().min(60).max(3600)
});
type QueueForm = z.infer<typeof queueSchema>;

const fmtClock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
const hallName = (hallId: string) => HALL_DIRECTORY.find((h) => h.id === hallId)?.name ?? hallId;

export default component$(() => {
  const locale = useSpeakLocale();
  const view = useStore<View>({
    ledger: loadLedger(),
    outbox: [],
    terms: loadTerms(),
    activeHallId: HALL_DIRECTORY[0].id,
    clientId: '…',
    lowLatency: false,
    simulateFailure: false
  });
  const interrupt = useSignal(false);
  const captionLoader = useSignal({ text: '' });
  const [captionForm, { Form: CaptionForm, Field: CaptionField }] = useForm<z.infer<typeof captionSchema>>({
    loader: captionLoader,
    validate: zodForm$(captionSchema)
  });
  const queueLoader = useSignal<QueueForm>({ speaker: '', delegation: '', language: '英语', topic: '', plannedSeconds: 300 });
  const [queueForm, { Form: QueueForm, Field: QueueField }] = useForm<QueueForm>({
    loader: queueLoader,
    validate: zodForm$(queueSchema)
  });

  const refresh = $(() => {
    view.ledger = loadLedger();
    view.outbox = loadOutbox();
    view.terms = loadTerms();
    view.simulateFailure = isFailureOn();
  });

  useVisibleTask$(() => {
    view.clientId = getClientId();
    view.lowLatency = localStorage.getItem(LOW_LATENCY_KEY) === '1';
    // 重开继续：页面加载后立即重试上次未落账的待办
    flushOutbox();
    refresh();
    const onStorage = () => refresh();
    window.addEventListener('storage', onStorage);
    const timer = window.setInterval(() => {
      flushOutbox();
      refresh();
    }, 4000);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.clearInterval(timer);
    };
  });

  const hall = () => view.ledger.halls[view.activeHallId];
  const hallMeta = () => HALL_DIRECTORY.find((h) => h.id === view.activeHallId) ?? HALL_DIRECTORY[0];
  const queue = () => hall()?.queue ?? [];
  const speaking = () => queue().find((s) => s.status === 'speaking');
  const drafts = () => (hall()?.captions ?? []).filter((c) => !c.confirmed);
  const confirmedCaptions = () => (hall()?.captions ?? []).filter((c) => c.confirmed).slice(0, 5);
  const hallMerges = () => view.ledger.pendingMerges.filter((m) => m.hallId === view.activeHallId);
  const hallEvents = () => view.ledger.events.filter((e) => e.hallId === view.activeHallId).slice(0, 12);
  const speakerName = (speechId: string) => queue().find((s) => s.id === speechId)?.speaker ?? speechId;

  const selectHall$ = $((hallId: string) => {
    view.activeHallId = hallId;
  });

  const addSpeech$ = $((values: QueueForm) => {
    submitOp(view.activeHallId, {
      type: 'queue.add',
      speech: { speaker: values.speaker, delegation: values.delegation, language: values.language, topic: values.topic, plannedSeconds: values.plannedSeconds },
      insertAfterCurrent: interrupt.value
    });
    interrupt.value = false;
    reset(queueForm);
    refresh();
  });

  const advanceSpeech$ = $((speechId: string, status: SpeechStatus) => {
    submitOp(view.activeHallId, { type: 'queue.advance', speechId, status });
    refresh();
  });

  const reorderSpeech$ = $((speechId: string, direction: -1 | 1) => {
    submitOp(view.activeHallId, { type: 'queue.reorder', speechId, direction });
    refresh();
  });

  const adjustTime$ = $((speechId: string, deltaSeconds: number) => {
    submitOp(view.activeHallId, { type: 'queue.adjustTime', speechId, deltaSeconds });
    refresh();
  });

  const saveDraft$ = $(async (values: z.infer<typeof captionSchema>) => {
    const speech = view.ledger.halls[view.activeHallId]?.queue.find((s) => s.status === 'speaking');
    if (!speech) return;
    const queryClient = new QueryClient();
    const text = await queryClient.fetchQuery({
      queryKey: ['caption-draft', speech.id, values.text],
      queryFn: async () => values.text.trim(),
      staleTime: 0
    });
    if (!text) return;
    submitOp(view.activeHallId, { type: 'caption.saveDraft', speechId: speech.id, language: '中文', text });
    reset(captionForm);
    refresh();
  });

  const confirmCaption$ = $((captionId: string) => {
    submitOp(view.activeHallId, { type: 'caption.confirm', captionId });
    refresh();
  });

  const handoff$ = $((channelId: string) => {
    submitOp(view.activeHallId, { type: 'duty.handoffStart', channelId });
    refresh();
  });

  const completeHandoff$ = $((channelId: string, language: string) => {
    submitOp(view.activeHallId, { type: 'duty.handoffComplete', channelId, interpreter: `替补译员-${language}` });
    refresh();
  });

  const rebaseMerge$ = $((mergeId: string) => {
    try {
      rebasePendingMerge(mergeId);
    } catch {
      /* 写账故障时待合并与待办都保留，稍后重试 */
    }
    refresh();
  });

  const dismissMerge$ = $((mergeId: string) => {
    try {
      dropPendingMerge(mergeId, `${view.clientId} 放弃了这条待合并，账上先到内容未变`);
    } catch {
      /* 写账故障时保留待合并 */
    }
    refresh();
  });

  const retryOne$ = $((hallId: string, opId: string) => {
    retryOp(hallId, opId);
    refresh();
  });

  const retryAll$ = $(() => {
    flushOutbox();
    refresh();
  });

  const discardOne$ = $((hallId: string, opId: string) => {
    discardOp(hallId, opId);
    refresh();
  });

  const toggleFailure$ = $(() => {
    const next = !view.simulateFailure;
    setFailure(next);
    view.simulateFailure = next;
    if (!next) flushOutbox();
    refresh();
  });

  const toggleLatency$ = $(() => {
    view.lowLatency = !view.lowLatency;
    localStorage.setItem(LOW_LATENCY_KEY, view.lowLatency ? '1' : '0');
  });

  const approveTerm$ = $((id: string) => {
    approveTerm(id);
    refresh();
  });

  return (
    <main class={`conference-shell ${view.lowLatency ? 'low-latency' : ''}`}>
      <header class="hero">
        <div>
          <span class="pill">{locale.lang}</span>
          <h1>同声传译与发言队列</h1>
          <p>{hallMeta().name} · {hallMeta().topic}</p>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <select value={view.activeHallId} onChange$={(event) => selectHall$((event.target as HTMLSelectElement).value)}>
            {HALL_DIRECTORY.map((h) => <option value={h.id} key={h.id}>{h.name}</option>)}
          </select>
          <span class="pill">版本 v{hall()?.version ?? '-'}</span>
          <span class="pill">上下文纪元 {hall()?.contextEpoch ?? '-'}</span>
          <span class="pill">本端 {view.clientId}</span>
          <button class="secondary" onClick$={toggleLatency$}>{view.lowLatency ? '退出低延迟' : '低延迟模式'}</button>
          <button class={view.simulateFailure ? 'danger' : 'secondary'} onClick$={toggleFailure$}>
            {view.simulateFailure ? '恢复存储并重试待办' : '模拟存储故障'}
          </button>
        </div>
      </header>

      <section class="grid">
        <article class="panel">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <h2>发言队列</h2>
            <span class="pill">{queue().length} 条 · {hallMeta().simultaneousChannels} 个同传频道</span>
          </div>
          {queue().map((speech, index) => (
            <div class={`queue-row ${speech.status === 'speaking' ? 'active' : ''}`} key={speech.id}>
              <strong>#{index + 1}</strong>
              <div>
                <b>{speech.speaker}</b>
                <div style="color:#638087;font-size:13px">{speech.delegation} · {speech.language} · {speech.topic}</div>
              </div>
              <span class="pill">{speech.status} · {fmtClock(speech.remainingSeconds)}</span>
              <div style="display:flex;gap:6px;flex-wrap:wrap">
                {speech.status === 'queued' && <button onClick$={() => advanceSpeech$(speech.id, 'speaking')}>开始</button>}
                {speech.status === 'speaking' && (
                  <>
                    <button onClick$={() => advanceSpeech$(speech.id, 'done')}>结束</button>
                    <button class="secondary" onClick$={() => adjustTime$(speech.id, -60)}>减1分钟</button>
                  </>
                )}
                {speech.status === 'queued' && <button class="danger" onClick$={() => advanceSpeech$(speech.id, 'skipped')}>跳过</button>}
                {speech.status === 'queued' && (
                  <>
                    <button class="secondary" disabled={index === 0} onClick$={() => reorderSpeech$(speech.id, -1)}>↑</button>
                    <button class="secondary" disabled={index === queue().length - 1} onClick$={() => reorderSpeech$(speech.id, 1)}>↓</button>
                  </>
                )}
              </div>
            </div>
          ))}
          <QueueForm onSubmit$={addSpeech$}>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:18px">
              <QueueField name="speaker">{(field, props) => <input {...props} value={field.value} onInput$={(event) => (field.value = (event.target as HTMLInputElement).value)} placeholder="发言人" />}</QueueField>
              <QueueField name="delegation">{(field, props) => <input {...props} value={field.value} onInput$={(event) => (field.value = (event.target as HTMLInputElement).value)} placeholder="代表团" />}</QueueField>
              <QueueField name="topic">{(field, props) => <input {...props} value={field.value} onInput$={(event) => (field.value = (event.target as HTMLInputElement).value)} placeholder="议题" />}</QueueField>
              <QueueField name="language">{(field, props) => (
                <select {...props} value={field.value} onChange$={(event) => (field.value = (event.target as HTMLSelectElement).value)}>
                  {['英语', '中文', '法语', '西班牙语', '葡萄牙语', '德语'].map((lang) => <option value={lang} key={lang}>{lang}</option>)}
                </select>
              )}</QueueField>
              <QueueField name="plannedSeconds" type="number">{(field, props) => <input {...props} type="number" value={field.value} onInput$={(event) => (field.value = Number((event.target as HTMLInputElement).value))} placeholder="计划秒数" />}</QueueField>
              <label style="display:flex;gap:6px;align-items:center;font-size:13px;color:#4c666d">
                <input type="checkbox" style="width:auto" checked={interrupt.value} onChange$={(event) => (interrupt.value = (event.target as HTMLInputElement).checked)} />
                临时插话（插到当前发言之后）
              </label>
            </div>
            <div style="margin-top:10px"><button type="submit">加入队列</button></div>
          </QueueForm>
        </article>

        <aside class="panel">
          <h2>频道与译员在岗</h2>
          {(hall()?.duty ?? []).map((duty) => (
            <div style="padding:12px 0;border-bottom:1px solid #e6efee" key={duty.channelId}>
              <div style="display:flex;justify-content:space-between">
                <b>{duty.language} · {duty.interpreter}</b>
                <span class="pill">{duty.status}</span>
              </div>
              <div style="color:#638087;font-size:12px;margin-top:2px">在岗自 {new Date(duty.since).toLocaleTimeString()}</div>
              <div class="decorative" style="margin:8px 0"><Progress.Root value={duty.health} max={100} /></div>
              <div style="display:flex;gap:8px">
                <button class="secondary" disabled={duty.status === 'handoff'} onClick$={() => handoff$(duty.channelId)}>开始交接</button>
                {duty.status === 'handoff' && <button onClick$={() => completeHandoff$(duty.channelId, duty.language)}>完成交接</button>}
              </div>
            </div>
          ))}

          <h3>实时字幕 · 草稿与确认</h3>
          {speaking() ? (
            <CaptionForm onSubmit$={saveDraft$}>
              <CaptionField name="text">{(field, props) => <textarea {...props} rows={3} value={field.value} onInput$={(event) => (field.value = (event.target as HTMLTextAreaElement).value)} placeholder={`为「${speaking()!.speaker}」输入字幕草稿`} />}</CaptionField>
              <div style="margin-top:8px"><button type="submit">保存草稿</button></div>
            </CaptionForm>
          ) : (
            <p>当前没有发言中的代表。</p>
          )}
          {drafts().map((caption) => (
            <div class={`caption-card ${caption.stale ? 'stale' : ''}`} key={caption.id}>
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
                <b>{caption.interpreter} · {caption.language} · 草稿 v{caption.revision}</b>
                {caption.stale && <span class="pill warn">已失效 · 已重归属</span>}
              </div>
              {caption.stale && caption.reassignedFrom && (
                <div class="mono" style="margin-top:4px">
                  原归属：{speakerName(caption.reassignedFrom.speechId)} · {caption.reassignedFrom.interpreter} · 纪元{caption.reassignedFrom.epoch}
                </div>
              )}
              <p style="margin:6px 0">{caption.text}</p>
              <button onClick$={() => confirmCaption$(caption.id)}>确认发布</button>
            </div>
          ))}
          {confirmedCaptions().map((caption) => (
            <div class="caption-card" key={caption.id}>
              <b>{caption.interpreter} · v{caption.revision} · 已确认</b>
              <p style="margin:6px 0">{caption.text}</p>
              <div class="mono">{speakerName(caption.speechId)}</div>
            </div>
          ))}
        </aside>
      </section>

      <section class="grid" style="margin-top:18px">
        <article class="panel">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <h2>待合并（后到写入）</h2>
            <span class="pill">{hallMerges().length} 条</span>
          </div>
          <p style="color:#638087;font-size:13px;margin-top:4px">依据版本落后于账上版本的写入会列在这里并附差异，先到内容不会被覆盖。</p>
          {hallMerges().length === 0 && <p>本厅没有待合并的写入。</p>}
          {hallMerges().map((merge) => (
            <div class="merge-row" key={merge.id}>
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
                <b>{OP_LABELS[merge.op.payload.type]}</b>
                <span class="pill warn">依据 v{merge.op.baseVersion} / 当前 v{hall()?.version}</span>
              </div>
              <div class="mono" style="margin-top:4px">{merge.op.actor} · {merge.op.opId} · {new Date(merge.at).toLocaleTimeString()}</div>
              <ul class="diff-list">
                {merge.diffs.map((diff, i) => (
                  <li key={i}>
                    <span>{diff.label}</span>
                    <span><small>账上当前</small><br />{diff.current}</span>
                    <span><small>本次提交</small><br />{diff.incoming}</span>
                  </li>
                ))}
              </ul>
              <div style="display:flex;gap:8px;margin-top:8px">
                <button onClick$={() => rebaseMerge$(merge.id)}>以当前版本为据重写</button>
                <button class="secondary" onClick$={() => dismissMerge$(merge.id)}>放弃</button>
              </div>
            </div>
          ))}
        </article>

        <article class="panel">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <h2>待办与重试</h2>
            <div style="display:flex;gap:8px;align-items:center">
              <span class="pill">{view.outbox.length} 条</span>
              {view.outbox.length > 0 && <button class="secondary" onClick$={retryAll$}>全部重试</button>}
            </div>
          </div>
          <p style="color:#638087;font-size:13px;margin-top:4px">写入失败的操作按「厅 + 操作编号」保留在这里，会自动重试，刷新或重开页面后继续。</p>
          {view.outbox.length === 0 && <p>没有未落账的待办。</p>}
          {view.outbox.map((entry) => (
            <div class="todo-row" key={entry.op.opId}>
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
                <b>{OP_LABELS[entry.op.payload.type]} · {hallName(entry.op.hallId)}</b>
                <span class="pill warn">已重试 ×{entry.attempts}</span>
              </div>
              <div class="mono" style="margin-top:4px">{entry.op.hallId} · {entry.op.opId}</div>
              {entry.lastError && <div style="color:#a1322c;font-size:13px;margin-top:4px">{entry.lastError}</div>}
              <div style="display:flex;gap:8px;margin-top:8px">
                <button class="secondary" onClick$={() => retryOne$(entry.op.hallId, entry.op.opId)}>重试</button>
                <button class="danger" onClick$={() => discardOne$(entry.op.hallId, entry.op.opId)}>放弃</button>
              </div>
            </div>
          ))}
        </article>
      </section>

      <section class="grid" style="margin-top:18px">
        <article class="panel">
          <h2>术语库</h2>
          {view.terms.map((term) => (
            <div class="queue-row" key={term.id}>
              <span />
              <div><b>{term.phrase}</b><div>{term.translation} · {term.language}</div></div>
              <span class="pill">{term.approved ? '已批准' : '待审'}</span>
              <button disabled={term.approved} onClick$={() => approveTerm$(term.id)}>批准</button>
            </div>
          ))}
        </article>
        <article class="panel">
          <h2>操作与交接时间线</h2>
          {hallEvents().map((event) => (
            <div style="padding:10px 0;border-bottom:1px solid #e6efee" key={event.id}>
              <small>{new Date(event.at).toLocaleTimeString()}</small>
              <div>{event.message}</div>
            </div>
          ))}
        </article>
      </section>
    </main>
  );
});

export const head: DocumentHead = {
  title: '国际会议同声传译控制台',
  meta: [{ name: 'description', content: '发言队列、多语种频道、术语、译员交接与实时字幕修正原型' }]
};
