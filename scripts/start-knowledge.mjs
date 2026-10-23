// Repository-relative default; an explicit authorized data directory still wins.
import { fileURLToPath } from 'node:url';
process.env.ZHIXUAN_KB_DIR ||= fileURLToPath(new URL('../kb/华为PC全板块深度知识库_v7/', import.meta.url));
await import('./knowledge-server.mjs');
