'use client';
import { useEffect, useRef, useState } from 'react';
import type { SessionView } from '../../lib/store.ts';
import type { CheckReport, Draft } from '../../lib/check.ts';
import ModelSettings from './ModelSettings';

type Step = { label: string; detail?: string; done: boolean; failed?: boolean };
type Msg =
  | { k: 'user'; text: string }
  | { k: 'steps'; run: number; steps: Step[] }
  | { k: 'clarify'; question: string; options: string[] }
  | { k: 'notice'; text: string }
  | { k: 'error'; text: string }
  | { k: 'agent'; text: string };

type Exported = { publishable: string; [k: string]: unknown };

const SUGGEST = [
  '大学新生开学选机，写一篇小红书',
  '商务差旅想要轻薄续航，写一篇公众号',
  '给朋友圈写一条鸿蒙电脑的短文案',
];
const PLATFORMS = ['公众号', '小红书', '朋友圈'] as const;
const TONES = ['更口语', '更克制专业', '更简短'];
const PRODUCTS = [
  ['pro-s', 'HUAWEI MateBook Pro S'],
  ['mb14-harmony', 'HUAWEI MateBook 14 鸿蒙版'],
  ['mb14-ultra', 'MateBook 14 酷睿 Ultra Windows 版'],
  ['d14', 'HUAWEI MateBook D 14 2024'],
  ['d16', 'HUAWEI MateBook D 16 2024'],
] as const;

