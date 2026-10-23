import { reportTool, runSignal, throwIfStopped } from './agent-runtime.ts';

export interface OfficialReferencePrice {
  amount: number;
  currency: 'CNY';
  display: string;
  note: string;
  sourceUrl: string;
  kind: 'page-reference';
  isTransactionPrice: false;
  hidden: boolean;
  disclaimer: string;
}
export interface OfficialPageResult {
  status: 'ready' | 'unavailable';
  url: string;
  readAt: string;
  title: string;
  text: string;
  referencePrice?: OfficialReferencePrice;
}
export interface OfficialPageOptions { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number }

const MAX_BYTES = 1024 * 1024;
const MAX_TEXT = 12000;
const HOSTS = new Set(['consumer.huawei.com', 'www.vmall.com', 'item.vmall.com']);
const DISCLAIMER = '网页参考价，不是所选配置的华为商城成交价；页面可能含隐藏的参考价格，不能据此确认现价、库存或优惠。';

function limit(text: string, maximum: number): string {
  const cut = text.slice(0, maximum);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}
function decode(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', yen: '¥' };
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|yen);/gi, (entity, key: string) => {
    if (key[0] !== '#') return named[key.toLowerCase()] ?? entity;
    const n = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
  });
}
const clean = (text: string) => decode(text).replace(/\p{Cf}/gu, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

/** Fixed official hosts AND product-page routes; no caller-provided endpoint or relative URL. */
function allowedUrl(raw: string): string | undefined {
  if (raw.length > 2048 || !/^https:\/\//i.test(raw) || /[\s\\#\u0000-\u001f\u007f]/.test(raw)) return;
  const authority = /^https:\/\/([^/]+)/i.exec(raw)?.[1];
  if (!authority || !/^(?:consumer\.huawei\.com|www\.vmall\.com|item\.vmall\.com)(?::443)?$/i.test(authority)) return;
  let url: URL;
  try { url = new URL(raw); } catch { return; }
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password || url.hash || url.port) return;
  // URL accepts :443 and normalizes it to the empty port. Encoded paths and dot segments are rejected before normalization.
  const rawPath = raw.slice(raw.indexOf('/', raw.indexOf('//') + 2));
  if (/%|(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath)) return;
  if (url.hostname === 'consumer.huawei.com') {
    if (url.search || !/^\/cn\/(?:harmonyos-computer|laptops|phones|tablets|wearables|audio|headphones|routers|monitors|visions|accessories|printers)\/[a-z0-9]+(?:-[a-z0-9]+)*\/(?:specs\/)?$/.test(url.pathname)) return;
  } else if (url.hostname === 'www.vmall.com' && /^\/product\/\d{6,30}\.html$/.test(url.pathname)) {
    if (url.search) return;
  } else {
    if (url.pathname !== '/product/comdetail/index.html') return;
    if (!/^\d{6,30}$/.test(url.searchParams.get('prdId') ?? '') || url.searchParams.getAll('prdId').length !== 1
      || [...url.searchParams].some(([key, value]) => !['prdId', 'cid'].includes(key) || !/^\d{1,30}$/.test(value))
      || url.searchParams.getAll('cid').length > 1) return;
  }
  return url.href;
}

interface Capture { kind: 'price' | 'note' | 'title'; value: string; hidden: boolean; closed: boolean }
interface Frame { tag: string; hidden: boolean; ignored: boolean; anchor: boolean; capture?: Capture }
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'template', 'noscript', 'svg', 'canvas']);

