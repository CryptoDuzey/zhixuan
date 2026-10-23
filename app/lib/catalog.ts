// 咨询目录独立于创作型号表；正文只经本地知识库 API 读取。
import { loadLocalIndex, readLocalText, type LocalDoc, type ReadResult } from './ima.ts';
import { MODELS, type Evidence, type ModelEntry } from './facts.ts';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface CatalogEntry {
  id: string;
  name: string;
  category: string;
  system?: string;
  level: 'full' | 'discovery';
  creativeModelId?: string;
  docPath: string;
  evidencePaths: string[];
  specsAvailable: boolean;
  note: string;
  officialUrl?: string;
}

export interface CatalogSources {
  loadLocalIndex: () => Promise<LocalDoc[]>;
  readLocalText: (doc: LocalDoc, options?: { refresh?: boolean }) => Promise<ReadResult>;
  models?: readonly ModelEntry[];
}

export interface CatalogEvidenceOptions {
  refresh?: boolean;
  /** 普通问答默认不读取价格正文；询价须显式开启。 */
  wantPrice?: boolean;
}

const DISCOVERY_NOTE = '仅供产品发现，不能据此断言规格、配置、兼容性或服务承诺；需补充该款完整事实及限制。';
const FULL_NOTE = '已有产品事实及卖点与限制；不同系统、配置和款式不得互相继承，创作能力以 creativeModelId 为准。';

function safePath(raw: string): string | undefined {
  const path = raw.replaceAll('\\', '/');
  if (/(?:^|\/)\.\.?(?:\/|$)|机密|待审|归档|(?:^|\/)P4(?:-|\/)/i.test(path)) return;
  const start = path.indexOf('P1-产品参数库/');
  if (start < 0 || (start > 0 && path[start - 1] !== '/')) return;
  return path.slice(start);
}

