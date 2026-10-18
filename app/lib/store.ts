// 会话存储（进程内）与前端视图：把 Session 转成可序列化、不含服务端路径的结构。
import { newSession, type NeedCard, type Session } from './agent.ts';
import { localImageUrl } from './ima.ts';
import type { CheckReport, Draft } from './check.ts';

const g = globalThis as unknown as { __zx_sessions?: Map<string, Session> };
const sessions = (g.__zx_sessions ??= new Map<string, Session>());

export function getSession(id: string): Session {
  let s = sessions.get(id);
  if (!s) {
    s = newSession();
    sessions.set(id, s);
  }
  return s;
}
export const hasSession = (id: string) => sessions.has(id);

export interface SessionView {
  need?: NeedCard;
  draft?: Draft;
  report?: CheckReport;
  evidence: { id: string; docTitle: string; section: string; text: string; kind: string; source: string; readAt: string }[];
  images: { id: string; filename: string; purpose: string; caption: string; width: number; height: number; src: string; source: string }[];
}

export function toView(s: Session): SessionView {
  return {
    need: s.need,
    draft: s.draft,
    report: s.report,
    evidence: (s.evidence ?? []).map((e) => ({ id: e.id, docTitle: e.docTitle, section: e.section, text: e.text, kind: e.kind, source: e.source, readAt: e.readAt })),
    images: (s.images ?? []).map((i) => ({ id: i.id, filename: i.filename, purpose: i.purpose, caption: i.caption, width: i.width, height: i.height, src: localImageUrl(i.docId), source: i.source })),
  };
}
