import type { TokenStore } from "../tokens";
import { scrub } from "../tokens";

/** JSON over HTTP with the secret kept out of error messages. */
export async function fetchJson(fetchImpl: typeof fetch, url: string, init: { method?: string; headers: Record<string, string>; body?: unknown }, secret: string | null): Promise<any> {
  const res = await fetchImpl(url, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", "user-agent": "paseo-events", ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(20_000) as any,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(scrub(`${new URL(url).host} answered ${res.status}: ${text.slice(0, 200)}`, secret));
  return text ? JSON.parse(text) : null;
}

export const secretOf = (store: TokenStore, key: string) => store.get(key);
