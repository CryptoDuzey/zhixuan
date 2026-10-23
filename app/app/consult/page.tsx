'use client';

import { useEffect, useRef, useState } from 'react';
import type { Recommendation } from '../../lib/consult.ts';
import ModelSettings from '../components/ModelSettings';
import AnswerText from '../components/AnswerText';
import ModelPreview, { useModelPreview } from '../components/ModelPreview';
import ConsultProductShowcase from '../components/ConsultProductShowcase';
import ChatHistory from '../components/ChatHistory';
import { conversationId, pinConversation } from '../components/conversation-location.ts';
import {
  browserStorage, CONSULT_MAX_TURNS, CONSULT_SESSION_KEY, CONSULT_ID_KEY, decodeConsultSession,
  parseConsultAnswer, parseConsultSnapshot, consultRunText, newStudioId, validStudioId,
  readStorage, SessionEpoch, writeStorage, type ConsultTurn,
} from '../components/frontend-session.ts';
import { consumeAgentStream, parseAgentRun, type AgentRun } from '../../lib/agent-stream.ts';
import './consult.css';
import { HANDOFF_PLATFORMS, handoffStorage, saveHandoff, handoffMessage, type CreativeHandoff, type HandoffPlatform } from '../components/frontend-handoff.ts';

export default function ConsultPage() {
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState<ConsultTurn[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [sessionNote, setSessionNote] = useState('');
  const [storageNote, setStorageNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Recommendation | null>(null);
  const [settings, setSettings] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffQuestions, setHandoffQuestions] = useState<string[]>([]);
  const [included, setIncluded] = useState<number[]>([]);
  const [handoffTask, setHandoffTask] = useState('');
  const [audience, setAudience] = useState('');
  const [constraints, setConstraints] = useState('');
  const [platform, setPlatform] = useState<HandoffPlatform | ''>('');
  const [handoffError, setHandoffError] = useState('');
  const [fallbackText, setFallbackText] = useState('');
  const [modelProgress, setModelProgress] = useState<{ callId: string; characters: number; mode: string } | null>(null);
  const { preview, resetPreview, clearPreview, receivePreviewEvent } = useModelPreview();
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
  function choose(rec: Recommendation, index: number) {
    if (selected === rec) { setSelected(null); setHandoffOpen(false); return; }
    setSelected(rec);
    const questions = turns.slice(0, index + 1).map((turn) => turn.question);
    setHandoffQuestions(questions);
    setIncluded([index]);
    setHandoffTask(questions[index] || '');
    setAudience('');
    setConstraints('');
    setHandoffError('');
    setFallbackText('');
    setHandoffOpen(false);
  }
  function beginCreation() {
    if (!selected?.creativeModelId || !handoffTask.trim() || !platform) return;
    const value: CreativeHandoff = { version: 1, token: newStudioId(), createdAt: Date.now(),
      productId: selected.creativeModelId, task: handoffTask.trim(), audience: audience.trim(),
      constraints: constraints.trim(), platform };
    if (!saveHandoff(handoffStorage(), value)) {
      setHandoffError('浏览器未能暂存需求，尚未跳转。可重试，或复制下方需求，再进入创作粘贴发送。');
      setFallbackText(`本轮产品选择：${selected.modelName || selected.modelId}。\n${handoffMessage(value)}`);
      return;
    }
    window.location.assign(`/?handoff=${encodeURIComponent(value.token)}`);
  }

  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    end.current?.scrollIntoView({ behavior: reducedMotion ? 'instant' : 'smooth', block: 'end' });
  }, [turns, busy, error]);
  useEffect(() => {
    if (!handoffOpen) return;
    const previous = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    return () => { document.documentElement.style.overflow = previous; };
  }, [handoffOpen]);
  useEffect(() => {
    const storedId = readStorage(browserStorage(), CONSULT_ID_KEY);
    const initialId = conversationId(window.location.search, storedId.value);
    if (initialId) {
      sid.current = initialId;
      saveId();
      void recover();
    } else {
      sid.current = newStudioId();
      const saved = readStorage(browserStorage(), CONSULT_SESSION_KEY);
      const decoded = decodeConsultSession(new URLSearchParams(window.location.search).has('chat') ? null : saved.value);
      saveTurns(decoded.turns);
      setLegacy(decoded.turns.length > 0);
      if (!saved.available) setStorageNote('浏览器未允许保存记录，刷新后可能无法找回本次咨询。');
      if (decoded.invalid) setSessionNote('此前记录无法读取，已开启新咨询。');
      else if (decoded.turns.length) setSessionNote('这是此前保存在浏览器的记录，仅供查看。开启新咨询后，旧对话不会带入。刷新不会重复发送。');
      setHydrated(true);
      if (!decoded.turns.length) saveId();
    }
    return () => { clearTimeout(timer.current); requests.current.cancel(); };
  }, []);

  function saveTurns(next: ConsultTurn[]) {
    const bounded = next.slice(-CONSULT_MAX_TURNS);
    turnsRef.current = bounded;
    setTurns(bounded);
  }
  function saveId() {
    const saved = writeStorage(browserStorage(), CONSULT_ID_KEY, sid.current);
    const pinned = pinConversation(sid.current, window.location, window.history);
    if (!pinned) {
      setStorageNote(saved ? '本页对话位置未能保存，刷新后可能打开最近使用的其他咨询。' : '浏览器未允许保存记录，刷新后可能无法找回本次咨询。');
    } else {
      setStorageNote('');
    }
  }
  async function recover() {
    clearPreview();
    setModelProgress(null);
    clearTimeout(timer.current);
    const task = requests.current.start();
    pending.current = true;
    setRecovering(true);
    setRecoveryError('');
    setSelected(null);
    setHandoffOpen(false);
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
    resetPreview();
    pending.current = true;
    saveId();
    setBusy(true);
    setModelProgress(null);
    setRun(undefined);
    setTools([]);
    setStopping(false);
    cancelPending.current = false;
    setError('');
    setRecoveryError('');
    setSessionNote('');
    setSelected(null);
    setHandoffOpen(false);
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
        if (!receivePreviewEvent(event)) return;
        if (!cancelPending.current && event.type === 'model_progress' && typeof event.callId === 'string' && event.callId.length <= 200
          && Number.isSafeInteger(event.characters) && (event.characters as number) >= 0
          && (event.mode === 'stream' || event.mode === 'buffered')) {
          setModelProgress({ callId: event.callId, characters: event.characters as number, mode: event.mode });
        }
        if (['model_preview', 'answer', 'error', 'done'].includes(event.type)) setModelProgress(null);
        const state = parseAgentRun(event.run);
        if (state) {
          setRun(state);
          if (state.status !== 'running' || state.cancelRequested) setModelProgress(null);
        }
        if (event.type === 'step' && typeof event.label === 'string') {
          setModelProgress(null);
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
    clearPreview();
    setModelProgress(null);
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
    clearPreview();
    generation.current++;
    sid.current = newStudioId();
    saveId();
    pending.current = false;
    cancelPending.current = false;
    setBusy(false);
    setModelProgress(null);
    setStopping(false);
    setRecovering(false);
    setRecoveryError('');
    setLegacy(false);
    setRun(undefined);
    setTools([]);
    saveTurns([]);
    setSelected(null);
    setHandoffOpen(false);
    setPlatform('');
    setError('');
    setInput('');
    setSessionNote('');
    writeStorage(browserStorage(), CONSULT_SESSION_KEY, null);
    field.current?.focus();
  }

  function openConsult(id: string) {
    if (!validStudioId(id) || id === sid.current || busy || recovering || !hydrated) return;
    clearTimeout(timer.current);
    requests.current.cancel();
    clearPreview();
    generation.current++;
    cancelPending.current = false;
    pending.current = false;
    sid.current = id;
    saveId();
    saveTurns([]);
    setInput('');
    setError('');
    setSessionNote('');
    setRecoveryError('');
    setLegacy(false);
    setRun(undefined);
    setStopping(false);
    setTools([]);
    setModelProgress(null);
    setSelected(null);
    setHandoffOpen(false);
    setHandoffQuestions([]);
    setIncluded([]);
    setHandoffTask('');
    setAudience('');
    setConstraints('');
    setPlatform('');
    setHandoffError('');
    setFallbackText('');
    void recover();
  }

  const blocked = busy || !hydrated || recovering || !!recoveryError || legacy;
  const lastFailed = !!error && turns.length > 0 && !turns.at(-1)?.answer;
  const composer = (
    <form className="composer consult-composer" onSubmit={(event) => {
      event.preventDefault();
      send(input, lastFailed && input.trim() === turns.at(-1)!.question);
    }}>
      <label className="sr" htmlFor="consult-input">和知选聊聊选购</label>
      <textarea id="consult-input" ref={field} value={input} maxLength={2000} rows={2}
        placeholder={turns.length ? '还有什么想了解的？' : '想买什么？或说说你最近的打算…'}
        disabled={blocked} onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            send(input, lastFailed && input.trim() === turns.at(-1)!.question);
          }
        }} />
      <div className="composer-row"><span>{input.length ? `${input.length} / 2000` : '知选 · 选购'}</span>
        <button className="send" type="submit" disabled={blocked || !input.trim()} aria-label={busy ? '正在咨询' : '发送咨询'}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>
    </form>
  );
  return (
    <div className="consult-shell">
      <a className="consult-skip" href="#consult-content">跳到选购聊天</a>
      <header className="top consult-top">
        <div className="consult-identity">
          <ChatHistory kind="consult" activeId={sid.current} disabled={busy || recovering || !hydrated} onSelect={openConsult} onNew={reset} />
          <a className="brand consult-brand" href="/consult"><span className="mark" aria-hidden="true">知</span><span>知选<span className="consult-brand-kind">选购</span></span></a>
        </div>
        <nav className="seg" aria-label="工作端切换">
          <a href="/">创作</a>
          <a href="/consult" className="on" aria-current="page">选购</a>
        </nav>
        <div className="top-right">
          <button type="button" className="settings-trigger" disabled={busy} onClick={() => setSettings(true)} aria-label="模型设置">设置</button>
        </div>
      </header>
      {settings && <ModelSettings onClose={() => setSettings(false)} />}
      <main id="consult-content" tabIndex={-1} className={`consult-main${turns.length ? ' consult-started' : ' consult-empty'}`}>
        <div className="session-status" aria-live="polite">
          {!hydrated || recovering ? <p role="status">正在恢复咨询记录…</p> : null}
          {recoveryError ? <p className="consult-error" role="alert">{recoveryError}<button onClick={() => { void recover(); }}>重试恢复</button></p> : null}
          {legacy ? <button className="consult-start-new" onClick={reset}>开启新咨询</button> : null}
          {sessionNote ? <p role="status">{sessionNote}</p> : null}
          {storageNote ? <p>{storageNote}</p> : null}
        </div>
        {!turns.length ? (
          <section className="consult-welcome" aria-labelledby="consult-title">
            <span className="consult-eyebrow">知选 · 选购</span>
            <h1 id="consult-title">想选什么？</h1>
            <ConsultProductShowcase disabled={blocked} onChoose={text => { setInput(text); field.current?.focus(); }}>{composer}</ConsultProductShowcase>
          </section>
        ) : (
          <section className="consult-log" aria-label="咨询记录" aria-busy={busy}>
            {turns.map((turn, index) => (
              <div className="consult-turn" key={index}>
                <div className="consult-user">{turn.question}</div>
                {turn.answer && (
                  <article className="consult-answer">
                    <div className="consult-speaker"><span className="mark" aria-hidden="true">知</span><span>选购顾问</span></div>
                    <div className="consult-reply"><AnswerText text={turn.answer.reply} /></div>
                    {!!turn.answer.questions?.length && (
                      <div className="consult-questions"><span>还想了解</span><ul>{turn.answer.questions.map((q, i) => <li key={i}>{q}</li>)}</ul></div>
                    )}
                    {!!turn.answer.recommendations.length && (
                      <div className="consult-cards" aria-label="可以考虑的方案">
                        {turn.answer.recommendations.map((rec) => {
                          const evidence = turn.answer!.evidence.filter((e) => rec.evidenceIds.includes(e.id));
                          const active = selected === rec;
                          return (
                            <article className={`consult-card${active ? ' is-selected' : ''}`} key={rec.modelId}>
                              <button className="consult-select" type="button" disabled={busy || recovering} aria-pressed={active} onClick={() => choose(rec, index)}>
                                <span><span className="consult-system">{rec.system}</span><strong>{rec.modelName || rec.modelId}</strong></span>
                                <span className="consult-check" aria-hidden="true">{active ? '✓' : '+'}</span>
                              </button>
                              <p>{rec.reason}</p>
                              <p className="consult-tradeoff"><span>需要权衡</span>{rec.tradeoff}</p>
                              <details className="consult-evidence">
                                <summary>产品资料</summary>
                                {evidence.map((e) => (
                                  <blockquote key={e.id}>
                                    <p>{e.text}</p>
                                    <cite>{e.docTitle}</cite>
                                    {/^[a-f0-9]{24}$/.test(e.docId) ? <a href={`/api/knowledge/document?id=${e.docId}`} target="_blank" rel="noopener noreferrer">查看完整资料</a> : null}
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
              <span>{stopping ? '正在停止咨询，请等待确认' : '想一想，马上回复你…'}</span>
              {run?.status === 'running' && <button type="button" disabled={stopping} onClick={stop}>{stopping ? '等待确认' : '停止咨询'}</button>}
            </div>}
            {busy && <ModelPreview preview={preview} />}
            {error && <div className="consult-error" role="alert"><span>{error}</span>{lastFailed && !legacy && <button type="button" disabled={blocked} onClick={() => send(turns.at(-1)!.question, true)}>重试这条</button>}</div>}
            <div ref={end} />
          </section>
        )}
        {!!turns.length && <div className="consult-bottom">
          {selected && <div className="consult-handoff"><span>已选 · {selected.modelName}</span>{selected.creativeModelId
            ? <button type="button" onClick={() => setHandoffOpen(true)}>确认创作需求 ↗</button>
            : <span>可继续咨询 · 图文素材尚未接通</span>}</div>}
          {composer}
        </div>}
        <p className="consult-note">具体配置、价格与软件支持，以所选版本及实际购买页面为准。</p>
      </main>
      {handoffOpen && selected && <div className="handoff-backdrop" onClick={() => setHandoffOpen(false)}>
        <section className="handoff-dialog" role="dialog" aria-modal="true" aria-labelledby="handoff-title" onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setHandoffOpen(false);
            if (event.key === 'Tab') {
              const items = event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input, textarea, select, a[href]');
              const first = items[0], last = items[items.length - 1];
              if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
              else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }
          }}>
          <div className="handoff-head"><h2 id="handoff-title">把需求交给创作</h2><button autoFocus type="button" onClick={() => setHandoffOpen(false)}>返回咨询</button></div>
          <p>已选 {selected.modelName}。将开启独立创作，发送前仍可修改。</p>
          <fieldset><legend>带入哪些用户提问</legend><p>默认只带入该推荐对应的提问；可勾选相关的前文。勾选后会重新填入任务，请再编辑确认。</p>
            {handoffQuestions.map((question, index) => <label className="handoff-question" key={index}><input type="checkbox" checked={included.includes(index)}
              onChange={(event) => {
                const next = event.target.checked ? [...included, index].sort((a, b) => a - b) : included.filter((item) => item !== index);
                setIncluded(next); setHandoffTask(next.map((item) => handoffQuestions[item]).join('\n\n'));
              }} /><span>{question}</span></label>)}
          </fieldset>
          <label className="handoff-field">任务与使用需求 <span>{handoffTask.length} / 24000</span><textarea rows={5} maxLength={24000} value={handoffTask} onChange={(event) => setHandoffTask(event.target.value)} /></label>
          <label className="handoff-field">目标受众<textarea rows={2} maxLength={1000} placeholder="例如：经常出差的职场新人" value={audience} onChange={(event) => setAudience(event.target.value)} /></label>
          <label className="handoff-field">硬约束<textarea rows={2} maxLength={2000} placeholder="例如：预算上限、必需软件、不能夸大的结论" value={constraints} onChange={(event) => setConstraints(event.target.value)} /></label>
          <label className="handoff-field">发布平台<select value={platform} onChange={(event) => setPlatform(event.target.value as HandoffPlatform | '')}><option value="">请选择发布平台</option>{HANDOFF_PLATFORMS.map((item) => <option key={item}>{item}</option>)}</select></label>
          <p className="handoff-privacy">仅交接上方确认的需求和产品选择，不带入助手回复。需求不写入网址，暂存 30 分钟，打开创作后即清除。</p>
          {handoffError && <div role="alert"><p>{handoffError}</p><label className="handoff-field">可复制的创作需求<textarea readOnly rows={5} value={fallbackText} onFocus={(event) => event.target.select()} /></label><a href={`/?product=${encodeURIComponent(selected.creativeModelId || '')}`}>进入创作，手动粘贴需求 ↗</a></div>}
          <button className="handoff-confirm" type="button" disabled={!handoffTask.trim() || !platform} onClick={beginCreation}>确认并开启独立创作</button>
        </section>
      </div>}
    </div>
  );
}
