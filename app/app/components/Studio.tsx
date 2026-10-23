'use client';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import ChatHistory from './ChatHistory';
import { conversationId, pinConversation } from './conversation-location.ts';
import { workspacePointerSplit, watchWorkspaceBreakpoint, WORKSPACE_DIVIDER } from './workspace-split.ts';
import type { SessionView } from '../../lib/store.ts';
import type { CheckReport, Draft } from '../../lib/check.ts';
import { hasCompleteClaimReview, isBlockingIssue, isPublishableReport } from '../../lib/check.ts';
import ModelSettings from './ModelSettings';
import AnswerText from './AnswerText';
import ModelPreview, { useModelPreview } from './ModelPreview';
import { draftMessage, restoredDraftMessage } from '../../lib/draft-message.ts';
import { handoffStorage, takeHandoff, handoffMessage, type CreativeHandoff } from './frontend-handoff.ts';
import { consumeAgentStream, parseAgentRun, runStatusText, type AgentRun } from '../../lib/agent-stream.ts';
import {
  browserStorage, newStudioId, parseAgentSession, readStorage, SessionEpoch,
  STUDIO_SESSION_KEY, validStudioId, writeStorage,
} from './frontend-session.ts';

type Step = { label: string; detail?: string; done: boolean; failed?: boolean };
type Msg =
  | { k: 'user'; text: string }
  | { k: 'steps'; run: number; steps: Step[] }
  | { k: 'tool'; run: number; tool: string; label: string; status: 'started' | 'completed' | 'failed'; ms?: number; cacheHit?: boolean }
  | { k: 'clarify'; question: string; options: string[] }
  | { k: 'notice'; text: string }
  | { k: 'error'; text: string }
  | { k: 'agent'; text: string };

type Exported = { publishable: string; version: number; [k: string]: unknown };

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

