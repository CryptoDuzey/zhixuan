/** Process-wide admission for knowledge HTTP requests, held through body consumption. */
export class KnowledgeReadQueue {
  private active = 0;
  private waiting: { start: () => void }[] = [];
  private limit: number;
  private maxWaiting: number;
  constructor(limit = 4, maxWaiting = 128) {
    this.limit = limit;
    this.maxWaiting = maxWaiting;
  }

  private acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.active--;
        this.waiting.shift()?.start();
      };
      const entry = { start: () => {
        signal.removeEventListener('abort', abort);
        this.active++;
        resolve(release);
      } };
      const abort = () => {
        const index = this.waiting.indexOf(entry);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        signal.removeEventListener('abort', abort);
        reject(signal.reason);
      };
      if (this.active < this.limit) entry.start();
      else if (this.waiting.length >= this.maxWaiting) reject(new Error('资料读取繁忙，请稍后重试。'));
      else {
        this.waiting.push(entry);
        signal.addEventListener('abort', abort, { once: true });
      }
    });
  }

  async run<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal);
    try {
      signal.throwIfAborted();
      return await read();
    } finally { release(); }
  }
}

const shared = globalThis as typeof globalThis & { __zhixuanKnowledgeReads?: KnowledgeReadQueue };
export const knowledgeReads = (shared.__zhixuanKnowledgeReads ??= new KnowledgeReadQueue());
