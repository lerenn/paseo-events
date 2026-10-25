import type { GitHubClient } from "./github";
import { scrub, type TokenStore } from "./tokens";

/** Backs the screen's credential RPCs. Write-only: nothing here returns a secret. */
export class CredentialService {
  constructor(private readonly github: GitHubClient, private readonly tokens: TokenStore) {}

  /** Validate and store. A credential the service rejects is not kept. */
  async set(source: string, key: string, secret: string) {
    if (source !== "github") throw new Error(`Source ${source} has no credentials to set yet.`);
    const previous = this.tokens.get(key);
    this.tokens.set(key, secret);
    try {
      await this.github.check(key);
    } catch (err) {
      if (previous) this.tokens.set(key, previous);
      else this.tokens.clear(key);
      throw new Error(scrub(err instanceof Error ? err.message : String(err), secret.trim()));
    }
  }

  clear(source: string, key: string) {
    if (source === "github") this.tokens.clear(key);
  }
}