export default function Studio() {
  const [session, setSession] = useState<{ id: string; restore: boolean } | null>(null);
  const sid = session?.id ?? '';
  const activeSid = useRef('');
  const [recovery, setRecovery] = useState<'loading' | 'polling' | 'ready' | 'error'>('loading');
  const [recoveryError, setRecoveryError] = useState('');
  const [sessionNote, setSessionNote] = useState('');
  const [storageNote, setStorageNote] = useState('');
  const [refresh, setRefresh] = useState(0);
  const ready = useRef(false);
  const requests = useRef(new SessionEpoch());
  const boot = useRef<{ id: string; restore: boolean; product: string; scene: string; handoff: boolean; transfer: CreativeHandoff | null; invalidTransfer: boolean } | null>(null);
  const [mode, setMode] = useState<'home' | 'work'>('home');
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [split, setSplit] = useState(40);
  const workspaceRef = useRef<HTMLElement>(null);
  const dividerRef = useRef<HTMLDivElement>(null);
  const workspaceDrag = useRef<{ pointerId: number; grab: number; startX: number; startLeft: number; moved: boolean } | null>(null);
  const [input, setInput] = useState('');
  const [log, setLog] = useState<Msg[]>([]);
  const [view, setView] = useState<SessionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [tones, setTones] = useState(false);
  const [exp, setExp] = useState<Exported | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const exportRequests = useRef(new SessionEpoch());
  const exportPending = useRef(false);
  const [copied, setCopied] = useState(false);
  const [settings, setSettings] = useState(false);
  const [product, setProduct] = useState('');
  const pendingProduct = useRef('');
  const logRef = useRef<HTMLDivElement>(null);
  const followLog = useRef(true);
  const historyRef = useRef<string[]>([]);
  const runRef = useRef({ id: 0, completed: false, updated: false });
  const running = useRef(false);
  const [agentRun, setAgentRun] = useState<AgentRun | undefined>();
  const [stopping, setStopping] = useState(false);
  const cancelPending = useRef(false);
  const [modelProgress, setModelProgress] = useState<{ callId: string; characters: number; mode: string } | null>(null);
  const { preview, resetPreview, clearPreview, receivePreviewEvent } = useModelPreview();
  const [handoffPlatform, setHandoffPlatform] = useState('');

  useEffect(() => () => exportRequests.current.cancel(), []);
  useEffect(() => {
    if (!workspaceOpen) { cancelWorkspaceDrag(); return; }
    const media = window.matchMedia('(max-width:860px)');
    return watchWorkspaceBreakpoint(media, cancelWorkspaceDrag);
  }, [workspaceOpen]);
  useEffect(() => {
    const stored = Number(readStorage(browserStorage(), 'zhixuan.workspace.split.v1').value);
    if (stored >= 28 && stored <= 64) setSplit(stored);
  }, []);

  function resetExport() {
    exportRequests.current.cancel();
    exportPending.current = false;
    setExporting(false);
    setExportError('');
    setExp(null);
    setCopied(false);
  }

  useEffect(() => {
    // Keep the first decision across StrictMode's setup/cleanup/setup cycle.
    if (!boot.current) {
      const query = new URLSearchParams(window.location.search);
      const saved = readStorage(browserStorage(), STUDIO_SESSION_KEY);
      const savedId = conversationId(window.location.search, saved.value);
      const hasTransfer = query.has('handoff');
      const transfer = hasTransfer ? takeHandoff(handoffStorage(), query.get('handoff') || '') : null;
      const handoff = hasTransfer || query.has('product') || query.has('scene');
      const restore = !handoff && validStudioId(savedId);
      boot.current = {
        id: restore ? savedId! : newStudioId(), restore,
        product: transfer?.productId ?? query.get('product') ?? '', scene: (query.get('scene') ?? '').slice(0, 500), handoff,
        transfer, invalidTransfer: hasTransfer && !transfer,
      };
      if (handoff) {
        query.delete('product');
        query.delete('scene');
        query.delete('handoff');
        window.history.replaceState(window.history.state, '', `${window.location.pathname}${query.size ? `?${query}` : ''}${window.location.hash}`);
      }
    }
    const initial = boot.current;
    saveId(initial.id);
    setSession({ id: initial.id, restore: initial.restore });
    const entry = PRODUCTS.find(([id]) => id === initial.product);
    if (initial.handoff) {
      setSessionNote(initial.invalidTransfer ? '交接需求已过期或无法读取。已开启独立创作，请返回咨询重新确认，或在此补充需求。'
        : entry ? '已从选购端开启独立创作，请确认下方需求后发送。产品信息将重新查证。' : '已开启新创作。传入的产品未能识别，请重新选择产品。');
    }
    if (entry && initial.handoff) {
      setProduct(entry[0]);
      pendingProduct.current = entry[1];
      setInput(initial.transfer ? handoffMessage(initial.transfer) : `为 ${entry[1]} 创作内容。${initial.scene ? `场景：${initial.scene}` : '请先和我确认受众、发布平台与使用场景。'}`);
      setHandoffPlatform(initial.transfer?.platform || '');
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    if (!session.restore && refresh === 0) {
      ready.current = true;
      setRecovery('ready');
      return () => { ready.current = false; requests.current.cancel(); };
    }
    const task = requests.current.start();
    ready.current = false;
    running.current = false;
    clearPreview();
    setModelProgress(null);
    setRecovery('loading');
    setRecoveryError('');
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function restore() {
      try {
        const response = await fetch(`/api/agent?sessionId=${encodeURIComponent(session!.id)}`, {
          cache: 'no-store', signal: AbortSignal.any([task.signal, AbortSignal.timeout(20_000)]),
        });
        if (!task.current()) return;
        if (response.status === 404) {
          newCreation('此前会话不存在，已开启新创作。');
          return;
        }
        if (!response.ok) throw new Error(`暂时无法恢复（${response.status}），请重试。`);
        const snapshot = parseAgentSession(await response.json());
        if (!task.current()) return;
        setView(snapshot.view);
        setWorkspaceOpen(!!snapshot.view.draft || (snapshot.busy && snapshot.view.need?.intent !== 'chat' && snapshot.view.need?.next_action === 'write'));
        setAgentRun(snapshot.run);
        setStopping(snapshot.busy && !!snapshot.run?.cancelRequested);
        cancelPending.current = snapshot.busy && !!snapshot.run?.cancelRequested;
        setProduct(PRODUCTS.find(([, name]) => name === snapshot.view.draft?.modelName)?.[0] ?? snapshot.view.draft?.modelId ?? '');
        setLog(snapshot.messages.map((m): Msg => {
          if (m.role === 'user') return { k: 'user', text: m.text };
          if (m.kind === 'clarify') return { k: 'clarify', question: m.text, options: m.options ?? [] };
          return { k: m.kind ?? 'agent', text: m.kind === 'agent' ? restoredDraftMessage(m.text) : m.text };
        }));
        historyRef.current = snapshot.messages.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.text}`);
        setMode(snapshot.messages.length || snapshot.view.draft || snapshot.busy || snapshot.interrupted ? 'work' : 'home');
        setBusy(snapshot.busy);
        if (snapshot.busy) {
          setRecovery('polling');
          setSessionNote('正在恢复任务，服务端仍在处理。完成后会自动更新，请稍候。');
          timer = setTimeout(() => { void restore(); }, 1500);
        } else {
          ready.current = true;
          setRecovery('ready');
          setSessionNote(snapshot.run && snapshot.run.status !== 'completed'
            ? runStatusText(snapshot.run)
            : snapshot.interrupted
            ? '上次任务因服务重启而中断，尚未完成。已恢复保存的内容，请重新发送需求继续。'
            : snapshot.view.draft ? '已恢复稿件与对话，可以继续创作。' : '已恢复对话，可以接着聊。');
        }
      } catch (cause) {
        if (!task.current()) return;
        ready.current = false;
        setBusy(false);
        setRecovery('error');
        setRecoveryError(cause instanceof Error && cause.name !== 'TimeoutError' ? cause.message : '恢复等待超时，请重试。');
      }
    }
    void restore();
    return () => {
      clearTimeout(timer);
      ready.current = false;
      requests.current.cancel();
    };
  }, [session, refresh]);

  function saveId(id: string) {
    activeSid.current = id;
    const saved = writeStorage(browserStorage(), STUDIO_SESSION_KEY, id);
    const pinned = pinConversation(id, window.location, window.history);
    setStorageNote(pinned ? '' : saved ? '本页对话位置未能保存，刷新后可能打开最近使用的其他对话。' : '浏览器未允许保存会话编号，本页仍可使用；关闭或刷新后可能无法找回。');
  }

  function newCreation(note = '已开启新创作，说说这次的受众和场景。') {
    requests.current.cancel();
    clearPreview();
    ready.current = false;
    running.current = false;
    const id = newStudioId();
    saveId(id);
    setSession({ id, restore: false });
    setRefresh(0);
    setRecovery('loading');
    setRecoveryError('');
    setSessionNote(note);
    setMode('home');
    setWorkspaceOpen(false);
    setLog([]);
    setView(null);
    setInput('');
    setProduct('');
    pendingProduct.current = '';
    historyRef.current = [];
    setBusy(false);
    setModelProgress(null);
    setHandoffPlatform('');
    setAgentRun(undefined);
    setStopping(false);
    cancelPending.current = false;
    resetExport();
    setSheet(false);
    setTones(false);
  }

  function recoverTask() {
    requests.current.cancel();
    resetExport();
    clearPreview();
    setModelProgress(null);
    ready.current = false;
    setRecovery('loading');
    setRefresh((value) => value + 1);
  }

  function openConversation(id: string) {
    if (busy || !validStudioId(id) || id === sid) return;
    requests.current.cancel();
    resetExport();
    clearPreview();
    setModelProgress(null);
    ready.current = false;
    running.current = false;
    cancelPending.current = false;
    setStopping(false);
    setLog([]);
    setView(null);
    setWorkspaceOpen(false);
    setInput('');
    setProduct('');
    pendingProduct.current = '';
    historyRef.current = [];
    setSheet(false);
    setTones(false);
    setRecoveryError('');
    setSessionNote('');
    setRecovery('loading');
    setMode('work');
    saveId(id);
    setSession({ id, restore: true });
    setRefresh(0);
  }

  function resizeWorkspace(value: number) {
    if (!Number.isFinite(value)) return;
    const width = Math.round(Math.min(64, Math.max(28, value)) * 10000) / 10000;
    setSplit(width);
    writeStorage(browserStorage(), 'zhixuan.workspace.split.v1', String(width));
  }

  function startWorkspaceDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || workspaceDrag.current || window.matchMedia('(max-width:860px)').matches) return;
    const bounds = workspaceRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 860) return;
    const divider = event.currentTarget.getBoundingClientRect();
    const grab = event.clientX - divider.left;
    if (grab < 0 || grab > WORKSPACE_DIVIDER) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    workspaceDrag.current = { pointerId: event.pointerId, grab, startX: event.clientX,
      startLeft: divider.left - bounds.left, moved: false };
  }

  function endWorkspaceDrag(event: PointerEvent<HTMLDivElement>) {
    if (workspaceDrag.current?.pointerId !== event.pointerId) return;
    cancelWorkspaceDrag();
  }

  function cancelWorkspaceDrag() {
    const drag = workspaceDrag.current;
    workspaceDrag.current = null;
    const divider = dividerRef.current;
    if (drag && divider?.hasPointerCapture(drag.pointerId)) divider.releasePointerCapture(drag.pointerId);
  }

  function moveWorkspaceDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = workspaceDrag.current;
    if (!drag || drag.pointerId !== event.pointerId || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const bounds = workspaceRef.current?.getBoundingClientRect();
    if (!bounds || window.matchMedia('(max-width:860px)').matches) { endWorkspaceDrag(event); return; }
    const next = workspacePointerSplit(bounds.width, event.clientX - bounds.left, drag.grab);
    if (next === undefined) { endWorkspaceDrag(event); return; }
    // A click or an attempted movement beyond a clamped minimum is not a new preference.
    if (!drag.moved && (event.clientX === drag.startX || Math.abs((bounds.width - WORKSPACE_DIVIDER) * next / 100 - drag.startLeft) < 0.01)) return;
    drag.moved = true;
    resizeWorkspace(next);
  }

  async function stopTask() {
    if (!agentRun || agentRun.status !== 'running' || cancelPending.current) return;
    const stoppingSid = sid;
    const stoppingGeneration = runRef.current.id;
    cancelPending.current = true;
    clearPreview();
    setModelProgress(null);
    setStopping(true);
    try {
      const response = await fetch('/api/agent/cancel', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, runId: agentRun.id }),
        signal: AbortSignal.timeout(20_000),
      });
      if (activeSid.current !== stoppingSid || runRef.current.id !== stoppingGeneration) return;
      if (response.status !== 202 && response.status !== 409) throw new Error('停止请求未能确认，正在重新查询任务。');
      recoverTask();
    } catch {
      if (activeSid.current !== stoppingSid || runRef.current.id !== stoppingGeneration) return;
      setSessionNote('停止请求未能确认，正在重新查询任务。');
      recoverTask();
    }
  }

  useEffect(() => {
    if (followLog.current) logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log, preview?.text]);

  const draft: Draft | undefined = view?.draft;
  const report: CheckReport | undefined = view?.report;
  const current = !!draft && !!report && report.draftVersion === draft.version && hasCompleteClaimReview(report, draft);
  const blocked = busy || recovery !== 'ready';

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
    if (running.current || !ready.current || !sid) return;
    const task = requests.current.start();
    resetPreview();
    running.current = true;
    runRef.current = { id: runRef.current.id + 1, completed: false, updated: false };
    setBusy(true);
    setModelProgress(null);
    setAgentRun(undefined);
    setStopping(false);
    cancelPending.current = false;
    failedRef.current = false;
    resetExport();
    setSessionNote('');
    setMode('work');
    if (echo) {
      followLog.current = true;
      push({ k: 'user', text: echo });
      historyRef.current.push(`用户：${echo}`);
    }
    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ sessionId: sid, ...payload, history: historyRef.current.join('\n') }),
        signal: task.signal,
      });
      if (!task.current()) return;
      if (res.status === 409) {
        recoverTask();
        return;
      }
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        if (!task.current()) return;
        failedRef.current = true;
        push({ k: 'error', text: j.error ?? `请求失败（${res.status}）` });
        if (payload.message) setInput(payload.message);
        return;
      }
      await consumeAgentStream(res, (event) => { if (task.current()) onEvent(event); });
      if (!task.current()) return;
      if (!runRef.current.completed) throw new Error('本次任务未完成，请重试。');
    } catch (e: any) {
      if (!task.current()) return;
      failedRef.current = true;
      push({ k: 'notice', text: '连接已中断，正在向服务端确认任务状态。' });
      recoverTask();
    } finally {
      if (!task.current()) return;
      closeSteps(failedRef.current);
      clearPreview();
      setModelProgress(null);
      running.current = false;
      setBusy(false);
    }
  }

  function onEvent(e: any) {
    if (!receivePreviewEvent(e)) return;
    const state = parseAgentRun(e.run);
    if (state) {
      setAgentRun(state);
      if (state.status !== 'running') {
        setModelProgress(null);
        setStopping(false);
        cancelPending.current = false;
        setSessionNote(state.status === 'completed' ? '' : runStatusText(state));
        if (state.status !== 'completed') failedRef.current = true;
      }
    }
    switch (e.type) {
      case 'need':
        if (e.need?.intent !== 'chat' && e.need?.next_action === 'write') setWorkspaceOpen(true);
        break;
      case 'model_preview':
        if (e.kind === 'draft' && e.status === 'generating') setWorkspaceOpen(true);
        setModelProgress(null);
        break;
      case 'model_progress':
        if (!cancelPending.current && typeof e.callId === 'string' && e.callId.length <= 200 && Number.isSafeInteger(e.characters) && e.characters >= 0
          && (e.mode === 'stream' || e.mode === 'buffered')) {
          setModelProgress({ callId: e.callId, characters: e.characters, mode: e.mode });
        }
        break;
      case 'run':
        break;
      case 'tool':
        if (!['model', 'knowledge'].includes(e.tool) || !['started', 'completed', 'failed'].includes(e.status)
          || typeof e.label !== 'string' || e.label.length > 2000) break;
        setLog((items) => {
          const entry: Msg = {
            k: 'tool', run: runRef.current.id, tool: e.tool, label: e.label, status: e.status,
            ...(Number.isFinite(e.ms) && e.ms >= 0 ? { ms: e.ms } : {}),
            ...(typeof e.cacheHit === 'boolean' ? { cacheHit: e.cacheHit } : {}),
          };
          const index = items.findLastIndex((item) => item.k === 'tool' && item.run === runRef.current.id
            && item.tool === e.tool && item.label === e.label && item.status === 'started');
          if (index < 0 || e.status === 'started') return [...items, entry];
          return items.map((item, i) => i === index ? entry : item);
        });
        break;
      case 'step':
        setModelProgress(null);
        if (typeof e.label === 'string') setAgentRun((state) => state?.status === 'running' ? { ...state, phase: e.label } : state);
        addStep(e.label, e.detail);
        break;
      case 'clarify':
        setModelProgress(null);
        push({ k: 'clarify', question: e.question, options: e.options ?? [] });
        historyRef.current.push(`助手：${e.question}`);
        break;
      case 'notice':
        push({ k: 'notice', text: e.text });
        break;
      case 'error':
        setModelProgress(null);
        failedRef.current = true;
        push({ k: 'error', text: e.text });
        break;
      case 'draft':
        setWorkspaceOpen(true);
        setModelProgress(null);
        runRef.current.updated = true;
        setView((v) => ({ ...(v ?? { evidence: [], images: [] }), draft: e.draft, report: undefined }));
        break;
      case 'check':
        runRef.current.updated = true;
        setView((v) => (v ? { ...v, report: e.report } : v));
        break;
      case 'done':
        setModelProgress(null);
        runRef.current.completed = true;
        setView(e.view);
        if (!e.view?.draft) setWorkspaceOpen(false);
        if (e.view?.draft?.modelId) setProduct(PRODUCTS.find(([, name]) => name === e.view.draft.modelName)?.[0] ?? e.view.draft.modelId);
        if (!failedRef.current && runRef.current.updated && e.view?.draft) {
          const d: Draft = e.view.draft;
          const r: CheckReport | undefined = e.view.report;
          push({
            k: 'agent',
            text: draftMessage(d, r),
          });
        }
        break;
    }
  }

  function submit(text = input) {
    if (running.current || !ready.current) return;
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
    if (blocked || running.current || !ready.current || !draft || !isPublishableReport(report, draft) || exportPending.current) return;
    const exportingSid = sid;
    const version = draft.version;
    const task = exportRequests.current.start();
    exportPending.current = true;
    setExporting(true);
    setExportError('');
    setExp(null);
    setCopied(false);
    setSheet(true);
    try {
      const res = await fetch(`/api/export?sessionId=${encodeURIComponent(sid)}`, {
        cache: 'no-store', signal: AbortSignal.any([task.signal, AbortSignal.timeout(20_000)]),
      });
      const j = await res.json();
      if (!task.current() || exportingSid !== activeSid.current) return;
      if (!res.ok) {
        setExportError(typeof j.error === 'string' ? j.error : '正文暂时无法导出，请重试。');
        return;
      }
      if (j.version !== version || typeof j.publishable !== 'string' || !j.publishable.trim()) {
        if (Number.isSafeInteger(j.version) && j.version > version) recoverTask();
        setExportError('稿件已更新或正文未准备好，请重新导出。');
        return;
      }
      setExp(j);
    } catch {
      if (!task.current() || exportingSid !== activeSid.current) return;
      setExportError('正文暂时无法导出，请重试。');
    } finally {
      if (task.current()) {
        exportPending.current = false;
        setExporting(false);
      }
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

  function download(format: 'text' | 'sources') {
    if (!exp) return;
    const body = format === 'text' ? exp.publishable : JSON.stringify({
      version: exp.version, platform: exp.platform, model: exp.model, images: exp.images, supplementaryImages: exp.supplementaryImages, evidence: exp.evidence,
    }, null, 2);
    const url = URL.createObjectURL(new Blob([body], { type: format === 'text' ? 'text/plain;charset=utf-8' : 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `知选-第${exp.version}版${format === 'text' ? '正文.txt' : '来源清单.json'}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function commit(field: 'title' | 'lead' | 'body' | 'cta', el: HTMLElement) {
    if (!draft || blocked || !ready.current) return;
    const text = el.innerText.replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (text === (draft[field] ?? '').trim()) return;
    push({ k: 'user', text: `（直接修改了${{ title: '标题', lead: '导语', body: '正文', cta: '结尾' }[field]}）` });
    void run({ patch: { [field]: text } });
  }

  const header = (
    <header className="top">
      <div className="brand">
        <ChatHistory kind="agent" activeId={sid} disabled={busy || recovery !== 'ready'} onSelect={openConversation} onNew={() => newCreation('')} />
        <span className="mark">知</span>知选
      </div>
      <nav className="seg" aria-label="模式">
        <button className={mode === 'home' ? 'on' : ''} onClick={() => setMode('home')}>
          创作
        </button>
        <a href="/consult">选购</a>
      </nav>
      <div className="top-right">{draft ? <button className="canvas-toggle" onClick={() => setWorkspaceOpen(value => !value)}>{workspaceOpen ? '收起稿件' : '打开稿件'}</button> : null}<button className="new-session" disabled={!session} onClick={() => newCreation('')}>新对话</button><button className="settings-trigger" aria-label="设置" disabled={busy} onClick={() => setSettings(true)}>设置</button></div>
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
        disabled={blocked}
        maxLength={30000}
      />
      <div className="composer-row">
        <span className="composer-hint">Shift + Enter 换行</span>
        <button type="submit" className="send" disabled={blocked || !input.trim()} aria-label="发送">
          ↑
        </button>
      </div>
    </form>
  );

  const sessionStatus = (
    <div className="session-status" aria-live="polite" aria-busy={recovery === 'loading' || recovery === 'polling'}>

      {recovery === 'loading' ? <p role="status">正在恢复会话…</p> : null}
      {recovery === 'error' ? <p className="session-error" role="alert">{recoveryError}<button onClick={recoverTask}>重试恢复</button><span>也可点“新创作”开始。</span></p> : null}
      {recovery !== 'loading' && recovery !== 'error' && sessionNote ? <p role="status">{sessionNote}</p> : null}
      {storageNote ? <p>{storageNote}</p> : null}
      {busy && agentRun?.status === 'running' ? (
        <div className="run-status" role="status">
          <span>{stopping ? '正在停止，请等待确认' : '正在整理内容…'}</span>
          <button type="button" onClick={stopTask} disabled={stopping}>{stopping ? '等待确认' : '停止任务'}</button>
        </div>
      ) : null}
    </div>
  );

  if (mode === 'home' && !draft) {
    return (
      <div className="shell">
        {header}
        <main className="home">
          <div className="home-inner">
            <div className="home-art" aria-hidden="true" />
            <span className="home-eyebrow">知选 · 创作</span>
            <h1>好内容，从一句话开始。</h1>
            <p className="sub">聊个想法，或一起写点什么。</p>
            {sessionStatus}
            {composer('例如：给大学新生写一篇开学选机的小红书')}
            <div className="suggest">
              {SUGGEST.map((s) => (
                <button key={s} disabled={blocked} onClick={() => submit(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        </main>
        <div className="foot"><span>HUAWEI 华为中国区 × 拓浙 AI 生态</span><span>浙客松 · 参赛作品</span></div>
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
            {sessionStatus}
            {composer('继续修改当前稿件，或点右上角“新创作”')}
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
  const blocks = report?.issues.filter(isBlockingIssue) ?? [];
  const coverImage = draft?.images[0];
  const coverRef = coverImage ? imgById.get(coverImage.imageId) : undefined;
  const status = !draft || !current ? 'run' : blocks.length || report!.status !== 'pass' ? 'fix' : 'pass';
  const statusText = !draft
    ? ''
    : busy && !current
      ? '正在整理'
      : !current
        ? '草稿'
        : blocks.length
          ? `${blocks.length} 项必须处理`
          : report!.status !== 'pass'
            ? '需要调整'
          : report!.issues.length
            ? `通过，${report!.issues.length} 项建议`
            : report!.status === 'pass' ? '可导出' : '需要调整';

  return (
    <div className="shell">
      {header}
      <main className={`work${workspaceOpen ? '' : ' conversation-only'}`} ref={workspaceRef}
        style={workspaceOpen ? { gridTemplateColumns: `minmax(280px, ${split}fr) 12px minmax(360px, ${100 - split}fr)` } : undefined}>
        <section className="chat" aria-label="对话">
          {sessionStatus}
          <div className="chat-log" ref={logRef} aria-live="polite" onScroll={event => {
            const node = event.currentTarget;
            followLog.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
          }}>
            {log.map((m, i) => {
              if (m.k === 'user') return <div key={i} className="msg-user">{m.text}</div>;
              if (m.k === 'error') return <div key={i} className="errbox" role="alert">{m.text}</div>;
              if (m.k === 'tool' || m.k === 'steps') return null;
              if (m.k === 'agent' || m.k === 'notice')
                return (
                  <div key={i} className="msg-agent">
                    <span className="mark">知</span>
                    <div className="txt"><AnswerText text={m.text} /></div>
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
                          <button key={o} className="opt" disabled={blocked} onClick={() => submit(o)}>
                            {o}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              return null;
            })}
            {busy && <ModelPreview preview={preview} />}
          </div>
          {composer('继续聊聊，或告诉我想写什么…', true)}
        </section>
        {workspaceOpen ? <><div ref={dividerRef} className="workspace-divider" role="separator" aria-label="调整对话和稿件宽度" aria-orientation="vertical" tabIndex={0}
          aria-valuemin={28} aria-valuemax={64} aria-valuenow={split}
          onPointerDown={startWorkspaceDrag}
          onPointerMove={moveWorkspaceDrag}
          onPointerUp={endWorkspaceDrag}
          onPointerCancel={endWorkspaceDrag}
          onLostPointerCapture={endWorkspaceDrag}
          onKeyDown={event => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); resizeWorkspace(split + (event.key === 'ArrowLeft' ? -3 : 3)); }
            if (event.key === 'Home') { event.preventDefault(); resizeWorkspace(40); }
          }} />
        <section className={`canvas${draft ? ' editing' : ''}`} aria-label="稿件画布">
          <div className="canvas-head">
            <div className="platforms" role="group" aria-label="平台">
              {PLATFORMS.map((p) => (
                <button key={p} className={draft?.platform === p ? 'on' : ''} disabled={blocked || !draft} onClick={() => submit(`换成${p}`)}>
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
                <span>点击文字即可修改</span>
              </div>
              {!current ? <div className="draft-preview" role="status">内容还在整理，稍后可以导出。</div> : null}
              <h2
                className="ms-title"
                contentEditable={!blocked}
                suppressContentEditableWarning
                key={`t${draft.version}`}
                onBlur={(e) => commit('title', e.currentTarget)}
              >
                {draft.title}
              </h2>
              {draft.lead ? (
                <p className="ms-lead" contentEditable={!blocked} suppressContentEditableWarning key={`l${draft.version}`} onBlur={(e) => commit('lead', e.currentTarget)}>
                  {draft.lead}
                </p>
              ) : null}
              {coverImage && coverRef ? (
                <figure className="fig cover-photo">
                  <img src={coverRef.src} alt={coverImage.caption || coverRef.filename} />
                  <figcaption>{coverImage.caption}</figcaption>
                </figure>
              ) : null}
              <div className="ms-body" contentEditable={!blocked} suppressContentEditableWarning key={`b${draft.version}`} onBlur={(e) => commit('body', e.currentTarget)}>
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
                          {im.caption}
                        </figcaption>
                      </figure>
                    );
                  })}
                </div>
              ) : (
                <div className="gap">这一版没有配图。</div>
              )}
              {draft.cta ? (
                <div className="ms-cta" contentEditable={!blocked} suppressContentEditableWarning key={`c${draft.version}`} onBlur={(e) => commit('cta', e.currentTarget)}>
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
              {view?.supplementaryImages?.length ? <section className="scene-figs" aria-label="辅助场景配图">
                <h3>场景配图</h3>
                {view.supplementaryImages.map(image => <figure className="fig" key={image.id}>
                  <img src={image.src} alt={image.caption} loading="lazy" />
                  <figcaption>{image.caption}</figcaption>
                  <a className="opt" href={image.src} download={`scene-${image.id}.png`}>保存场景图</a>
                </figure>)}
                <button className="opt" disabled={blocked} onClick={() => submit('移除当前稿件的所有AI辅助场景图，保留原文和图库产品图，不要生成新图。')}>移除场景配图</button>
              </section> : null}
            </article>
          ) : (
            <article className="paper">
              <div className="paper-meta">
                <span>稿件</span>
                <span>{busy ? '正在处理…' : '等待需求'}</span>
              </div>
              <div className="gap">{busy ? '正在处理你的问题。' : '说出受众和场景，稿件会出现在这里。'}</div>
            </article>
          )}

          {draft ? (
            <div className="strip" role="toolbar" aria-label="稿件操作">
              <div style={{ position: 'relative' }}>
                <button disabled={blocked} onClick={() => setTones((v) => !v)} aria-expanded={tones}>
                  调整语气
                </button>
                {tones ? (
                  <div className="strip" style={{ position: 'absolute', bottom: 'calc(100% + 10px)', left: 0 }}>
                    {TONES.map((t) => (
                      <button
                        key={t}
                        disabled={blocked}
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
              <button disabled={blocked} onClick={() => submit('给当前这篇补充一张有意义的场景配图，优先使用图库已有的图；缺少合适环境图时才生成，不要生成产品外观。')}>补充配图</button>
              <button onClick={() => setSheet(true)}>内容建议</button>
              <button className="primary" disabled={blocked || exporting || !draft || !isPublishableReport(report, draft)} onClick={doExport}>
                导出内容
              </button>
            </div>
          ) : null}
        </section></> : null}
      </main>

      {sheet ? (
        <>
          <div className="sheet-back" onClick={() => setSheet(false)} />
          <aside className="sheet" role="dialog" aria-label="内容建议与来源">
            <div className="sheet-head">
              <span>内容建议与来源</span>
              <button onClick={() => setSheet(false)} aria-label="关闭">
                关闭
              </button>
            </div>
            <div className="sheet-body">
              {exporting ? <p role="status">正在准备正文…</p> : null}
              {exportError ? <div className="issue" role="alert">{exportError}<button className="opt" disabled={blocked || exporting} onClick={doExport}>重新导出</button></div> : null}
              {exp ? (
                <>
                  <h3>可复制的正文</h3>
                  <div className="issue" style={{ whiteSpace: 'pre-wrap' }}>{exp.publishable}</div>
                  <div style={{ display: 'flex', gap: 8, margin: '8px 0 4px' }}>
                    <button className="opt" onClick={copyText}>{copied ? '已复制' : '复制文本'}</button>
                    <button className="opt" onClick={() => download('text')}>下载正文</button>
                    <button className="opt" onClick={() => download('sources')}>下载来源清单</button>
                  </div>
                </>
              ) : null}

              <h3>内容建议</h3>
              {!report ? (
                <div className="issue">这一版还没有内容建议。</div>
              ) : report.draftVersion !== draft?.version ? (
                <div className="issue">稿件有了新的修改，请稍候。</div>
              ) : report.status !== 'pass' && report.issues.length === 0 ? (
                <div className="issue">这版还需要调整，暂时不能导出。可以让知选重新整理一次。</div>
              ) : report.issues.length === 0 ? (
                <div className="issue">这版可以导出。</div>
              ) : (
                report.issues.map((it, i) => (
                  <div key={i} className={`issue${isBlockingIssue(it) ? ' block' : ''}`}>
                    <q>{it.text}</q>
                    <span className="why">
                      {isBlockingIssue(it) ? '必须处理' : '建议留意'} · {it.location} · {it.reason}（建议：{it.action}）
                    </span>
                  </div>
                ))
              )}

              <h3>产品资料与实际来源</h3>
              {(view?.evidence ?? []).map((e) => (
                <div key={e.id} className={`ev${usedIds.has(e.id) ? ' used' : ''}`}>
                  <div className="id">
                    {e.docTitle}
                    {e.section ? ` · ${e.section}` : ''}
                    {usedIds.has(e.id) ? ' · 本稿引用' : ''}
                  </div>
                  <div>{e.text}</div>
                  <div className="src">{e.source}</div>
                  {e.documentUrl ? <a href={e.documentUrl} target="_blank" rel="noopener noreferrer">查看完整资料</a> : null}
                </div>
              ))}

              <h3>图片来源</h3>
              {(view?.images ?? []).map((im) => (
                <div key={im.id} className="ev">
                  <div>{im.caption}</div>
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
