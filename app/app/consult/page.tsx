'use client';

import { useEffect, useRef, useState } from 'react';
import type { ConsultAnswer, ConsultMessage, Recommendation } from '../../lib/consult.ts';
import './consult.css';

type Turn = { question: string; answer?: ConsultAnswer };
const STARTERS = [
  '大学学习，预算 6000 左右，主要用 Office，怎么选？',
  '经常出差，要开会和做文档，想先了解选购思路',
  '需要用 CAD 和专业插件，选电脑前该核实什么？',
];

export default function ConsultPage() {
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Recommendation | null>(null);
  const history = useRef<ConsultMessage[]>([]);
  const pending = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const scene = turns.map((t) => t.question).join('；').slice(-160);

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns, busy, error]);
  useEffect(() => () => controller.current?.abort(), []);

  async function send(value = input, retry = false) {
    const question = value.trim();
    if (!question || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setSelected(null);
    setInput('');
    if (!retry) setTurns((previous) => [...previous, { question }]);
    const next: ConsultMessage[] = [...history.current, { role: 'user', content: question }];
    controller.current = new AbortController();
    const timeout = setTimeout(() => controller.current?.abort(), 180000);
    try {
      const response = await fetch('/api/consult', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: next.slice(-24) }), signal: controller.current.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '咨询暂时没有完成，请重试。');
      if (typeof data.reply !== 'string' || !Array.isArray(data.recommendations) || !Array.isArray(data.evidence)) {
        throw new Error('回复不完整，请重新发送。');
      }
      const answer = data as ConsultAnswer;
      history.current = [...next, { role: 'assistant' as const, content: answer.reply.slice(0, 2000) }].slice(-24);
      setTurns((previous) => previous.map((turn, i) => i === previous.length - 1 ? { ...turn, answer } : turn));
    } catch (cause) {
      setError(cause instanceof Error && cause.name !== 'AbortError' ? cause.message : '等待超时或连接已中断，请重试。');
      setInput(question);
    } finally {
      clearTimeout(timeout);
      pending.current = false;
      setBusy(false);
    }
  }

  function reset() {
    if (pending.current) return;
    history.current = [];
    setTurns([]);
    setSelected(null);
    setError('');
    setInput('');
    field.current?.focus();
  }

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
          <button type="button" onClick={reset} disabled={busy || !turns.length}>新咨询</button>
        </div>
      </header>
      <main className={`consult-main${turns.length ? ' consult-started' : ''}`}>
        {!turns.length ? (
          <section className="consult-welcome" aria-labelledby="consult-title">
            <span className="consult-eyebrow">从你的日常出发</span>
            <h1 id="consult-title">先聊需求，再选电脑。</h1>
            <p>用来做什么，预算多少，哪些软件离不开？<br />把事情说清楚，我们一起找到合适的方案。</p>
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
            {busy && <p className="consult-status" role="status">正在核对资料，整理适合你的方案…</p>}
            {error && <div className="consult-error" role="alert"><span>{error}</span><button type="button" disabled={busy} onClick={() => send(turns.at(-1)!.question, true)}>重试这条</button></div>}
            <div ref={end} />
          </section>
        )}
        <div className="consult-bottom">
          {selected && <div className="consult-handoff"><span>已选 · {selected.modelName}</span><a href={`/?${new URLSearchParams({ product: selected.modelId, scene })}`}>带到创作端 <span aria-hidden="true">↗</span></a></div>}
          <form className="composer consult-composer" onSubmit={(event) => {
            event.preventDefault();
            send(input, lastFailed && input.trim() === turns.at(-1)!.question);
          }}>
            <label className="sr" htmlFor="consult-input">你的任务、预算和关键软件</label>
            <textarea id="consult-input" ref={field} value={input} maxLength={2000} rows={2}
              placeholder={turns.length ? '补充你的需求，或继续追问…' : '例如：经常出差做方案，预算 7000，必须用 Office 和 Teams…'}
              disabled={busy} onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  send(input, lastFailed && input.trim() === turns.at(-1)!.question);
                }
              }} />
            <div className="composer-row"><span>{input.length ? `${input.length} / 2000` : '用途 · 预算 · 软件与版本'}</span><button className="send" type="submit" disabled={busy || !input.trim()} aria-label={busy ? '正在咨询' : '发送咨询'}>↑</button></div>
          </form>
          <p className="consult-note">依据本地资料提供建议 · 软件兼容需核实 · 价格如有展示均为历史快照</p>
        </div>
      </main>
    </div>
  );
}
