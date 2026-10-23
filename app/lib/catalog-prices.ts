import { resolvePriceProducts, type ProductIdentity, type ProductTurn } from './product-context.ts';
import type { Evidence } from './facts.ts';
import { extractPriceSnapshots, formatPriceSnapshots } from './price-snapshot.ts';
import { selectQuestionPrices } from './price-selection.ts';
import { throwIfStopped } from './agent-runtime.ts';

/** A complete per-product response, independent of the model's chosen shortlist. */
export async function answerCatalogPrices(catalog: readonly ProductIdentity[], question: string, history: readonly ProductTurn[],
  read: (id: string) => Promise<Evidence[]>): Promise<{ reply: string; evidence: Evidence[] } | undefined> {
  const products = resolvePriceProducts(catalog, question, history);
  if (!products.ids.length) return products.needsClarification
    ? { reply: '还没能确定你问的是哪个具体型号。请告诉我完整型号，我再按对应配置查价格。', evidence: [] } : undefined;
  const used = new Map<string, Evidence>();
  const replies = await Promise.all(products.ids.map(async id => {
    const name = catalog.find(item => item.id === id)!.name;
    let evidence: Evidence[];
    try { evidence = await read(id); } catch { throwIfStopped(); return `${name}\n这次没能读到价格资料，暂时无法报价，可以稍后重试。`; }
    const available = extractPriceSnapshots(evidence);
    const selected = selectQuestionPrices(available, question);
    if (selected.length) {
      for (const row of selected) used.set(row.evidence.id, row.evidence);
      return formatPriceSnapshots(selected);
    }
    return `${name}\n${available.length ? '已有价格记录没有明确匹配你这组配置的报价，不能套用其他配置。' : '目前没有读到这款产品的公开价格记录，暂时不能报价。'}`;
  }));
  throwIfStopped();
  return { reply: replies.join('\n\n'), evidence: [...used.values()] };
}
