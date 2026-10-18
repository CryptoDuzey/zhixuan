'use client';
import { useEffect, useState } from 'react';

export default function ModelSettings({ onClose }: { onClose: () => void }) {
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [configured, setConfigured] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('正在读取本机设置…');

  useEffect(() => {
    let active = true;
    fetch('/api/settings', { cache: 'no-store' })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '设置读取失败');
        if (active) {
          setBaseUrl(data.baseUrl || '');
          setModel(data.model || '');
          setConfigured(!!data.configured);
          setMessage(data.configured ? '已有本机密钥，可直接测试连接。' : '请填写网关和密钥。');
        }
      })
      .catch((e) => active && setMessage(e.message))
      .finally(() => {});
    return () => { active = false; };
  }, []);

  async function act(action: 'models' | 'test' | 'save') {
    if (busy) return;
    setBusy(true);
    setMessage(action === 'models' ? '正在查询网关可用模型…' : action === 'test' ? '正在测试连接…' : '正在保存到本机…');
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, baseUrl, model, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || data.message || '操作失败');
      if (action === 'models') {
        const list = (data.models || []).map((m: string | { id: string }) => typeof m === 'string' ? m : m.id).filter(Boolean);
        setModels(list);
        setMessage(`已读取 ${list.length} 个可用模型，可搜索 GPT。`);
      } else if (action === 'save') {
        setApiKey('');
        setConfigured(true);
        setMessage('已保存在本机，下次创作会使用这个模型。');
      } else {
        setMessage(data.message || `连接成功，模型：${data.model || model}`);
      }
    } catch (e: unknown) {
      setMessage(e instanceof Error ? e.message : '请求失败，请检查设置。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="sheet-back" onClick={() => !busy && onClose()} />
      <aside className="sheet model-settings" role="dialog" aria-modal="true" aria-label="模型设置">
        <div className="sheet-head"><span>模型设置</span><button disabled={busy} onClick={onClose}>关闭</button></div>
        <div className="sheet-body">
          <p className="settings-intro">连接你的模型，让知选替你完成创作。</p>
          <label>API 网关<input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://你的网关/v1" disabled={busy} autoComplete="off" /></label>
          <label>API Key<input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={configured ? '已配置，留空继续使用本机密钥' : '填写密钥'} disabled={busy} autoComplete="new-password" /></label>
          <label>模型<input list="available-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder="选择或填写模型名称" disabled={busy} autoComplete="off" /></label>
          <datalist id="available-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
          <div className="settings-actions">
            <button className="opt" disabled={busy || !baseUrl.trim()} onClick={() => act('models')}>读取模型列表</button>
            <button className="opt" disabled={busy || !model.trim()} onClick={() => act('test')}>测试连接</button>
            <button className="opt settings-save" disabled={busy || !model.trim()} onClick={() => act('save')}>保存设置</button>
          </div>
          <p className="settings-message" role="status">{message}</p>
          <p className="src">密钥保存在本机服务端，不在页面回显，不进入稿件或导出报告。请求会发送给你指定的网关。</p>
        </div>
      </aside>
    </>
  );
}
