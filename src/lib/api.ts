export class ApiError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, message: string, body: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

let currentUser = '';
export function setApiUser(u: string) {
  currentUser = u;
}

export async function api<T>(path: string, opts: { method?: string; json?: unknown; raw?: Blob; headers?: Record<string, string> } = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-user': encodeURIComponent(currentUser), ...(opts.headers ?? {}) };
  let body: BodyInit | undefined;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.raw) {
    headers['content-type'] = 'application/octet-stream';
    body = opts.raw;
  }
  const res = await fetch(`api${path}`, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body });
  if (res.status === 204) return null as T;
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new ApiError(res.status, String(data.error ?? res.statusText), data);
  return data as T;
}
