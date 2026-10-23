import type { Evidence } from './facts.ts';

/** One original table row, never a combination of values from different SKUs. */
export interface PriceSnapshot {
  productName: string;
  /** Exact recorded style, including screen/colour/system/CPU when present. */
  configuration: string;
  configurationConfirmed: boolean;
  /** Original row timestamp including its timezone; never Evidence.readAt. */
  date: string;
  priceType: string;
  /** Original page amount including currency; absence is not zero. */
  amount?: string;
  referenceAmount?: string;
  salesStatus: string;
  conditions: string;
  sourceUrl: string;
  evidence: Evidence;
}

const HEADERS = ['核验时间', '精确款式', '价格类型', '页面金额', '参考/划线金额', '库存或销售状态', '条件摘要', '来源'];
const EMPTY = /^(?:[-—–]+|无|暂无|未公开|未公开金额|N\/A|null)?$/i;
const key = (name: string) => name.toLowerCase().replace(/^huawei\s*/i, '')
  .replace(/（/g, '(').replace(/）/g, ')').replace(/\(鸿蒙电脑\)/g, '(鸿蒙版)').replace(/\s+/g, '');

function publicCard(path: string): string | undefined {
  const clean = path.replaceAll('\\', '/');
  if (/(?:^|\/)\.\.?(?:\/|$)|机密|待审|归档|(?:^|\/)P4(?:-|\/)/i.test(clean)) return;
  return clean.match(/(?:^|\/)P1-产品参数库\/08-官方公开价格快照\/[^/]+\/([^/]+)-价格卡\.md$/)?.[1];
}

function raw(e: Evidence): string {
  // Catalog prefixes each line with its section; the original table stays intact.
  return e.text.replace(/^\[[^\]\r\n]*\]\s*/, '').trim();
}

function cells(text: string): string[] | undefined {
  if (!text.startsWith('|') || !text.endsWith('|')) return;
  return text.slice(1, -1).split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
}

function timestamp(value: string): boolean {
  const match = value.match(/^(20\d{2})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, y, m, d, h = '00', min = '00', s = '00'] = match;
  const day = new Date(Date.UTC(+y, +m - 1, +d));
  return day.getUTCFullYear() === +y && day.getUTCMonth() === +m - 1 && day.getUTCDate() === +d
    && +h < 24 && +min < 60 && +s < 60;
}

function amount(value: string): string | undefined {
  if (EMPTY.test(value)) return;
  // Never extract instalment/coupon/stock numbers from free prose or URLs.
  return /^(?:[¥￥$]\s*\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s*(?:元|RMB|CNY))$/i.test(value) ? value : undefined;
}

/**
 * Parse only public price-card table rows. Missing/invalid row date, style,
 * type or source is rejected, even if another row or metadata supplies one.
 * No model or network calls. Non-price evidence is ignored.
 */