/** Small non-executing HTML reader: bounded tokens, no CSS/JS execution, no remote resources. */
function parse(html: string, url: string): { title: string; text: string; referencePrice?: OfficialReferencePrice } {
  const lower = html.toLowerCase();
  const stack: Frame[] = [];
  const captures: Capture[] = [];
  const visible: string[] = [];
  let cursor = 0, visibleLength = 0;
  const append = (raw: string) => {
    if (!raw) return;
    const value = clean(raw);
    if (!value) return;
    const frame = stack.at(-1);
    if (!frame?.hidden && !frame?.ignored && visibleLength < MAX_TEXT) {
      const part = limit(value, MAX_TEXT - visibleLength);
      visible.push(part); visibleLength += part.length + 1;
    }
    // Capture hidden price/note text separately. Anchors are purchase actions, never part of the amount.
    for (const f of stack) if (f.capture && !(f.capture.kind === 'price' && frame?.anchor)) {
      f.capture.value = limit(f.capture.value + ' ' + value, 1200);
    }
  };
  while (cursor < html.length) {
    const start = html.indexOf('<', cursor);
    if (start < 0) { append(html.slice(cursor)); break; }
    append(html.slice(cursor, start));
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4);
      cursor = end < 0 ? html.length : end + 3;
      continue;
    }
    // Scan > outside attribute quotes; cap tag size and nesting to keep hostile HTML bounded.
    let end = start + 1, quote = '';
    for (; end < html.length && end - start <= 8192; end++) {
      const ch = html[end];
      if (quote) { if (ch === quote) quote = ''; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
    }
    if (end >= html.length || end - start > 8192) throw new Error('Invalid HTML token');
    cursor = end + 1;
    const token = html.slice(start + 1, end);
    if (/^!|^\?/.test(token)) continue;
    const name = /^\s*(\/?)\s*([a-z][a-z0-9:-]*)\b/i.exec(token);
    if (!name) { append('<'); continue; }
    const tag = name[2].toLowerCase();
    if (name[1]) {
      let index = stack.length - 1;
      while (index >= 0 && stack[index].tag !== tag) index--;
      if (index >= 0) {
        if (stack[index].capture) stack[index].capture!.closed = true;
        stack.splice(index);
      }
      continue;
    }
    if (RAW.has(tag)) {
      const close = lower.indexOf(`</${tag}`, cursor);
      const closingEnd = close < 0 ? -1 : html.indexOf('>', close);
      cursor = closingEnd < 0 ? html.length : closingEnd + 1;
      continue;
    }
    const attrs = new Map<string, string>();
    const source = token.slice(name[0].length);
    for (const attr of source.matchAll(/([^\s=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      const key = attr[1].toLowerCase();
      if (!attrs.has(key)) attrs.set(key, decode(attr[2] ?? attr[3] ?? attr[4] ?? ''));
    }
    const parent = stack.at(-1);
    const classes = (attrs.get('class') ?? '').split(/\s+/);
    const hidden = !!parent?.hidden || attrs.has('hidden') || attrs.get('aria-hidden')?.toLowerCase() === 'true'
      || classes.includes('global-style-hide') || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\b/i.test(attrs.get('style') ?? '');
    const ignored = !!parent?.ignored || ['head', 'title'].includes(tag);
    const kind = tag === 'div' && classes.includes('product-buy-btn-price') ? 'price'
      : tag === 'li' && classes.some(c => /^price_note(?:$|[-_])/.test(c)) ? 'note'
        : tag === 'title' ? 'title' : undefined;
    const capture: Capture | undefined = kind ? { kind, value: '', hidden, closed: false } : undefined;
    if (capture) captures.push(capture);
    if (VOID.has(tag) || /\/\s*$/.test(token)) continue;
    if (stack.length >= 256) throw new Error('HTML too deeply nested');
    stack.push({ tag, hidden, ignored, anchor: !!parent?.anchor || tag === 'a', capture });
  }
  const title = limit(clean(captures.find(c => c.kind === 'title' && c.closed)?.value ?? ''), 240);
  const notes = captures.filter(c => c.kind === 'note' && c.closed).map(c => clean(c.value))
    .filter(value => {
      const compact = value.replace(/\s+/g, '');
      return /价格仅供参考/.test(compact) && /(?:具体价格请)?以华为商城展示为准/.test(compact);
    });
  const prices = captures.filter(c => c.kind === 'price' && c.closed).flatMap(c => {
    const display = clean(c.value);
    const match = /^[¥￥]\s*((?:\d{1,3}(?:,\d{3})+|\d{1,8})(?:\.\d{1,2})?)\s*(起)?$/.exec(display);
    if (!match) return [];
    const amount = Number(match[1].replaceAll(',', ''));
    return amount > 0 && amount <= 10000000 ? [{ amount, display, hidden: c.hidden }] : [];
  });
  // Conflicting numbers or a missing official caveat cannot yield a reference quote.
  let referencePrice: OfficialReferencePrice | undefined;
  if (notes.length && prices.length && new Set(prices.map(p => p.amount)).size === 1) {
    referencePrice = { amount: prices[0].amount, currency: 'CNY', display: prices[0].display, note: limit(notes[0], 600),
      sourceUrl: url, kind: 'page-reference', isTransactionPrice: false, hidden: prices.every(p => p.hidden), disclaimer: DISCLAIMER };
  }
  const prefix = referencePrice ? `【网页参考价${referencePrice.hidden ? '；HTML中为隐藏内容' : ''}】${referencePrice.display}。${referencePrice.note.replace(/[。.!！]+$/, '')}。${DISCLAIMER}\n` : '';
  // Price-like numbers without the strict pair remain plain page text, never structured quotes.
  return { title, text: limit(prefix + visible.join(' ').trim(), MAX_TEXT), ...(referencePrice ? { referencePrice } : {}) };
}

async function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}
async function read(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No HTML body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('HTML too large');
    for (;;) {
      const part = await bounded(reader.read(), signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BYTES) throw new Error('HTML too large');
      chunks.push(part.value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function readOfficialPage(url: string, options: OfficialPageOptions = {}): Promise<OfficialPageResult> {
  const readAt = new Date().toISOString();
  const target = allowedUrl(url);
  const unavailable: OfficialPageResult = { status: 'unavailable', url: target ?? '', readAt, title: '', text: '' };
  const parents = [options.signal, runSignal()].filter((s): s is AbortSignal => !!s);
  const parent = parents.length ? AbortSignal.any(parents) : undefined;
  const check = () => { throwIfStopped(); parent?.throwIfAborted(); };
  check();
  if (!target) return unavailable;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(12000, Math.floor(options.timeoutMs!))) : 12000;
  const timerController = new AbortController();
  const timer = setTimeout(() => timerController.abort(new DOMException('Official page timeout', 'TimeoutError')), timeoutMs);
  const signal = AbortSignal.any([...(parent ? [parent] : []), timerController.signal]);
  const started = Date.now();
  let response: Response | undefined;
  reportTool({ type: 'tool', tool: 'knowledge', status: 'started', label: '读取官方产品网页' });
  try {
    const pending = (options.fetch ?? fetch)(target, { signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
      headers: { accept: 'text/html, application/xhtml+xml' } }).then(result => {
      if (signal.aborted) { void result.body?.cancel().catch(() => {}); throw signal.reason; }
      return result;
    });
    response = await bounded(pending, signal);
    check();
    if (!response.ok || response.redirected || (response.url && response.url !== target)
      || !/^(?:text\/html|application\/xhtml\+xml)\b/i.test(response.headers.get('content-type') ?? '')) throw new Error('Official HTML unavailable');
    const html = await read(response, signal);
    check(); signal.throwIfAborted();
    const parsed = parse(html, target);
    check(); signal.throwIfAborted();
    if (!parsed.text) throw new Error('Empty official page');
    reportTool({ type: 'tool', tool: 'knowledge', status: 'completed', label: '已读取官方网页；价格仅作页面参考', ms: Date.now() - started });
    return { ...parsed, status: 'ready', url: target, readAt };
  } catch {
    check();
    reportTool({ type: 'tool', tool: 'knowledge', status: 'failed', label: '官方产品网页暂时无法读取', ms: Date.now() - started });
    return unavailable;
  } finally {
    clearTimeout(timer);
    try { void response?.body?.cancel().catch(() => {}); } catch { /* Stream already closed. */ }
  }
}
