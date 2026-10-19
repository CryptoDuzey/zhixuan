'use client';

import { useEffect, useRef, useState } from 'react';
import type { Recommendation } from '../../lib/consult.ts';
import type { RetrievalSummary } from '../../lib/retrieval.ts';
import {
  browserStorage, CONSULT_MAX_TURNS, CONSULT_SESSION_KEY, CONSULT_ID_KEY, decodeConsultSession,
  parseConsultAnswer, parseConsultSnapshot, consultRunText, newStudioId, validStudioId,
  readStorage, SessionEpoch, writeStorage, type ConsultTurn,
} from '../components/frontend-session.ts';
import { consumeAgentStream, parseAgentRun, type AgentRun } from '../../lib/agent-stream.ts';
import './consult.css';

const STARTERS = [
  '知识库里有哪些产品？按类别给我看看完整目录',
  '大学学习，预算 6000 左右，主要用 Office，怎么选？',
  '经常出差，要开会和做文档，想先了解选购思路',
  '需要用 CAD 和专业插件，选电脑前该核实什么？',
];

function KnowledgeRetrieval({ retrieval }: { retrieval: RetrievalSummary }) {
  const ready = retrieval.status === 'ready';
  return (
    <details className="consult-evidence consult-retrieval">
      <summary>知识库检索<span className="consult-retrieval-state">{ready ? `${retrieval.returned} 条结果` : '暂不可用'}</span></summary>
      <div className="consult-retrieval-meta">
        <p>来源：{retrieval.source}{!ready ? '（暂不可用）' : ''}</p>
        <p>搜索范围：全部已索引文档{retrieval.scannedFiles !== undefined ? ` · 扫描 ${retrieval.scannedFiles} 份文件` : ''}</p>
        {retrieval.query && <p>检索词：{retrieval.query}</p>}
        <p>{ready ? `返回 ${retrieval.returned} 条 · 最多 ${retrieval.maximumResults} 条` : '本次未获得可用检索结果'} · 非穷尽结果，不代表知识库完整目录</p>
      </div>
      <p className={`consult-retrieval-message${ready ? '' : ' is-unavailable'}`}>{retrieval.message}</p>
      {ready && retrieval.items.length === 0 && <p className="consult-retrieval-message">没有找到匹配资料，可换个关键词继续问。</p>}
      {ready && retrieval.items.length > 0 && (
        <ol className="consult-retrieval-items">
          {retrieval.items.map((item, index) => (
            <li key={`${item.id}-${index}`}>
              <a href={item.documentUrl} target="_blank" rel="noopener noreferrer" aria-label={`查看原文：${item.title}`}>{item.title}<span aria-hidden="true"> ↗</span></a>
              <p>{item.preview || '暂无摘要，可打开原文查看。'}</p>
              <span className="consult-retrieval-path">{item.path}</span>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

export default function ConsultPage() {
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState<ConsultTurn[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [sessionNote, setSessionNote] = useState('');
  const [storageNote, setStorageNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Recommendation | null>(null);
  const pending = useRef(false);
  const requests = useRef(new SessionEpoch());
  const sid = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const turnsRef = useRef<ConsultTurn[]>([]);
  const generation = useRef(0);
  const cancelPending = useRef(false);
  const [legacy, setLegacy] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [recoveryError, setRecoveryError] = useState('');
  const [run, setRun] = useState<AgentRun | undefined>();
  const [stopping, setStopping] = useState(false);
  const [tools, setTools] = useState<{ tool: string; label: string; status: string; cacheHit?: boolean }[]>([]);
  const end = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const scene = turns.map((t) => t.question).join('；').slice(-160);

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns, busy, error]);
  useEffect(() => {
    const storedId = readStorage(browserStorage(), CONSULT_ID_KEY);
    if (validStudioId(storedId.value)) {
      sid.current = storedId.value;
      void recover();
    } else {
      sid.current = newStudioId();
      const saved = readStorage(browserStorage(), CONSULT_SESSION_KEY);
      const decoded = decodeConsultSession(saved.value);
      saveTurns(decoded.turns);
      setLegacy(decoded.turns.length > 0);
      if (!saved.available) setStorageNote('浏览器未允许保存记录，刷新后可能无法找回本次咨询。');
      if (decoded.invalid) setSessionNote('此前记录无法读取，已开启新咨询。');
      else if (decoded.turns.length) setSessionNote('这是此前保存在浏览器的记录，仅供查看。开启新咨询后，旧对话不会带入。刷新不会重复发送。');
      setHydrated(true);
    }
    return () => { clearTimeout(timer.current); requests.current.cancel(); };
  }, []);

  function saveTurns(next: ConsultTurn[]) {
    const bounded = next.slice(-CONSULT_MAX_TURNS);
    turnsRef.current = bounded;
    setTurns(bounded);
  }
  function saveId() {
    if (!writeStorage(browserStorage(), CONSULT_ID_KEY, sid.current)) {
      setStorageNote('浏览器未允许保存记录，刷新后可能无法找回本次咨询。');
    }
  }
  async function recover() {
    clearTimeout(timer.current);
    const task = requests.current.start();
    pending.current = true;
    setRecovering(true);
    setRecoveryError('');
    setSelected(null);
    async function poll() {
      try {
        const response = await fetch(`/api/consult?sessionId=${encodeURIComponent(sid.current)}`, {
          cache: 'no-store', signal: AbortSignal.any([task.signal, AbortSignal.timeout(20000)]),
        });
        if (!task.current()) return;
        if (response.status === 404) {
          saveTurns([]);
          setRun(undefined);
          setError('');
          setSessionNote('尚未建立咨询记录，可以发送问题开始。');
          pending.current = false;
          setBusy(false);
          setRecovering(false);
          setStopping(false);
          cancelPending.current = false;
          setHydrated(true);
          return;
        }
        if (!response.ok) throw new Error(`暂时无法恢复咨询（${response.status}），请重试恢复。`);
        const snapshot = parseConsultSnapshot(await response.json());
        if (!task.current()) return;
        saveTurns(snapshot.turns);
        setRun(snapshot.run);
        setBusy(snapshot.busy);
        setHydrated(true);
        const awaitingStop = snapshot.busy && (cancelPending.current || !!snapshot.run?.cancelRequested);
        setStopping(awaitingStop);
        cancelPending.current = awaitingStop;
        setError(snapshot.error || '');
        if (snapshot.busy) {
          setSessionNote('正在恢复咨询，服务端仍在处理；不会重复发送。');
          timer.current = setTimeout(() => { void poll(); }, 1500);
        } else {
          pending.current = false;
          setRecovering(false);
          setSessionNote(snapshot.run ? consultRunText(snapshot.run) : snapshot.interrupted
            ? '上次咨询已中断，已恢复记录；可重新发送问题。' : '已恢复最近的咨询和推荐，可继续追问或选择产品开启新创作。');
          if (!snapshot.error && snapshot.turns.at(-1) && !snapshot.turns.at(-1)?.answer) {
            setError('上条咨询尚未收到完整回复。刷新不会重复发送，你可以重试这条。');
            setInput(snapshot.turns.at(-1)!.question);
          }
        }
      } catch (cause) {
        if (!task.current()) return;
        setRecoveryError(cause instanceof Error ? cause.message : '恢复咨询失败，请重试恢复。');
        setBusy(false);
        setRecovering(false);
        setHydrated(true);
        // Keep pending true: an unknown server state must not permit duplicate generation.
      }
    }
    await poll();
  }

  async function send(value = input, retry = false) {
    const question = value.trim();
    if (!hydrated || legacy || !question || pending.current) return;
    if (question.length > 2000) { setError('每条问题最多 2000 字，请精简后发送。'); return; }
    clearTimeout(timer.current);
    const task = requests.current.start();
    generation.current++;
    pending.current = true;
    saveId();
    setBusy(true);
    setRun(undefined);
    setTools([]);
    setStopping(false);
    cancelPending.current = false;
    setError('');
    setRecoveryError('');
    setSessionNote('');
    setSelected(null);
    setInput('');
    if (!retry) saveTurns([...turnsRef.current, { question }]);
    let streamError = '';
    try {
      const response = await fetch('/api/consult', {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ sessionId: sid.current, message: question }), signal: task.signal,
      });
      if (!task.current()) return;
      if (response.status === 409) { void recover(); return; }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        if (!task.current()) return;
        if (response.status >= 500) { setError(data.error || '咨询暂时不可用'); void recover(); return; }
        setError(typeof data.error === 'string' ? data.error : `咨询请求未被接受（${response.status}）`);
        setInput(question);
        pending.current = false;
        setBusy(false);
        return;
      }
      if ((response.headers.get('content-type') ?? '').includes('application/json')) {
        const answer = parseConsultAnswer(await response.json());
        if (!task.current()) return;
        if (!answer) throw new Error('回复不完整');
        saveTurns(turnsRef.current.map((turn, i, all) => i === all.length - 1 ? { ...turn, answer } : turn));
        pending.current = false;
        setBusy(false);
        return;
      }
      await consumeAgentStream(response, (event) => {
        if (!task.current()) return;
        const state = parseAgentRun(event.run);
        if (state) setRun(state);
        if (event.type === 'step' && typeof event.label === 'string') {
          setRun((previous) => previous ? { ...previous, phase: event.label as string } : previous);
        }
        if (event.type === 'tool' && ['model', 'knowledge'].includes(String(event.tool))
          && ['started', 'completed', 'failed'].includes(String(event.status)) && typeof event.label === 'string') {
          const entry = { tool: event.tool as string, label: event.label.slice(0, 2000), status: event.status as string,
            cacheHit: event.cacheHit === true };
          setTools((items) => {
            const index = items.findLastIndex((item) => item.tool === entry.tool && item.label === entry.label && item.status === 'started');
            return (index < 0 || entry.status === 'started' ? [...items, entry] : items.map((item, i) => i === index ? entry : item)).slice(-16);
          });
        }
        if (event.type === 'answer') {
          const answer = parseConsultAnswer(event.answer);
          if (!answer) throw new Error('回复不完整');
          saveTurns(turnsRef.current.map((turn, i, all) => i === all.length - 1 ? { ...turn, answer } : turn));
        }
        if (event.type === 'error' && typeof event.text === 'string') { streamError = event.text; setError(event.text); }
      });
      if (!task.current()) return;
      // Even done is followed by an authoritative GET, without resending generation.
      void recover();
    } catch {
      if (!task.current()) return;
      setSessionNote('连接已中断，正在确认咨询状态；不会重复发送。');
      if (streamError) setError(streamError);
      void recover();
    }
  }

  async function stop() {
    if (!run || run.status !== 'running' || cancelPending.current) return;
    const stoppedId = sid.current;
    const stoppedGeneration = generation.current;
    cancelPending.current = true;
    setStopping(true);
    try {
      const response = await fetch('/api/consult/cancel', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: stoppedId, runId: run.id }), signal: AbortSignal.timeout(20000),
      });
      if (sid.current !== stoppedId || generation.current !== stoppedGeneration) return;
      if (response.status !== 202 && response.status !== 409) setError('停止请求未能确认，正在查询咨询状态。');
    } catch {
      if (sid.current !== stoppedId || generation.current !== stoppedGeneration) return;
      setError('停止请求未能确认，正在查询咨询状态。');
    }
    if (sid.current === stoppedId && generation.current === stoppedGeneration) void recover();
  }

  function reset() {
    clearTimeout(timer.current);
    requests.current.cancel();
    generation.current++;
    sid.current = newStudioId();
    saveId();
    pending.current = false;
    cancelPending.current = false;
    setBusy(false);
    setStopping(false);
    setRecovering(false);
    setRecoveryError('');
    setLegacy(false);
    setRun(undefined);
    setTools([]);
    saveTurns([]);
    setSelected(null);
    setError('');
    setInput('');
    setSessionNote('已开启新咨询，说说这次的用途和预算。');
    writeStorage(browserStorage(), CONSULT_SESSION_KEY, null);
    field.current?.focus();
  }

  const blocked = busy || !hydrated || recovering || !!recoveryError || legacy;
  const lastFailed = !!error && turns.length > 0 && !turns.at(-1)?.answer;
  return (
    <div className="consult-shell">
      <header className="top consult-top">
        <a className="brand consult-brand" href="/"><span className="mark">知</span>知选</a>
        <nav className="seg" aria-label="工作端切换">
          <a href="/">创作</a>
          <a href="/consult" className="on" aria-current="page">选购</a>
        </nav>
        <div className="top-right">
          <button type="button" onClick={reset} disabled={!hydrated}>新咨询</button>
        </div>
      </header>
      <main className={`consult-main${turns.length ? ' consult-started' : ''}`}>
        <div className="session-status" aria-live="polite">
          {!hydrated || recovering ? <p role="status">正在恢复咨询记录…</p> : null}
          {recoveryError ? <p className="consult-error" role="alert">{recoveryError}<button onClick={() => { void recover(); }}>重试恢复</button></p> : null}
          {legacy ? <button className="consult-start-new" onClick={reset}>开启新咨询</button> : null}
          {sessionNote ? <p role="status">{sessionNote}</p> : null}
          {storageNote ? <p>{storageNote}</p> : null}
        </div>
        {!turns.length ? (
          <section className="consult-welcome" aria-labelledby="consult-title">
            <span className="consult-eyebrow">从你的日常出发</span>
            <h1 id="consult-title">先聊需求，再选产品。</h1>
            <p>电脑、显示器、打印机或配件，从实际用途说起。<br />把事情说清楚，我们一起找到合适的方案。</p>
            <div className="consult-prompts" aria-label="试着从这里开始">
              {STARTERS.map((starter) => <button type="button" key={starter} onClick={() => { setInput(starter); field.current?.focus(); }}>{starter}<span aria-hidden="true">↗</span></button>)}
            </div>
          </section>
        ) : (
          <section className="consult-log" aria-label="咨询记录" aria-busy={busy}>
            {turns.map((turn, index) => (
              <div className="consult-turn" key={index}>
                <div className="consult-user">{turn.question}</div>
                {turn.answer && (
                  <article className="consult-answer">
                    <div className="consult-speaker"><span className="mark" aria-hidden="true">知</span><span>选购顾问</span></div>
                    <div className="consult-reply">{turn.answer.reply}</div>
                    {turn.answer.retrieval && <KnowledgeRetrieval retrieval={turn.answer.retrieval} />}
                    {!!turn.answer.questions?.length && (
                      <div className="consult-questions"><span>还想了解</span><ul>{turn.answer.questions.map((q, i) => <li key={i}>{q}</li>)}</ul></div>
                    )}
                    {!!turn.answer.recommendations.length && (
                      <div className="consult-cards" aria-label="有依据的候选方案">
                        {turn.answer.recommendations.map((rec) => {
                          const evidence = turn.answer!.evidence.filter((e) => rec.evidenceIds.includes(e.id));
                          const active = selected === rec;
                          return (
                            <article className={`consult-card${active ? ' is-selected' : ''}`} key={rec.modelId}>
                              <button className="consult-select" type="button" aria-pressed={active} onClick={() => setSelected(active ? null : rec)}>
                                <span><span className="consult-system">{rec.system}</span><strong>{rec.modelName || rec.modelId}</strong></span>
                                <span className="consult-check" aria-hidden="true">{active ? '✓' : '+'}</span>
                              </button>
                              <p>{rec.reason}</p>
                              <p className="consult-tradeoff"><span>需要权衡</span>{rec.tradeoff}</p>
                              <details className="consult-evidence">
                                <summary>查看 {evidence.length} 条依据</summary>
                                {evidence.map((e) => (
                                  <blockquote key={e.id}>
                                    <p>{e.text}</p>
                                    <cite>{e.id} · {e.source}<br />{e.docPath} · 第 {e.line} 行<br />读取：{e.readAt || '未记录时间'}</cite>
                                  </blockquote>
                                ))}
                              </details>
                            </article>
                          );
                        })}
                      </div>
                    )}
                    {turn.answer.evidence.some((e) => e.kind === 'price') && (
                      <details className="consult-evidence consult-price-evidence">
                        <summary>查看历史价格来源</summary>
                        {turn.answer.evidence.filter((e) => e.kind === 'price').map((e) => <blockquote key={e.id}><p>{e.text}</p><cite>{e.source} · {e.docPath} · 第 {e.line} 行<br />读取：{e.readAt || '未记录时间'}</cite></blockquote>)}
                      </details>
                    )}
                  </article>
                )}
              </div>
            ))}
            {busy && <div className="consult-progress" role="status" aria-live="polite">
              <span>{stopping ? '正在停止咨询，请等待确认' : run ? consultRunText(run) : '正在核对资料，整理适合你的方案…'}</span>
              {run?.status === 'running' && <button type="button" disabled={stopping} onClick={stop}>{stopping ? '等待确认' : '停止咨询'}</button>}
            </div>}
            {tools.length > 0 && <ul className="consult-tools">{tools.map((tool, i) => <li key={i}>
              <span>{tool.tool === 'model' ? '模型' : '资料'} · {tool.label}</span>
              <span>{tool.status === 'started' ? busy ? '进行中' : '结果未确认' : tool.status === 'failed' ? '调用失败' : '已返回'}{tool.status === 'completed' && tool.cacheHit ? ' · 使用缓存' : ''}</span>
            </li>)}</ul>}
            {error && <div className="consult-error" role="alert"><span>{error}</span>{lastFailed && !legacy && <button type="button" disabled={blocked} onClick={() => send(turns.at(-1)!.question, true)}>重试这条</button>}</div>}
            <div ref={end} />
          </section>
        )}
        <div className="consult-bottom">
          {selected && <div className="consult-handoff"><span>已选 · {selected.modelName}</span>{selected.creativeModelId
            ? <a href={`/?${new URLSearchParams({ product: selected.creativeModelId, scene })}`}>开启新创作 <span aria-hidden="true">↗</span></a>
            : <span>可继续咨询 · 图文素材尚未接通</span>}</div>}
          <form className="composer consult-composer" onSubmit={(event) => {
            event.preventDefault();
            send(input, lastFailed && input.trim() === turns.at(-1)!.question);
          }}>
            <label className="sr" htmlFor="consult-input">你的任务、预算和关键软件</label>
            <textarea id="consult-input" ref={field} value={input} maxLength={2000} rows={2}
              placeholder={turns.length ? '补充你的需求，或继续追问…' : '例如：经常出差做方案，预算 7000，必须用 Office 和 Teams…'}
              disabled={blocked} onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  send(input, lastFailed && input.trim() === turns.at(-1)!.question);
                }
              }} />
            <div className="composer-row"><span>{input.length ? `${input.length} / 2000` : '用途 · 预算 · 软件与版本'}</span><button className="send" type="submit" disabled={blocked || !input.trim()} aria-label={busy ? '正在咨询' : '发送咨询'}>↑</button></div>
          </form>
          <p className="consult-note">保留最近 12 轮咨询 · 选定产品后开启独立创作<br />依据本地资料提供建议 · 软件兼容需核实 · 价格均为历史快照</p>
        </div>
      </main>
    </div>
  );
}
