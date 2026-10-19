import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
export function offlinePage(componentPath, styles) {
  const ts = require('typescript');
  const modules = [];
  const ids = new Map();
  function collect(filename) {
    if (ids.has(filename)) return ids.get(filename);
    const index = modules.length;
    ids.set(filename, index);
    const entry = { code: '', imports: {} };
    modules.push(entry);
    if (filename.endsWith('.css')) return index;
    const source = readFileSync(filename, 'utf8');
    entry.code = /\.tsx?$/.test(filename) ? ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText : source;
    const resolve = createRequire(filename);
    for (const match of entry.code.matchAll(/\brequire\((['"])([^'"]+)\1\)/g)) {
      let dependency;
      try { dependency = resolve.resolve(match[2]); }
      catch {
        try { dependency = resolve.resolve(`${match[2]}.tsx`); }
        catch { dependency = resolve.resolve(`${match[2]}.ts`); }
      }
      entry.imports[match[2]] = collect(dependency);
    }
    return index;
  }
  const component = collect(fileURLToPath(new URL(componentPath, import.meta.url)));
  const react = collect(require.resolve('react'));
  const client = collect(require.resolve('react-dom/client'));
  const script = `const modules=${JSON.stringify(modules)}, cache={};
    function load(id) {
      if (cache[id]) return cache[id].exports;
      const module = cache[id] = {exports:{}}, entry = modules[id];
      new Function('module','exports','require','process',entry.code)(
        module,module.exports,(name)=>load(entry.imports[name]),{env:{NODE_ENV:'production'}});
      return module.exports;
    }
    const React=load(${react});
    load(${client}).createRoot(document.getElementById('root')).render(
      React.createElement(React.StrictMode,null,React.createElement(load(${component}).default)));
  `.replace(/<\/script/gi, '<\\/script');
  const css = styles
    .map((name) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8')).join('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script>${script}</script></body></html>`;
}
