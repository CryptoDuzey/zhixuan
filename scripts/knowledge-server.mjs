// Read-only adapter for an independently obtained, authorized knowledge folder.
// No knowledge documents or credentials are distributed with this repository.
import http from 'node:http';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = process.env.ZHIXUAN_KB_DIR;
if (!root) throw new Error('请设置 ZHIXUAN_KB_DIR，指向已获授权的知识库根目录（包含 P1-产品参数库、P2-卖点话术库）。');
const base = path.resolve(root);
const files = new Map();
async function index(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { await index(full); continue; }
    if (!entry.isFile()) continue;
    const relative = path.relative(base, full).split(path.sep).join('/');
    const bytes = await readFile(full);
    const id = createHash('sha256').update(relative).digest('hex').slice(0, 24);
    files.set(id, {
      id, title: entry.name, path: relative, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      source: '本地已下载知识库', full,
    });
  }
}
await stat(base);
await index(base);
const publicEntry = ({ full, ...entry }) => entry;
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf' };
const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET') return json(res, 405, { error: '仅支持读取' });
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/health') return json(res, 200, { service: 'zhixuan-local-knowledge', files: files.size });
    if (url.pathname === '/documents') return json(res, 200, { items: [...files.values()].map(publicEntry) });
    if (url.pathname === '/document') {
      const doc = files.get(url.searchParams.get('id'));
      if (!doc) return json(res, 404, { error: '文档不存在' });
      res.writeHead(200, { 'content-type': types[path.extname(doc.full).toLowerCase()] || 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(await readFile(doc.full));
    }
    if (url.pathname === '/search') {
      const query = (url.searchParams.get('q') || '').slice(0, 200).toLowerCase();
      const items = [...files.values()].filter((x) => query && x.path.toLowerCase().includes(query)).slice(0, 40).map(publicEntry);
      return json(res, 200, { total: items.length, items, source: '本地已下载知识库' });
    }
    json(res, 404, { error: '可用接口 /health /documents /document /search' });
  } catch { json(res, 500, { error: '本地资料读取失败' }); }
});
const port = Number(process.env.IMA_LOCAL_PORT || 8765);
server.listen(port, '127.0.0.1', () => console.log(`本地只读知识库已就绪：${files.size} 个文件，端口 ${port}`));