export function extractPriceSnapshots(evidence: readonly Evidence[]): PriceSnapshot[] {
  const documents = new Map<string, Evidence[]>();
  for (const e of evidence) {
    if (e.kind !== 'price' || !publicCard(e.docPath)) continue;
    const group = `${e.docId}\0${e.docPath}`;
    const lines = documents.get(group) ?? [];
    lines.push(e);
    documents.set(group, lines);
  }
  const snapshots: PriceSnapshot[] = [];
  for (const lines of documents.values()) {
    lines.sort((a, b) => a.line - b.line);
    const filename = publicCard(lines[0].docPath)!;
    const names = lines.flatMap(e => raw(e).match(/^(?:product_name|[-*]?\s*规范产品名)\s*[:：]\s*(.+)$/)?.[1] ?? []);
    if (names.some(name => key(name) !== key(filename))) continue;
    const productName = names[0] ?? filename;
    let columns: number[] | undefined;
    let section: string | undefined;
    const seen = new Set<string>();
    for (const e of lines) {
      if (e.section !== section) { columns = undefined; section = e.section; }
      const row = cells(raw(e));
      if (!row) continue;
      if (HEADERS.every(label => row.includes(label))) {
        columns = HEADERS.map(label => row.indexOf(label));
        continue;
      }
      if (!columns || columns.some(i => i >= row.length)) continue;
      const [date, configuration, priceType, page, reference, salesStatus, conditions, source] = columns.map(i => row[i]);
      const sourceUrl = source.match(/\]\((https?:\/\/[^\s)]+)\)/)?.[1]
        ?? source.match(/^https?:\/\/[^\s]+$/)?.[0];
      if (!timestamp(date) || EMPTY.test(configuration) || /^(?:[-—–]+)?$/.test(priceType) || !sourceUrl) continue;
      const pageAmount = amount(page);
      // Malformed nonempty amounts fail closed; never reinterpret them as "no price".
      if (!pageAmount && !EMPTY.test(page)) continue;
      if (!pageAmount && !/询价|未公开|无.*价|状态|下架/.test(`${priceType} ${salesStatus}`)) continue;
      const identity = JSON.stringify([date, configuration, priceType, page, reference, salesStatus, conditions, sourceUrl]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      snapshots.push({ productName, configuration,
        configurationConfirmed: !/默认展示|未展开|未明确|待确认|待明确|对应版本|原官网商品ID|商品页已下架/.test(configuration),
        date, priceType, ...(pageAmount ? { amount: pageAmount } : {}),
        ...(amount(reference) ? { referenceAmount: amount(reference) } : {}),
        salesStatus: EMPTY.test(salesStatus) ? '' : salesStatus,
        conditions: EMPTY.test(conditions) ? '' : conditions,
        sourceUrl, evidence: { ...e },
      });
    }
  }
  return snapshots;
}

/** Format selected records without choosing a SKU, cheapest price or current offer. */
export function formatPriceSnapshots(snapshots: readonly PriceSnapshot[]): string {
  if (!snapshots.length) return '';
  const groups = new Map<string, PriceSnapshot[]>();
  for (const row of snapshots) groups.set(row.productName, [...(groups.get(row.productName) ?? []), row]);
  return [...groups].map(([name, rows]) => {
    const amounts = rows.filter(row => row.amount);
    const lines = amounts.map(row => {
      const terms = /条件|搭配|预估|到手/.test(row.priceType) ? row.conditions : row.conditions.split(/[；;]/).filter(part => /优惠券|补贴|会员|支付|教育|学生|以旧换新|搭配|地区|仅限|限定|需.*资格|不含/.test(part) && !/不声称|不能.*补写|不以.*代替/.test(part)).join('；');
      const displayType = row.priceType.replace(/当前/g, '当时');
      return `${row.amount}（${displayType}）｜${row.configuration}${row.configurationConfirmed ? '' : '（具体款式未明确）'}${terms ? `；条件：${terms}` : ''}`;
    });
    const delisted = rows.find(row => /下架/.test(row.salesStatus));
    const inquiry = rows.find(row => /询价/.test(row.priceType));
    if (delisted) lines.push('当时商城记录显示原商品已下架；这份资料没有当前公开商城价。');
    else if (inquiry) lines.push(`需询价，未公开金额。${inquiry.conditions.split(/[；;]/).filter(part => /配置|数量|服务/.test(part)).join('；')}`);
    else if (!amounts.length) lines.push('这份资料未公开金额，暂时没有对应报价。');
    const dates = [...new Set(rows.map(row => row.date.slice(0, 10)))].join('、');
    const sources = [...new Set(rows.map(row => row.sourceUrl))].slice(0, 2);
    return `${name}\n${lines.join('\n')}\n\n以上是${dates}的历史页面记录，不代表当前成交价${amounts.some(row => !row.configurationConfirmed) ? '，也不能套用到其他配置' : ''}。\n${sources.map((url, index) => `[查看来源${sources.length > 1 ? index + 1 : ''}](${url})`).join(' ')}`;
  }).join('\n\n').replaceAll('核验', '确认');
}
