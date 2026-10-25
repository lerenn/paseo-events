import { EtagCache } from "./cache";
import { normalizeOwner, scrub, tokenKey, type TokenStore } from "./tokens";

export const API = "https://api.github.com";

export class NoTokenError extends Error {
  constructor(readonly owner: string) {
    super(`No GitHub token for ${owner}. Add one in the Events screen.`);
    this.name = "NoTokenError";
  }
}

export class GitHubError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "GitHubError";
  }
}

export class RateLimitedError extends Error {
  constructor(readonly until: number) {
    super(`GitHub rate limit reached; waiting until ${new Date(until).toISOString()}`);
    this.name = "RateLimitedError";
  }
}

/**
 * Read-only GitHub REST client for polling. Picks the token by owner and revalidates every GET
 * with ETags (a 304 costs no rate limit). When a token's budget runs out it refuses further calls
 * until the reset, instead of burning requests.
 */
export class GitHubClient {
  readonly cache = new EtagCache();
  private readonly pausedUntil = new Map<string, number>();
  private readonly lastError = new Map<string, string | null>();

  constructor(
    private readonly tokens: TokenStore,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly base = API,
  ) {}

  errorFor(owner: string): string | null {
    return this.lastError.get(normalizeOwner(owner)) ?? null;
  }

  async get<T = any>(owner: string, path: string, opts: { fresh?: boolean } = {}): Promise<{ data: T; link: string | null }> {
    const o = normalizeOwner(owner);
    const token = this.tokens.get(o);
    if (!token) throw new NoTokenError(o);
    const key = tokenKey(token);
    const paused = this.pausedUntil.get(key);
    if (paused && paused > Date.now()) throw new RateLimitedError(paused);

    const url = `${this.base}${path}`;
    const cacheKey = `${key}:${url}`;
    const cached = opts.fresh ? undefined : this.cache.get(cacheKey);
    const res = await this.fetchImpl(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "paseo-events",
        ...(cached ? { "if-none-match": cached.etag } : {}),
      },
    });
    const remaining = Number(res.headers.get("x-ratelimit-remaining"));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (res.headers.get("x-ratelimit-remaining") !== null && remaining <= 5 && reset) this.pausedUntil.set(key, reset * 1000 + 1000);
    if (res.status === 304 && cached) {
      this.cache.hits++;
      this.lastError.set(o, null);
      return { data: cached.data as T, link: cached.link };
    }
    this.cache.misses++;
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const retry = Number(res.headers.get("retry-after"));
      if ((res.status === 403 || res.status === 429) && (retry || remaining === 0)) {
        this.pausedUntil.set(key, retry ? Date.now() + retry * 1000 : reset * 1000 + 1000);
      }
      const message = data && typeof data === "object" && "message" in data ? String(data.message) : res.statusText;
      const err = scrub(`GitHub ${res.status} on GET ${path}: ${message}`, token);
      this.lastError.set(o, res.status === 401 ? "GitHub rejected this token (401 bad credentials)" : err);
      throw new GitHubError(err, res.status);
    }
    this.lastError.set(o, null);
    const etag = res.headers.get("etag");
    const link = res.headers.get("link");
    if (etag) this.cache.set(cacheKey, { etag, status: res.status, data, link });
    return { data: data as T, link };
  }

  /** Follow `Link: rel="next"` and concatenate array pages. */
  async getAll<T = any>(owner: string, path: string, maxPages = 10): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = path;
    for (let page = 0; next && page < maxPages; page++) {
      const res: { data: T[]; link: string | null } = await this.get<T[]>(owner, next);
      out.push(...res.data);
      const raw = res.link?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
      if (!raw) break;
      const parsed = new URL(raw);
      next = parsed.pathname + parsed.search;
    }
    return out;
  }

  /** Validate a token: `/rate_limit` consumes no budget. */
  async check(owner: string): Promise<void> {
    await this.get(owner, "/rate_limit", { fresh: true });
  }
}
