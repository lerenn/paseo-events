export interface CacheEntry {
  etag: string;
  status: number;
  data: unknown;
  link: string | null;
}

/** ETag cache for REST GETs. A 304 from GitHub costs no rate limit, so a hit is nearly free. */
export class EtagCache {
  private readonly entries = new Map<string, CacheEntry>();
  hits = 0;
  misses = 0;

  constructor(private readonly maxEntries = 1000) {}

  get(key: string): CacheEntry | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      // Refresh recency.
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  set(key: string, entry: CacheEntry) {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  delete(key: string) {
    this.entries.delete(key);
  }

  stats() {
    return { entries: this.entries.size, hits: this.hits, misses: this.misses };
  }
}
