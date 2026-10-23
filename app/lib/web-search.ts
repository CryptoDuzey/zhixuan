import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { reportTool, runSignal, throwIfStopped } from './agent-runtime.ts';

export type WebSearchProvider = 'duckduckgo' | 'bing' | 'none';
export interface WebSearchItem { id: string; title: string; url: string; snippet: string }
export interface WebSearchResult {
  status: 'ready' | 'empty' | 'unavailable';
  query: string;
  searchedAt: string;
  items: WebSearchItem[];
  provider: WebSearchProvider;
}
export interface WebSearchOptions {
  fetch?: typeof fetch;
  /** Per-provider deadline, including reading the response. Maximum 15 seconds. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DDG = 'https://html.duckduckgo.com/html/';
const BING = 'https://www.bing.com/search';
const MAX_BYTES = 1024 * 1024;
const clip = (s: string, length: number) => Array.from(s).slice(0, length).join('');

function decode(s: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, key: string) => {
    if (key[0] !== '#') return named[key.toLowerCase()] ?? entity;
    const n = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
  });
}
function text(s: string, limit: number): string {
  return clip(decode(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim(), limit);
}
function attribute(attrs: string, name: string): string {
  const match = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(attrs);
  return decode(match?.[1] ?? match?.[2] ?? match?.[3] ?? '');
}

/** Only public-looking links are returned; result destinations are never fetched or DNS-resolved. */
function publicUrl(raw: string): string | undefined {
  if (raw.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(raw)) return;
  let url: URL;
  try { url = new URL(raw); } catch { return; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) return;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.includes('%') || /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|home|test|invalid|onion|arpa)$/.test(host)) return;
  const literal = host.replace(/^\[|\]$/g, '');
  const ip = isIP(literal);
  if (ip === 4) {
    const [a, b, c] = literal.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99) || (b === 2)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113)) return;
  } else if (ip === 6) {
    if (!/^[23][0-9a-f]{3}:/.test(literal) || /^2001:(?:db8|0|1[0-9a-f]|2[0-9a-f]):/i.test(literal) || /^2002:/i.test(literal)) return;
  } else if (!host.includes('.') || !/^[a-z0-9.-]+$/.test(host) || !/[a-z]$/.test(host)
    || host.split('.').some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) return;
  url.hostname = host;
  url.hash = '';
  return url.href;
}
function resultLink(href: string): string | undefined {
  if (href.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(href)) return;
  try {
    const url = new URL(href, DDG);
    if (['duckduckgo.com', 'www.duckduckgo.com', 'html.duckduckgo.com'].includes(url.hostname)) {
      if (url.pathname !== '/l/' || !url.searchParams.has('uddg')) return;
      return publicUrl(url.searchParams.get('uddg')!);
    }
    // Relative links are navigation, not search results.
    if (!/^(?:https?:)?\/\//i.test(href)) return;
    return publicUrl(url.href);
  } catch { return; }
}
function item(title: string, url: string | undefined, snippet: string): WebSearchItem | undefined {
  title = text(title, 240);
  if (!title || !url) return;
  return { id: `WEB-${createHash('sha256').update(url).digest('hex').slice(0, 24)}`, title, url, snippet: text(snippet, 1000) };
}
function unique(items: Array<WebSearchItem | undefined>): WebSearchItem[] {
  const seen = new Set<string>();
  return items.filter((value): value is WebSearchItem => {
    if (!value || seen.has(value.url)) return false;
    seen.add(value.url);
    return true;
  }).slice(0, 6);
}
function duckduckgo(html: string): WebSearchItem[] {
  const anchors = [...html.matchAll(/<a\b([^>]{0,8192})>([\s\S]*?)<\/a\s*>/gi)]
    .filter(match => attribute(match[1], 'class').split(/\s+/).includes('result__a'));
  if (!anchors.length && !/class\s*=\s*["'][^"']*(?:no-results|result--no-result)/i.test(html)) throw new Error('Invalid search page');
  return unique(anchors.map((match, i) => {
    const tail = html.slice(match.index! + match[0].length, anchors[i + 1]?.index ?? html.length);
    const snippet = /<(a|div|span)\b([^>]*\bclass\s*=\s*(?:"[^"]*\bresult__snippet\b[^"]*"|'[^']*\bresult__snippet\b[^']*'))[^>]*>([\s\S]*?)<\/\1\s*>/i.exec(tail);
    return item(match[2], resultLink(attribute(match[1], 'href')), snippet?.[3] ?? '');
  }));
}
function bing(xml: string): WebSearchItem[] {
  if (!/<rss\b/i.test(xml) || !/<channel\b/i.test(xml) || !/<\/channel\s*>/i.test(xml) || !/<\/rss\s*>/i.test(xml)
    || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Invalid search feed');
  const field = (body: string, name: string) => new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}\\s*>`, 'i').exec(body)?.[1] ?? '';
  return unique([...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi)].map(match => {
    const link = field(match[1], 'link').replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
    return item(field(match[1], 'title'), publicUrl(decode(link.trim())), field(match[1], 'description'));
  }));
}

/** Enforce cancellation even when an injected transport does not observe its signal. */
async function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}
async function readResponse(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty response');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('Response too large');
    for (;;) {
      const part = await bounded(reader.read(), signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BYTES) throw new Error('Response too large');
      chunks.push(part.value);
    }
    signal.throwIfAborted();
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Keyless search of fixed public endpoints. No article fetching and no model calls. */
export async function searchWeb(query: string, options: WebSearchOptions = {}): Promise<WebSearchResult> {
  query = clip(query.replace(/[\u0000-\u001f\u007f]/g, ' ').trim(), 500);
  const searchedAt = new Date().toISOString();
  const base = { query, searchedAt };
  const parentSignals = [options.signal, runSignal()].filter((s): s is AbortSignal => !!s);
  const parent = parentSignals.length ? AbortSignal.any(parentSignals) : undefined;
  const check = () => { throwIfStopped(); parent?.throwIfAborted(); };
  check();
  if (!query) return { ...base, status: 'empty', items: [], provider: 'none' };
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(15000, Math.floor(options.timeoutMs!))) : 6000;
  const request = options.fetch ?? fetch;
  const started = Date.now();
  reportTool({ type: 'tool', tool: 'knowledge', status: 'started', label: '联网搜索公开资料' });
  let emptyProvider: WebSearchProvider = 'none';
  for (const provider of ['duckduckgo', 'bing'] as const) {
    check();
    const signal = AbortSignal.any([...(parent ? [parent] : []), AbortSignal.timeout(timeoutMs)]);
    const url = new URL(provider === 'duckduckgo' ? DDG : BING);
    if (provider === 'bing') url.searchParams.set('format', 'rss');
    url.searchParams.set('q', query);
    let response: Response | undefined;
    try {
      response = await bounded(request(url.href, { signal, redirect: 'error', cache: 'no-store', credentials: 'omit',
        headers: { accept: provider === 'duckduckgo' ? 'text/html' : 'application/rss+xml, application/xml, text/xml' },
      }), signal);
      check();
      if (!response.ok || response.redirected) throw new Error('Search unavailable');
      const type = response.headers.get('content-type') ?? '';
      if (!(provider === 'duckduckgo' ? /^(?:text\/html|application\/xhtml\+xml)\b/i : /^(?:application\/(?:rss\+xml|xml)|text\/xml)\b/i).test(type)) throw new Error('Invalid search response');
      const content = await readResponse(response, signal);
      check();
      const items = provider === 'duckduckgo' ? duckduckgo(content) : bing(content);
      signal.throwIfAborted();
      if (items.length) {
        reportTool({ type: 'tool', tool: 'knowledge', status: 'completed', label: '已搜索公开网页资料', ms: Date.now() - started });
        return { ...base, status: 'ready', items, provider };
      }
      emptyProvider = provider;
    } catch {
      check(); // Parent cancellation stops fallback as well as the current request.
    } finally { try { void response?.body?.cancel().catch(() => {}); } catch { /* Reader already closed. */ } }
  }
  const status = emptyProvider === 'none' ? 'unavailable' : 'empty';
  reportTool({ type: 'tool', tool: 'knowledge', status: status === 'unavailable' ? 'failed' : 'completed',
    label: status === 'empty' ? '公开网页搜索未找到可用结果' : '公开网页搜索暂不可用', ms: Date.now() - started });
  return { ...base, status, items: [], provider: emptyProvider };
}

/** An explicit refusal to go online takes precedence over recency/price wording. */
export function wantsWebSearch(text: string): boolean {
  if (/(?:不要|不用|不必|无需|不需要|禁止|不许|不能|别|勿|不)(?:再|去|进行|使用|做|用|任何|\s)*(?:联网|上网|网络搜索|互联网|网页搜索|搜索网页)|(?:只|仅)(?:用|查|使用)?(?:本地|知识库|库内)|(?:do\s+not|don't|no|without)\s+(?:web\s+search|internet|browsing|online)/i.test(text)) return false;
  const affirmative = text.replace(/(?:不要|不用|无需|不需要|别)(?:查|看|搜索|查询|的|\s)*(?:最新|现价|实时价格|当前价格)/g, '');
  return /联网|上网(?:查|搜|看)|网上(?:查|搜|找|看)|在线(?:搜索|查找)|网络搜索|互联网搜索|网页搜索|搜索网页|查(?:一下)?网页|最新|现价|实时价格|当前价格|(?:现在|今天|目前|当前).{0,12}(?:多少钱|售价|价格|卖多少)|\b(?:web\s+search|search\s+the\s+web|browse\s+the\s+web)\b/i.test(affirmative);
}
