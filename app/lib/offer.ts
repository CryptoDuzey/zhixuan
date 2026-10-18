// 确定性优惠计算器。任何条件未知就不出金额；赠品不抵现；顺序由调用方显式给定。
// 仅用于逻辑与单测的合成数据，真实稿件只展示带日期的官网快照价，不调用本模块出“到手价”。

export type Known<T> = T | 'unknown';

export interface Offer {
  id: string;
  kind: 'coupon' | 'discount' | 'gift';
  /** coupon：立减金额；discount：折扣率，0.9 表示九折；gift 无金额 */
  value?: number;
  /** 门槛，按应用本优惠前的当前金额判断 */
  threshold?: number;
  /** 优惠封顶（元），仅对 discount 有意义 */
  cap?: number;
  /** 互斥组：同组只能取其一，取对消费者更优者 */
  exclusiveGroup?: string;
  channel: Known<string>;
  validOn: Known<boolean>;
  eligible: Known<boolean>;
}

export interface OfferContext {
  basePrice: Known<number>;
  channel: string;
  /** 优惠叠加顺序（offer id），必须明确 */
  order: string[] | 'unknown';
}

export interface OfferResult {
  computable: boolean;
  amount?: number;
  steps: { id: string; before: number; after: number; note?: string }[];
  skipped: { id: string; reason: string }[];
  missing: string[];
  gifts: string[];
}

function apply(o: Offer, current: number): number {
  if (o.kind === 'coupon') return Math.max(0, current - (o.value ?? 0));
  if (o.kind === 'discount') {
    const cut = current * (1 - (o.value ?? 1));
    return current - (o.cap !== undefined ? Math.min(cut, o.cap) : cut);
  }
  return current;
}

export function computeOffer(ctx: OfferContext, offers: Offer[]): OfferResult {
  const res: OfferResult = { computable: false, steps: [], skipped: [], missing: [], gifts: [] };
  if (ctx.basePrice === 'unknown') res.missing.push('基础价格');
  if (ctx.order === 'unknown') res.missing.push('叠加顺序');
  for (const o of offers) {
    if (o.channel === 'unknown') res.missing.push(`${o.id}：适用渠道`);
    if (o.validOn === 'unknown') res.missing.push(`${o.id}：有效期`);
    if (o.eligible === 'unknown') res.missing.push(`${o.id}：资格`);
  }
  if (res.missing.length) return res;

  const base = ctx.basePrice as number;
  const byId = new Map(offers.map((o) => [o.id, o]));
  const order = ctx.order as string[];
  const unknownIds = order.filter((id) => !byId.has(id));
  if (unknownIds.length) {
    res.missing.push(...unknownIds.map((id) => `${id}：未登记的优惠`));
    return res;
  }

  const usable: Offer[] = [];
  for (const id of order) {
    const o = byId.get(id)!;
    if (o.channel !== ctx.channel) res.skipped.push({ id, reason: `渠道不适用（${o.channel} ≠ ${ctx.channel}）` });
    else if (o.validOn === false) res.skipped.push({ id, reason: '不在有效期' });
    else if (o.eligible === false) res.skipped.push({ id, reason: '资格不满足' });
    else usable.push(o);
  }

  // 互斥组：按顺序以当前金额试算，取更优者
  const groups = new Map<string, Offer[]>();
  for (const o of usable) if (o.exclusiveGroup) groups.set(o.exclusiveGroup, [...(groups.get(o.exclusiveGroup) ?? []), o]);
  const dropped = new Set<string>();
  for (const [g, list] of groups) {
    if (list.length < 2) continue;
    const best = list.reduce((a, b) => (apply(b, base) < apply(a, base) ? b : a));
    for (const o of list) {
      if (o !== best) {
        dropped.add(o.id);
        res.skipped.push({ id: o.id, reason: `与 ${best.id} 互斥（${g}），取更优者` });
      }
    }
  }

  let cur = base;
  for (const o of usable) {
    if (dropped.has(o.id)) continue;
    if (o.kind === 'gift') {
      res.gifts.push(o.id);
      continue;
    }
    if (o.threshold !== undefined && cur < o.threshold) {
      res.skipped.push({ id: o.id, reason: `未达门槛（当前 ${cur} < ${o.threshold}）` });
      continue;
    }
    const next = apply(o, cur);
    res.steps.push({ id: o.id, before: cur, after: next });
    cur = next;
  }
  res.computable = true;
  res.amount = Math.round(cur * 100) / 100;
  return res;
}
