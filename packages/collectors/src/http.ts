/** Small fetch helpers: timeouts, bounded retries with backoff, JSON-RPC envelopes. */
export type Fetch = typeof fetch;

export interface HttpOptions {
  fetch?: Fetch;
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
}

export class HttpError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** Bytes and requests downloaded by this process (compressed size when the server reports it). */
export const httpStats = { bytes: 0, requests: 0 };

export async function fetchJson<T>(url: string, init: RequestInit = {}, opts: HttpOptions = {}): Promise<T> {
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const retries = opts.retries ?? 2;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
    try {
      const res = await f(url, { ...init, signal: ctrl.signal, headers: { accept: "application/json", ...(init.headers as Record<string, string>), ...opts.headers } });
      if (res.status === 429 || res.status >= 500) throw new HttpError(`${url} -> HTTP ${res.status}`, res.status);
      if (!res.ok) {
        // 4xx other than 429 will not get better by retrying.
        throw Object.assign(new HttpError(`${url} -> HTTP ${res.status}`, res.status), { fatal: true });
      }
      const text = await res.text();
      httpStats.requests++;
      httpStats.bytes += Number(res.headers.get("content-length")) || text.length;
      return JSON.parse(text) as T;
    } catch (e) {
      lastErr = e;
      if ((e as { fatal?: boolean }).fatal || attempt === retries) break;
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new HttpError(String(lastErr));
}

let rpcId = 0;
export async function jsonRpc<T>(url: string, method: string, params: unknown, opts: HttpOptions = {}): Promise<T> {
  const body = await fetchJson<{ result?: T; error?: { code?: number; message?: string; data?: unknown } }>(
    url,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) },
    opts,
  );
  if (body.error) throw new HttpError(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
  if (body.result === undefined) throw new HttpError(`${method}: empty result`);
  return body.result;
}
