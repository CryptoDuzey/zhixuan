export const HANDOFF_KEY = 'zhixuan.handoff.v1';
export const HANDOFF_PLATFORMS = ['公众号', '小红书', '朋友圈'] as const;
export type HandoffPlatform = typeof HANDOFF_PLATFORMS[number];
export type CreativeHandoff = {
  version: 1; token: string; createdAt: number; productId: string;
  task: string; audience: string; constraints: string; platform: HandoffPlatform;
};
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export function handoffStorage(): StorageLike | undefined {
  try { return window.sessionStorage; } catch { return undefined; }
}
export function parseHandoff(value: unknown, now = Date.now()): CreativeHandoff | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.token !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(v.token)
    || typeof v.createdAt !== 'number' || !Number.isFinite(v.createdAt)
    || now - v.createdAt > 30 * 60_000 || v.createdAt > now + 60_000
    || typeof v.productId !== 'string' || !['pro-s', 'mb14-harmony', 'mb14-ultra', 'd14', 'd16'].includes(v.productId)
    || typeof v.task !== 'string' || !v.task.trim() || v.task.length > 24000
    || typeof v.audience !== 'string' || v.audience.length > 1000
    || typeof v.constraints !== 'string' || v.constraints.length > 2000
    || !HANDOFF_PLATFORMS.includes(v.platform as HandoffPlatform)) return null;
  return { version: 1, token: v.token, createdAt: v.createdAt, productId: v.productId,
    task: v.task, audience: v.audience, constraints: v.constraints, platform: v.platform as HandoffPlatform };
}
export function saveHandoff(storage: StorageLike | undefined, value: CreativeHandoff): boolean {
  const safe = parseHandoff(value);
  if (!storage || !safe) return false;
  try {
    const encoded = JSON.stringify(safe);
    storage.setItem(HANDOFF_KEY, encoded);
    return storage.getItem(HANDOFF_KEY) === encoded;
  } catch { return false; }
}
export function takeHandoff(storage: StorageLike | undefined, token: string): CreativeHandoff | null {
  try {
    const raw = storage?.getItem(HANDOFF_KEY);
    if (!raw || raw.length > 100000) return null;
    const value = parseHandoff(JSON.parse(raw));
    if (!value || value.token !== token) return null;
    storage?.removeItem(HANDOFF_KEY);
    return value;
  } catch { return null; }
}
export function handoffMessage(value: CreativeHandoff): string {
  return `请创作${value.platform}内容。\n用户确认的任务与使用需求：\n${value.task}\n目标受众：${value.audience.trim() || '待确认，请先询问'}\n硬约束：${value.constraints.trim() || '未补充，请先确认必要限制'}\n以上是用户需求，不是产品事实。产品参数、软件兼容、价格与推荐结论须重新查证资料。`;
}