function title(text: string, fallback: string): string {
  return (text.replace(/^\uFEFF/, '').match(/^#\s+(.+)$/m)?.[1] ?? fallback)
    .replace(/\s*[-－—]\s*产品事实\s*$/, '').trim();
}

function field(text: string, label: string): string | undefined {
  return text.match(new RegExp(`^\\s*[-*]?\\s*${label}[：:]\\s*(.+)$`, 'm'))?.[1]?.trim();
}

function url(text: string): string | undefined {
  return (field(text, '官方页面') ?? field(text, '产品页'))?.match(/https?:\/\/[^\s)）]+/)?.[0];
}

function systemSection(text: string): string | undefined {
  return text.match(/^##\s+操作系统[^\S\r\n]*\r?\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m)?.[1]
    ?.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(' / ') || undefined;
}

function inferredSystem(name: string, category: string, officialUrl?: string): string | undefined {
  if (/鸿蒙|harmonyos/i.test(name) || /鸿蒙.*电脑/.test(category) || /\/harmonyos-computer\//.test(officialUrl ?? '')) return 'HarmonyOS';
  if (/windows/i.test(name)) return 'Windows';
}

function family(system?: string): string {
  if (/harmony|鸿蒙/i.test(system ?? '')) return 'harmony';
  if (/windows/i.test(system ?? '')) return 'windows';
  return (system ?? '').toLowerCase();
}

// 仅消除品牌、排版及明确的系统括注；企业版、SE、代次等款式标识必须保留。
function nameKey(name: string): string {
  return name.toLowerCase().replace(/^huawei\s*/i, '')
    .replace(/[（(](?:鸿蒙版|鸿蒙电脑|windows(?:\s*版)?)[）)]/gi, '')
    .replace(/\s+/g, '');
}

// 价格身份不沿用目录合并规则：系统括注、企业版、代次和款式不可删除。
function priceNameKey(name: string): string {
  return name.toLowerCase().replace(/^huawei\s*/i, '').replace(/（/g, '(').replace(/）/g, ')')
    .replace(/\(鸿蒙电脑\)/g, '(鸿蒙版)').replace(/\s+/g, '');
}

interface RecordEntry {
  entry: CatalogEntry;
  docs: LocalDoc[];
  priceName?: string;
  priceDocs?: LocalDoc[];
}

// The read-only service accepts eight simultaneous reads. Leave room for
// other sessions instead of opening a connection for every catalog entry.
async function readInBatches<T, R>(items: T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let offset = 0; offset < items.length; offset += 4) {
    results.push(...await Promise.all(items.slice(offset, offset + 4).map(read)));
  }
  return results;
}

/** 可注入离线资料源；正式调用使用下方默认实例。 */
export function createCatalog(sources: CatalogSources) {
  const texts = new Map<string, Promise<ReadResult>>();
  let pending: Promise<RecordEntry[]> | undefined;

  async function read(doc: LocalDoc): Promise<ReadResult> {
    let pendingRead = texts.get(doc.id);
    if (!pendingRead) {
      pendingRead = sources.readLocalText(doc);
      texts.set(doc.id, pendingRead);
    }
    try {
      const result = await pendingRead;
      if (!result.ok || !result.text?.trim()) throw new Error(`读取目录资料失败：${doc.path}`);
      return result;
    } catch (error) {
      texts.delete(doc.id);
      throw error;
    }
  }

  async function build(): Promise<RecordEntry[]> {
    const index = (await sources.loadLocalIndex()).flatMap((doc) => {
      const path = safePath(doc.path);
      return path ? [{ ...doc, path }] : [];
    });
    const cards = index.filter((doc) => {
      const match = doc.path.match(/^P1-产品参数库\/07-扩展产品目录\/[^/]+\/(\d+)-([^/]+)\.md$/i);
      return match && Number(match[1]) > 0 && !/索引|目录说明/.test(match[2]);
    });
    const facts = index.filter((doc) =>
      /^P1-产品参数库\/(?:01-鸿蒙电脑|02-MateBook-Windows)\/[^/]+\/产品事实\.md$/.test(doc.path));
    const full = await readInBatches(facts, async (doc): Promise<RecordEntry> => {
      const directory = doc.path.slice(0, -'产品事实.md'.length);
      const limit = index.find((item) => item.path === `${directory}卖点与限制.md`);
      if (!limit) throw new Error(`缺少完整型号限制：${directory}卖点与限制.md`);
      const result = await read(doc);
      await read(limit);
      const text = result.text!;
      const name = title(text, directory.split('/').at(-2)!);
      const system = systemSection(text) ?? (directory.includes('/01-') ? 'HarmonyOS' : 'Windows');
      const models = (sources.models ?? MODELS).filter((item) =>
        item.ready && item.dir && safePath(item.dir) === directory);
      const model = models.length === 1 ? models[0] : undefined;
      return {
        entry: {
          id: `catalog:${doc.id}`, name, category: '笔记本电脑', system,
          level: 'full', ...(model ? { creativeModelId: model.id } : {}),
          docPath: doc.path, evidencePaths: [doc.path, limit.path],
          specsAvailable: true, note: FULL_NOTE, officialUrl: url(text),
        },
        docs: [doc, limit],
      };
    });
    const discovered = await readInBatches(cards, async (doc): Promise<RecordEntry> => {
      const text = (await read(doc)).text!;
      const name = title(text, doc.path.split('/').at(-1)!.replace(/^\d+-|\.md$/g, ''));
      const category = field(text, '产品类别') ?? doc.path.split('/').at(-2)!;
      const officialUrl = url(text);
      const system = field(text, '操作系统') ?? inferredSystem(name, category, officialUrl);
      const matches = full.filter(({ entry }) => nameKey(entry.name) === nameKey(name)
        && (!system || family(system) === family(entry.system)));
      // 无法唯一确定版本时保留发现卡，禁止借用任意相似产品的规格。
      if (matches.length === 1) {
        return {
          entry: { ...matches[0].entry, id: `catalog:${doc.id}`, category },
          docs: matches[0].docs,
          priceName: name,
        };
      }
      return {
        entry: {
          id: `catalog:${doc.id}`, name, category, system, level: 'discovery',
          docPath: doc.path, evidencePaths: [doc.path], specsAvailable: false,
          note: DISCOVERY_NOTE, officialUrl,
        },
        docs: [doc],
      };
    });
    const represented = new Set(discovered.filter(({ entry }) => entry.level === 'full')
      .map(({ entry }) => entry.docPath));
    const records = [...discovered, ...full.filter(({ entry }) => !represented.has(entry.docPath))];
    const unique = new Map<string, RecordEntry>();
    for (const record of records) {
      const key = `${nameKey(record.entry.name)}|${family(record.entry.system)}`;
      const previous = unique.get(key);
      if (!previous || (record.entry.level === 'full' && previous.entry.level !== 'full')) unique.set(key, record);
    }
    const result = [...unique.values()];
    const prices = index.filter(doc => /^P1-产品参数库\/08-官方公开价格快照\/[^/]+\/[^/]+-价格卡\.md$/.test(doc.path));
    for (const record of result) {
      const name = record.priceName ?? record.entry.name;
      record.priceName = name;
      // 未明确系统的重名产品不猜测；重名价格文件也不取第一份。
      const owners = result.filter(other => priceNameKey(other.priceName ?? other.entry.name) === priceNameKey(name));
      const matches = prices.filter(doc => priceNameKey(doc.path.split('/').at(-1)!.replace(/-价格卡\.md$/, '')) === priceNameKey(name));
      const namedSystem = inferredSystem(name, '');
      const conflict = namedSystem && record.entry.system && family(namedSystem) !== family(record.entry.system);
      record.priceDocs = owners.length === 1 && matches.length === 1 && !conflict ? matches : [];
      record.entry.evidencePaths.push(...record.priceDocs.map(doc => doc.path));
    }
    return result;
  }

  function records(): Promise<RecordEntry[]> {
    if (!pending) pending = build().catch((error) => { pending = undefined; throw error; });
    return pending;
  }

  async function loadCatalog(): Promise<CatalogEntry[]> {
    return (await records()).map(({ entry }) => ({ ...entry, evidencePaths: [...entry.evidencePaths] }));
  }

  async function loadCatalogEvidence(id: string, options?: CatalogEvidenceOptions): Promise<Evidence[]> {
    const record = (await records()).find(({ entry }) => entry.id === id);
    if (!record) throw new Error(`未知产品目录 ID：${id}`);
    const evidence: Evidence[] = [];
    const priceDocs = options?.wantPrice ? record.priceDocs ?? [] : [];
    for (const doc of [...record.docs, ...priceDocs]) {
      const result = options?.refresh ? await sources.readLocalText(doc, { refresh: true }) : await read(doc);
      if (!result.ok || !result.text?.trim()) throw new Error(`读取目录资料失败：${doc.path}`);
      const price = priceDocs.includes(doc);
      if (price) {
        const declarations = [field(result.text, 'product_name'), field(result.text, '规范产品名'),
          result.text.match(/^#\s+(.+?)[｜|]官方公开价格卡\s*$/m)?.[1]].filter((value): value is string => !!value);
        if (!declarations.length || declarations.some(name => priceNameKey(name) !== priceNameKey(record.priceName!))) {
          throw new Error(`价格卡产品身份不符：${doc.path}`);
        }
      }
      let section = '';
      result.text!.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((raw, i) => {
        const line = raw.trim();
        if (!line) return;
        if (/^#+\s/.test(line)) { section = line.replace(/^#+\s*/, ''); return; }
        const discovery = !price && record.entry.level === 'discovery';
        evidence.push({
          id: `${id}:E${evidence.length + 1}`, docId: doc.id, docTitle: doc.title,
          docPath: doc.path, line: i + 1, section,
          text: `${discovery ? `${DISCOVERY_NOTE} ` : ''}${section ? `[${section}] ` : ''}${line}`,
          kind: price ? 'price' : discovery || doc.path.endsWith('/卖点与限制.md') ? 'limit' : 'fact',
          source: result.source, readAt: result.readAt,
        });
      });
    }
    return evidence;
  }

  return { loadCatalog, loadCatalogEvidence };
}

const catalog = createCatalog({ loadLocalIndex, readLocalText });
const snapshots = new AsyncLocalStorage<ReturnType<typeof createCatalog>>();

/** One independent discovery snapshot per task; selected evidence still refreshes. */
export function withCatalogSnapshot<T>(task: () => Promise<T>): Promise<T> {
  if (snapshots.getStore()) return task();
  return snapshots.run(createCatalog({
    loadLocalIndex: () => loadLocalIndex({ refresh: true }),
    readLocalText: doc => readLocalText(doc, { refresh: true }),
  }), task);
}

export const loadCatalog = () => (snapshots.getStore() ?? catalog).loadCatalog();
// Production evidence acquisition must cross both text caches and fail closed.
// Task scopes refresh directory membership once and retain it for their own steps.
export const loadCatalogEvidence = (id: string, options?: Pick<CatalogEvidenceOptions, 'wantPrice'>) =>
  (snapshots.getStore() ?? catalog).loadCatalogEvidence(id, { refresh: true, wantPrice: options?.wantPrice });
