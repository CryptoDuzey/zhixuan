import type { PriceSnapshot } from './price-snapshot.ts';

/** Literal SKU constraints only. Never select a different screen to satisfy a capacity. */
export function selectQuestionPrices(snapshots: readonly PriceSnapshot[], question: string): PriceSnapshot[] {
  question = question.normalize('NFKC');
  const normalize = (value: string) => value.replace(/\s+/g, '').replace(/(?:标准屏|标准版|普通版)/, '标准').replace(/典藏版/, '典藏').replace(/(?:柔光|防窥)(?:屏|版)/, match => match.slice(0, 2)).toLowerCase();
  const tokens: string[] = [];
  const excluded: string[] = [];
  for (const match of question.matchAll(/标准(?:屏|版)?|普通版|防窥(?:屏|版)?|柔光(?:屏|版)?|典藏(?:版)?|(?<![\d.])\d{1,4}(?:\.\d{1,2})?\s*(?:GB|TB|G|T)(?![A-Za-z])|i[3579]-\d{4,5}[A-Z]*/gi)) {
    const prefix = question.slice(0, match.index).split(/[，,。；;！？!?]/).at(-1) ?? '';
    const negative = !/^\d|^i[3579]/i.test(match[0]) && /(?:不要|别|不选|不考虑|排除|不是|不想要)(?:再|拿|用|把)?\s*$/.test(prefix);
    (negative ? excluded : tokens).push(normalize(match[0]));
  }
  const colors = [...new Set(snapshots.flatMap(snapshot => snapshot.configuration.split(/[\/;；,，|]/).map(part => part.trim()).filter(part => /^[\u4e00-\u9fff]{1,6}[灰紫蓝白黑金银绿粉红]$/.test(part))))];
  for (const color of colors) {
    const index = question.indexOf(color);
    if (index < 0) continue;
    const prefix = question.slice(0, index).split(/[，,。；;！？!?]/).at(-1) ?? '';
    (/不要\s*$|别\s*$|不选\s*$/.test(prefix) ? excluded : tokens).push(color);
  }
  const normalized = tokens.map(token => /^\d+(?:\.\d+)?[gt]$/.test(token) ? `${token}b` : token);
  const matching = snapshots.filter(snapshot => !excluded.some(token => normalize(snapshot.configuration).includes(token)) && normalized.every(token => {
    const configuration = snapshot.configuration.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
    return /^\d/.test(token) ? new RegExp(`(?<!\\d)${token.replace('.', '\\.')}(?![a-z\\d])`).test(configuration) : normalize(configuration).includes(token);
  }));
  const groups = new Map<string, PriceSnapshot[]>();
  for (const snapshot of matching) groups.set(snapshot.productName, [...(groups.get(snapshot.productName) ?? []), snapshot]);
  const selected = [...groups.values()].flatMap(rows => {
    const identified = rows.filter(snapshot => snapshot.configurationConfirmed && snapshot.amount);
    return identified.length ? identified : rows;
  });
  const latest = new Map<string, PriceSnapshot>();
  for (const snapshot of selected) {
    const sku = snapshot.configuration.toLowerCase().split(/[\/;；,，|]/).map(part => part.replace(/\s+/g, '')).filter(Boolean).sort().join('/');
    const type = snapshot.priceType.replace(/(?:官方|当前)商城页面价/, '商城页面价');
    const key = `${snapshot.productName}\0${sku}\0${snapshot.amount}\0${snapshot.date.slice(0, 10)}\0${type}\0${snapshot.sourceUrl}`;
    const previous = latest.get(key);
    if (!previous || Date.parse(snapshot.date) > Date.parse(previous.date)) latest.set(key, snapshot);
  }
  const counts = new Map<string, number>();
  return [...latest.values()].filter(snapshot => {
    const count = counts.get(snapshot.productName) ?? 0;
    counts.set(snapshot.productName, count + 1);
    return count < 4;
  });
}
