// 会话落盘与前端视图：原始资料仅保存在本机私密目录。
import { join } from 'node:path';
import { newSession, type NeedCard, type Session } from './agent.ts';
import { localImageUrl } from './ima.ts';
import type { CheckReport, Draft } from './check.ts';
import { SessionRepository } from './session-store.ts';
import { isRunActive } from './agent-runtime.ts';
import { currentSceneImages } from './supplementary-images.ts';
import { sceneImageUrl } from './scene-images.ts';

const g = globalThis as unknown as { __zx_repository?: SessionRepository };
export const sessionRepository = (g.__zx_repository ??= new SessionRepository(
  process.env.ZHIXUAN_SESSION_DIR || join(process.cwd(), 'data', 'private', 'sessions'),
  newSession,
));

export function getSession(id: string): Session {
  return sessionRepository.get(id).session;
}
export const hasSession = (id: string) => !!sessionRepository.find(id);

/** 结束写盘失败后，只有恢复状态成功落盘才能解除孤立的忙碌锁。 */
export function recoverSession(id: string) {
  const record = sessionRepository.find(id);
  if (record?.busy && record.run && !isRunActive(id, record.run.id)) {
    const now = new Date().toISOString();
    record.run.status = 'interrupted';
    record.run.updatedAt = now;
    record.run.endedAt = now;
    sessionRepository.finish(id, true);
  }
  return record;
}

export interface SessionView {
  need?: NeedCard;
  draft?: Draft;
  report?: CheckReport;
  evidence: { id: string; docTitle: string; section: string; text: string; kind: string; source: string; readAt: string; documentUrl?: string }[];
  images: { id: string; filename: string; purpose: string; caption: string; width: number; height: number; src: string; source: string }[];
  supplementaryImages?: { id: string; sha256: string; caption: string; src: string; source: string }[];
}

export function toView(s: Session, sessionId?: string): SessionView {
  return {
    need: s.need,
    draft: s.draft,
    report: s.report,
    evidence: (s.evidence ?? []).map((e) => ({ id: e.id, docTitle: e.docTitle, section: e.section, text: e.text, kind: e.kind, source: e.source, readAt: e.readAt,
      ...(/^[a-f0-9]{24}$/.test(e.docId) ? { documentUrl: `/api/knowledge/document?id=${e.docId}` } : {}) })),
    images: (s.images ?? []).map((i) => ({ id: i.id, filename: i.filename, purpose: i.purpose, caption: i.caption, width: i.width, height: i.height, src: localImageUrl(i.docId, i.sha256), source: i.source })),
    ...(sessionId && currentSceneImages(s).length ? { supplementaryImages: currentSceneImages(s).map(image => ({
      id: image.id, sha256: image.sha256, caption: image.caption, src: sceneImageUrl(sessionId, image), source: 'AI 生成（Qwen）',
    })) } : {}),
  };
}
