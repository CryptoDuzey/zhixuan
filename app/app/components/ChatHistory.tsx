'use client';
import { useEffect, useRef, useState } from 'react';
import './chat-history.css';

type Chat = { id: string; kind: 'agent' | 'consult'; title: string; updatedAt: string; busy: boolean };
export default function ChatHistory({ kind, activeId, disabled = false, onSelect, onNew }: {
  kind: 'agent' | 'consult'; activeId: string; disabled?: boolean; onSelect: (id: string) => void; onNew: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Chat[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [nextCursor, setNextCursor] = useState<string>();
  const request = useRef<AbortController | null>(null);
  const failedCursor = useRef<string | undefined>(undefined);
  const consumedCursors = useRef(new Set<string>());
  const trigger = useRef<HTMLButtonElement>(null);
  function cancelRequest() {
    request.current?.abort();
    request.current = null;
  }
  function close() { cancelRequest(); dialog.current?.close(); setOpen(false); trigger.current?.focus(); }
  async function loadPage(cursor?: string) {
    // A ref locks immediately, including two clicks before React renders again.
    if (request.current || (cursor && consumedCursors.current.has(cursor))) return;
    const abort = new AbortController();
    request.current = abort;
    const current = () => request.current === abort && !abort.signal.aborted;
    failedCursor.current = cursor;
    setLoading(true); setError('');
    try {
      const response = await fetch(`/api/chats?kind=${kind}&limit=40${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { cache: 'no-store', signal: abort.signal });
      if (!current()) return;
      if (!response.ok) throw new Error();
      const result = await response.json();
      if (!current()) return;
      if (!Array.isArray(result.items) || (result.nextCursor !== undefined
        && (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor.length > 512
          || result.nextCursor === cursor || consumedCursors.current.has(result.nextCursor)))) throw new Error();
      const page: Chat[] = result.items.filter((item: Chat) => item && typeof item.id === 'string' && item.kind === kind && typeof item.title === 'string' && typeof item.updatedAt === 'string');
      if (cursor) consumedCursors.current.add(cursor);
      setItems(previous => {
        const merged = cursor ? [...previous] : [];
        const ids = new Set(merged.map(item => item.id));
        for (const item of page) {
          if (!ids.has(item.id)) { ids.add(item.id); merged.push(item); }
        }
        return merged;
      });
      setNextCursor(result.nextCursor);
    } catch {
      if (current()) setError('暂时没能读到历史对话，可以重试。');
    } finally {
      if (current()) { request.current = null; setLoading(false); }
    }
  }
  useEffect(() => {
    if (!open) return;
    if (!dialog.current?.open) dialog.current?.showModal();
    setItems([]);
    setNextCursor(undefined);
    consumedCursors.current.clear();
    void loadPage();
    return cancelRequest;
  }, [open, kind]);
  const filtered = items.filter(item => item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <>
    <button ref={trigger} className="history-trigger" aria-label="历史对话" title="历史对话" disabled={disabled} onClick={() => setOpen(true)}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="4"/><path d="M9 4v16M13 9h4M13 13h4"/></svg>
    </button>
    <dialog ref={dialog} className="history-dialog" aria-labelledby={`history-title-${kind}`} onCancel={close} onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <aside className="history-panel">
        <div className="history-heading"><div><span>知选 / {kind === 'agent' ? '创作' : '选购'}</span><h2 id={`history-title-${kind}`}>对话</h2></div><button aria-label="关闭历史对话" onClick={close}>×</button></div>
        <button className="history-new" disabled={disabled} onClick={() => { close(); onNew(); }}><span aria-hidden="true">＋</span> 开始新对话</button>
        <label className="history-search"><span className="sr">搜索最近对话</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索最近对话" /></label>
        <div className="history-list" aria-busy={loading}>
          {error ? <p role="alert">{error} <button disabled={loading} onClick={() => { void loadPage(failedCursor.current); }}>重试</button></p> : null}
          {!error && loading && !items.length ? <p role="status">正在读取…</p> : null}
          {!error && !loading && !filtered.length ? <p>{query ? '最近对话中没有匹配结果。' : '从第一句话开始，聊过的内容会保存在这里。'}</p> : null}
          <nav aria-label="已保存对话">{filtered.map(item => <button key={item.id} className={activeId === item.id ? 'active' : ''} disabled={disabled} aria-current={activeId === item.id ? 'page' : undefined} onClick={() => { close(); onSelect(item.id); }}>
            <span>{item.title}</span><small>{item.busy ? '进行中' : Number.isNaN(Date.parse(item.updatedAt)) ? '' : new Date(item.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</small>
          </button>)}</nav>
          {nextCursor && !error ? <button className="history-more" disabled={loading || disabled} onClick={() => { void loadPage(nextCursor); }}>查看更早对话</button> : null}
        </div>
        <div className="history-bottom"><a href={kind === 'agent' ? '/consult' : '/'}>{kind === 'agent' ? '去选购，了解适合你的产品' : '去创作，把想法写成内容'} <span aria-hidden="true">↗</span></a><span>对话保存在当前设备</span></div>
      </aside>
    </dialog>
  </>;
}
