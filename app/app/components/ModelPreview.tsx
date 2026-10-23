'use client';

import { useRef, useState } from 'react';
import type { StreamEvent } from '../../lib/agent-stream.ts';

export type ModelPreviewSnapshot = { callId: string; kind: 'answer' | 'draft'; text: string };

/** One instance per request. Preview content never enters saved answers or drafts. */
export class ModelPreviewStream {
  preview: ModelPreviewSnapshot | null = null;
  private runId = '';
  private sequence = -1;
  private callId = '';
  private retired = new Set<string>();
  private halted = false;
  private closed = false;

  close() {
    this.preview = null;
    this.closed = true;
  }

  private clearCall() {
    if (this.callId) this.retired.add(this.callId);
    this.callId = '';
    this.preview = null;
  }

  accept(event: StreamEvent): boolean {
    if (this.closed) return false;
    const state = event.run && typeof event.run === 'object' ? event.run as Record<string, unknown> : undefined;
    const id = event.runId ?? state?.id;
    if (id !== undefined) {
      if (typeof id !== 'string' || !id || id.length > 160 || (this.runId && this.runId !== id)
        || (state?.id !== undefined && state.id !== id)) return false;
      this.runId = id;
    }
    if (event.seq !== undefined) {
      if (!this.runId || !Number.isSafeInteger(event.seq) || (event.seq as number) <= this.sequence) return false;
      this.sequence = event.seq as number;
    }
    if (state && (state.status !== 'running' || state.cancelRequested === true)) {
      this.clearCall();
      this.halted = true;
    }
    if (event.type === 'model_preview' || event.type === 'model_progress') {
      if (this.halted || typeof event.callId !== 'string' || !event.callId || event.callId.length > 200
        || this.retired.has(event.callId)) return false;
      if (event.type === 'model_preview' && (
        typeof event.runId !== 'string' || !Number.isSafeInteger(event.seq)
        || (event.kind !== 'answer' && event.kind !== 'draft')
        || (event.status !== 'generating' && event.status !== 'discarded')
        || typeof event.text !== 'string' || event.text.length > 12_000
      )) return false;
      if (event.type === 'model_progress' && (
        !Number.isSafeInteger(event.characters) || (event.characters as number) < 0
        || (event.mode !== 'stream' && event.mode !== 'buffered')
      )) return false;
      if (this.callId !== event.callId) {
        this.clearCall();
        this.callId = event.callId;
      }
      if (event.type === 'model_preview') {
        if (event.status === 'discarded') this.clearCall();
        else this.preview = {
          callId: event.callId, kind: event.kind as ModelPreviewSnapshot['kind'], text: event.text as string,
        };
      }
    } else if (['step', 'answer', 'draft', 'clarify', 'error', 'done'].includes(event.type)) {
      this.clearCall();
      if (event.type !== 'step') this.halted = true;
      if (event.type === 'done') this.closed = true;
    }
    return true;
  }
}

export function useModelPreview() {
  const stream = useRef(new ModelPreviewStream());
  const [preview, setPreview] = useState<ModelPreviewSnapshot | null>(null);
  function resetPreview() {
    stream.current = new ModelPreviewStream();
    setPreview(null);
  }
  function clearPreview() {
    stream.current.close();
    setPreview(null);
  }
  function receivePreviewEvent(event: StreamEvent) {
    const accepted = stream.current.accept(event);
    if (accepted) setPreview(stream.current.preview);
    return accepted;
  }
  return { preview, resetPreview, clearPreview, receivePreviewEvent };
}

export default function ModelPreview({ preview }: { preview: ModelPreviewSnapshot | null }) {
  if (!preview?.text) return null;
  return (
    <section className="model-preview" aria-label="生成预览" aria-live="off">
      <div className="model-preview-heading">
        <span>{preview.kind === 'draft' ? '正文' : '知选'}</span>
        <span role="status">正在写…</span>
      </div>
      <div key={preview.callId} className="model-preview-text" tabIndex={0} role="region" aria-label="预览内容">
        {preview.text}
      </div>
    </section>
  );
}