const newId = () => `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export default function Studio() {
  const [sid] = useState(newId);
  const [mode, setMode] = useState<'home' | 'work'>('home');
  const [input, setInput] = useState('');
  const [log, setLog] = useState<Msg[]>([]);
  const [view, setView] = useState<SessionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [tones, setTones] = useState(false);
  const [exp, setExp] = useState<Exported | null>(null);
  const [copied, setCopied] = useState(false);
  const [settings, setSettings] = useState(false);
  const [product, setProduct] = useState('');
  const pendingProduct = useRef('');
  const logRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<string[]>([]);
  const runRef = useRef({ id: 0, completed: false, updated: false });
  const running = useRef(false);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const entry = PRODUCTS.find(([id]) => id === query.get('product'));
    if (entry) {
      setProduct(entry[0]);
      pendingProduct.current = entry[1];
      const scene = (query.get('scene') || '').slice(0, 500);
      setInput(`为 ${entry[1]} 写一篇小红书。${scene ? `场景：${scene}` : '请先和我确认受众与使用场景。'}`);
      window.history.replaceState({}, '', '/');
    }
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [log]);

  const draft: Draft | undefined = view?.draft;
  const report: CheckReport | undefined = view?.report;
  const current = !!draft && !!report && report.draftVersion === draft.version;

  const push = (m: Msg) => setLog((l) => [...l, m]);
  const failedRef = useRef(false);
  const closeSteps = (failed: boolean) =>
    setLog((l) =>
      l.map((m) =>
        m.k === 'steps' && m.run === runRef.current.id
          ? { ...m, steps: m.steps.map((s) => (s.done ? s : failed ? { ...s, failed: true } : { ...s, done: true })) }
          : m,
      ),
    );
  const addStep = (label: string, detail?: string) =>
    setLog((l) => {
      const last = l[l.length - 1];
      const step = { label, detail, done: false };
      if (last?.k === 'steps' && last.run === runRef.current.id) {
        const steps = [...last.steps.map((s) => ({ ...s, done: true })), step];
        return [...l.slice(0, -1), { k: 'steps', run: runRef.current.id, steps }];
      }
      return [...l, { k: 'steps', run: runRef.current.id, steps: [step] }];
    });

  async function run(payload: { message?: string; patch?: Partial<Draft> }, echo?: string) {
    if (running.current) return;
    running.current = true;
    runRef.current = { id: runRef.current.id + 1, completed: false, updated: false };
    setBusy(true);
    failedRef.current = false;
    setExp(null);
    setMode('work');
    if (echo) {
      push({ k: 'user', text: echo });
      historyRef.current.push(`用户：${echo}`);
    }
    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, ...payload, history: historyRef.current.join('\n') }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        failedRef.current = true;
        push({ k: 'error', text: j.error ?? `请求失败（${res.status}）` });
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) onEvent(JSON.parse(line));
        }
      }
      buf += dec.decode();
      if (buf.trim()) onEvent(JSON.parse(buf));
      if (!runRef.current.completed) throw new Error('本次任务未完成，请重试。');
    } catch (e: any) {
      failedRef.current = true;
      push({ k: 'error', text: `连接中断：${e?.message ?? e}，已停在上一步，可重新发送。` });
    } finally {
      closeSteps(failedRef.current);
      running.current = false;
      setBusy(false);
    }
  }

  function onEvent(e: any) {
    switch (e.type) {
      case 'step':
        addStep(e.label, e.detail);
        break;
      case 'clarify':
        push({ k: 'clarify', question: e.question, options: e.options ?? [] });
        historyRef.current.push(`助手：${e.question}`);
        break;
      case 'notice':
        push({ k: 'notice', text: e.text });
        break;
      case 'error':
        failedRef.current = true;
        push({ k: 'error', text: e.text });
        break;
      case 'draft':
        runRef.current.updated = true;
        setView((v) => ({ ...(v ?? { evidence: [], images: [] }), draft: e.draft, report: undefined }));
        break;
      case 'check':
        runRef.current.updated = true;
        setView((v) => (v ? { ...v, report: e.report } : v));
        break;
      case 'done':
        runRef.current.completed = true;
        setView(e.view);
        if (e.view?.draft?.modelId) setProduct(e.view.draft.modelId);
        if (!failedRef.current && runRef.current.updated && e.view?.draft) {
          const d: Draft = e.view.draft;
          const r: CheckReport | undefined = e.view.report;
          const open = r ? r.issues.filter((x) => x.severity === 'block').length : 0;
          const warn = r ? r.issues.length - open : 0;
          push({
            k: 'agent',
            text: !r
              ? `已生成第 ${d.version} 版。`
              : r.status === 'pass' && r.issues.length === 0
                ? `第 ${d.version} 版已核验，没有发现问题。`
                : `第 ${d.version} 版已核验：${open} 项必须处理，${warn} 项建议留意。点“查看依据”看具体位置。`,
          });
        }
        break;
    }
  }

  function submit(text = input) {
    if (running.current) return;
    let t = text.trim();
    if (!t) return;
    if (pendingProduct.current) {
      t = `本轮产品选择：${pendingProduct.current}。\n${t}`;
      pendingProduct.current = '';
    }
    setInput('');
    void run({ message: t }, t);
  }

  async function doExport() {
    setSheet(true);
    try {
      const res = await fetch(`/api/export?sessionId=${encodeURIComponent(sid)}`);
      const j = await res.json();
      if (!res.ok) {
        setExp(null);
        push({ k: 'notice', text: `不能导出：${j.error}` });
        return;
      }
      setExp(j);
    } catch (e: any) {
      push({ k: 'error', text: `导出失败：${e?.message ?? e}` });
    }
  }

  async function copyText() {
    if (!exp) return;
    try {
      await navigator.clipboard.writeText(exp.publishable);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      push({ k: 'notice', text: '浏览器未允许复制，可选中文本复制或下载文件。' });
    }
  }

  function download() {
    if (!exp) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(exp, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `zhixuan-export-v${draft?.version ?? 0}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function commit(field: 'title' | 'lead' | 'body' | 'cta', el: HTMLElement) {
    if (!draft || busy) return;
    const text = el.innerText.replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (text === (draft[field] ?? '').trim()) return;
    push({ k: 'user', text: `（直接修改了${{ title: '标题', lead: '导语', body: '正文', cta: '结尾' }[field]}）` });
    void run({ patch: { [field]: text } });
  }

  const header = (
    <header className="top">
      <div className="brand">
        <span className="mark">知</span>知选
      </div>
      <nav className="seg" aria-label="模式">
        <button className={mode === 'home' ? 'on' : ''} onClick={() => setMode('home')}>
          创作
        </button>
        <a href="/consult">选购</a>
      </nav>
      <div className="top-right">{draft ? <span className="model-label">{draft.modelName}</span> : null}<button className="settings-trigger" disabled={busy} onClick={() => setSettings(true)}>模型设置</button></div>
      {settings ? <ModelSettings onClose={() => setSettings(false)} /> : null}
    </header>
  );

  const composer = (placeholder: string, compact = false) => (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="sr" htmlFor={compact ? 'ci-work' : 'ci-home'}>
        告诉知选你的创作需求
      </label>
      <textarea
        id={compact ? 'ci-work' : 'ci-home'}
        value={input}
        placeholder={placeholder}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        rows={compact ? 1 : 2}
      />
      <div className="composer-row">
        <div className="composer-context">
          <select aria-label="创作产品" className="product-select" value={product} disabled={busy}
            onChange={(e) => {
              setProduct(e.target.value);
              pendingProduct.current = PRODUCTS.find(([id]) => id === e.target.value)?.[1] || '';
            }}>
            <option value="">先聊需求，再选产品</option>
            {PRODUCTS.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <span className="chip">{draft ? draft.platform : '平台随需求判断'}</span>
        </div>
        <button type="submit" className="send" disabled={busy || !input.trim()} aria-label="发送">
          ↑
        </button>
      </div>
    </form>
  );

  if (mode === 'home' && !draft) {
    return (
      <div className="shell">
        {header}
        <main className="home">
          <div className="home-inner">
            <h1>今天，想打动谁？</h1>
            <p className="sub">说说受众和场景，剩下的交给知选。</p>
            {composer('例如：给大学新生写一篇开学选机的小红书')}
            <div className="suggest">
              {SUGGEST.map((s) => (
                <button key={s} onClick={() => submit(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        </main>
        <div className="foot">基于已下载的指定知识库 · 支持查看原文依据</div>
      </div>
    );
  }

  if (mode === 'home' && draft) {
    return (
      <div className="shell">
        {header}
        <main className="home">
          <div className="home-inner">
            <h1>今天，想打动谁？</h1>
            <p className="sub">&nbsp;</p>
            {composer('开始新的创作')}
            <div className="suggest">
              <button onClick={() => setMode('work')}>继续创作：{draft.title || draft.platform}（第 {draft.version} 版）</button>
            </div>
          </div>
        </main>
        <div className="foot">基于已下载的指定知识库 · 支持查看原文依据</div>
      </div>
    );
  }

  const usedIds = new Set((draft?.claims ?? []).flatMap((c) => c.factIds));
  const imgById = new Map((view?.images ?? []).map((i) => [i.id, i]));
  const blocks = report?.issues.filter((i) => i.severity === 'block') ?? [];
  const coverImage = draft?.images[0];
  const coverRef = coverImage ? imgById.get(coverImage.imageId) : undefined;
  const status = busy && !current ? 'run' : !draft ? 'run' : !current ? 'run' : blocks.length ? 'fix' : report!.status === 'pass' ? 'pass' : 'fix';
  const statusText = !draft
    ? ''
    : busy && !current
      ? '核验中'
      : !current
        ? '待核验'
        : blocks.length
          ? `${blocks.length} 项必须处理`
          : report!.issues.length
            ? `通过，${report!.issues.length} 项建议`
            : '核验通过';

  return (
    <div className="shell">
      {header}
      <main className="work">
        <section className="chat" aria-label="对话">
          <div className="chat-log" ref={logRef} aria-live="polite">
            {log.map((m, i) => {
              if (m.k === 'user') return <div key={i} className="msg-user">{m.text}</div>;
              if (m.k === 'notice') return <div key={i} className="notice">{m.text}</div>;
              if (m.k === 'error') return <div key={i} className="errbox" role="alert">{m.text}</div>;
              if (m.k === 'agent')
                return (
                  <div key={i} className="msg-agent">
                    <span className="mark">知</span>
                    <div className="txt">{m.text}</div>
                  </div>
                );
              if (m.k === 'clarify')
                return (
                  <div key={i} className="msg-agent">
                    <span className="mark">知</span>
                    <div className="txt">
                      {m.question}
                      <div className="opts">
                        {m.options.map((o) => (
                          <button key={o} className="opt" disabled={busy} onClick={() => submit(o)}>
                            {o}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              return (
                <div key={i} className="msg-agent">
                  <span className="mark">知</span>
                  <div className="activity">
                    <ul>
                      {m.steps.map((s, j) => (
                        <li key={j}>
                          <span className={`dot ${s.done ? 'done' : s.failed ? 'fail' : 'live'}`} />
                          <span>{s.label}{s.detail ? `：${s.detail}` : ''}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              );
            })}
          </div>
          {composer('继续说：换成朋友圈 / 换成差旅场景 / 更口语一点', true)}
        </section>

        <section className={`canvas${draft ? ' editing' : ''}`} aria-label="稿件画布">
          <div className="canvas-head">
            <div className="platforms" role="group" aria-label="平台">
              {PLATFORMS.map((p) => (
                <button key={p} className={draft?.platform === p ? 'on' : ''} disabled={busy || !draft} onClick={() => submit(`换成${p}`)}>
                  {p}
                </button>
              ))}
            </div>
            {draft ? <span className={`badge ${status}`}>第 {draft.version} 版 · {statusText}</span> : null}
          </div>

          {draft ? (
            <article className="paper">
              <div className="paper-meta">
                <span>{draft.platform}</span>
                <span>可直接点击文字修改，修改后会重新核验</span>
              </div>
              <h2
                className="ms-title"
                contentEditable={!busy}
                suppressContentEditableWarning
                key={`t${draft.version}`}
                onBlur={(e) => commit('title', e.currentTarget)}
              >
                {draft.title}
              </h2>
              {draft.lead ? (
                <p className="ms-lead" contentEditable={!busy} suppressContentEditableWarning key={`l${draft.version}`} onBlur={(e) => commit('lead', e.currentTarget)}>
                  {draft.lead}
                </p>
              ) : null}
              {coverImage && coverRef ? (
                <figure className="fig cover-photo">
                  <img src={coverRef.src} alt={coverImage.caption || coverRef.filename} />
                  <figcaption><span className="pos">{coverImage.position}</span> {coverImage.caption}</figcaption>
                </figure>
              ) : null}
              <div className="ms-body" contentEditable={!busy} suppressContentEditableWarning key={`b${draft.version}`} onBlur={(e) => commit('body', e.currentTarget)}>
                {draft.body}
              </div>
              {draft.images.length ? (
                <div className="figs">
                  {draft.images.filter((_, i) => i > 0 || !coverRef).map((im) => {
                    const ref = imgById.get(im.imageId);
                    return (
                      <figure className="fig" key={im.imageId}>
                        {ref ? <img src={ref.src} alt={im.caption || ref.filename} loading="lazy" /> : <div className="gap">图片 {im.imageId} 不在本次资料中</div>}
                        <figcaption>
                          <span className="pos">{im.position}</span> {im.caption}
                        </figcaption>
                      </figure>
                    );
                  })}
                </div>
              ) : (
                <div className="gap">这一版没有配图。</div>
              )}
              {draft.cta ? (
                <div className="ms-cta" contentEditable={!busy} suppressContentEditableWarning key={`c${draft.version}`} onBlur={(e) => commit('cta', e.currentTarget)}>
                  {draft.cta}
                </div>
              ) : null}
              {draft.tags.length ? (
                <div className="ms-tags">
                  {draft.tags.map((t) => (
                    <span key={t}>{t.startsWith('#') ? t : `#${t}`}</span>
                  ))}
                </div>
              ) : null}
            </article>
          ) : (
            <article className="paper">
              <div className="paper-meta">
                <span>稿件</span>
                <span>{busy ? '正在核对产品资料' : '等待需求'}</span>
              </div>
              <div className="gap">{busy ? '正在核对产品资料，稿件很快出现在这里。' : '说出受众和场景，稿件会出现在这里。'}</div>
            </article>
          )}

          {draft ? (
            <div className="strip" role="toolbar" aria-label="稿件操作">
              <div style={{ position: 'relative' }}>
                <button disabled={busy} onClick={() => setTones((v) => !v)} aria-expanded={tones}>
                  调整语气
                </button>
                {tones ? (
                  <div className="strip" style={{ position: 'absolute', bottom: 'calc(100% + 10px)', left: 0 }}>
                    {TONES.map((t) => (
                      <button
                        key={t}
                        onClick={() => {
                          setTones(false);
                          submit(t);
                        }}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <button onClick={() => setSheet(true)}>查看依据</button>
              <button className="primary" disabled={busy || !current || blocks.length > 0} onClick={doExport}>
                核验后导出
              </button>
            </div>
          ) : null}
        </section>
      </main>

      {sheet ? (
        <>
          <div className="sheet-back" onClick={() => setSheet(false)} />
          <aside className="sheet" role="dialog" aria-label="资料与依据">
            <div className="sheet-head">
              <span>资料与依据</span>
              <button onClick={() => setSheet(false)} aria-label="关闭">
                关闭
              </button>
            </div>
            <div className="sheet-body">
              {exp ? (
                <>
                  <h3>导出文本（附核验记录）</h3>
                  <div className="issue" style={{ whiteSpace: 'pre-wrap' }}>{exp.publishable}</div>
                  <div style={{ display: 'flex', gap: 8, margin: '8px 0 4px' }}>
                    <button className="opt" onClick={copyText}>{copied ? '已复制' : '复制文本'}</button>
                    <button className="opt" onClick={download}>下载依据清单与核验报告</button>
                  </div>
                </>
              ) : null}

              <h3>核验结果</h3>
              {!report ? (
                <div className="issue">这一版还没有核验结果。</div>
              ) : report.draftVersion !== draft?.version ? (
                <div className="issue">现有核验对应第 {report.draftVersion} 版，稿件已更新，需要重新核验。</div>
              ) : report.issues.length === 0 ? (
                <div className="issue">没有发现问题。已核对 {report.verifiedClaimIds.length} 条结论、{report.verifiedImageIds.length} 张图片。</div>
              ) : (
                report.issues.map((it, i) => (
                  <div key={i} className={`issue${it.severity === 'block' ? ' block' : ''}`}>
                    <q>{it.text}</q>
                    <span className="why">
                      {it.severity === 'block' ? '必须处理' : '建议留意'} · {it.location} · {it.reason}（建议：{it.action}）
                    </span>
                  </div>
                ))
              )}

              <h3>产品资料与实际来源</h3>
              {(view?.evidence ?? []).map((e) => (
                <div key={e.id} className={`ev${usedIds.has(e.id) ? ' used' : ''}`}>
                  <div className="id">
                    {e.id} · {e.docTitle}
                    {e.section ? ` · ${e.section}` : ''}
                    {usedIds.has(e.id) ? ' · 本稿引用' : ''}
                  </div>
                  <div>{e.text}</div>
                  <div className="src">{e.source} · 读取于 {e.readAt}</div>
                </div>
              ))}

              <h3>图片来源</h3>
              {(view?.images ?? []).map((im) => (
                <div key={im.id} className="ev">
                  <div className="id">{im.id} · {im.filename}</div>
                  <div className="src">{im.source}</div>
                </div>
              ))}
            </div>
          </aside>
        </>
      ) : null}
    </div>
  );
}
