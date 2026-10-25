import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";

export const defaultSessionsPath = path.join(homedir(), ".paseo", "events", "sessions.json");

export interface AgentSession {
  cwd: string;
  /** Bound when the agent's session opens. */
  agentId?: string;
  createdAt: number;
}

const UNBOUND_TTL_MS = 7 * 24 * 3600 * 1000;

/**
 * Per-agent capability tokens. They let the local proxy endpoint tell agents apart and carry no
 * GitHub access by themselves. Persisted so agents resumed after a daemon restart keep working.
 */
export class SessionStore {
  private sessions: Record<string, AgentSession>;

  constructor(private readonly file: string = defaultSessionsPath) {
    this.sessions = this.load();
    this.prune();
  }

  private load(): Record<string, AgentSession> {
    try {
      return JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  private save() {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.sessions), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  create(cwd: string): string {
    const token = randomBytes(24).toString("base64url");
    this.sessions[token] = { cwd, createdAt: Date.now() };
    this.save();
    return token;
  }

  /** Constant-time lookup. */
  resolve(token: string | undefined): AgentSession | null {
    if (!token) return null;
    const candidate = Buffer.from(token);
    let found: AgentSession | null = null;
    for (const [known, session] of Object.entries(this.sessions)) {
      const k = Buffer.from(known);
      if (k.length === candidate.length && timingSafeEqual(k, candidate)) found = session;
    }
    return found;
  }

  bind(token: string, agentId: string): boolean {
    const session = this.sessions[token];
    if (!session) return false;
    session.agentId = agentId;
    this.save();
    return true;
  }

  forgetAgent(agentId: string) {
    for (const [token, session] of Object.entries(this.sessions)) if (session.agentId === agentId) delete this.sessions[token];
    this.save();
  }

  private prune() {
    const cutoff = Date.now() - UNBOUND_TTL_MS;
    let changed = false;
    for (const [token, session] of Object.entries(this.sessions)) {
      if (!session.agentId && session.createdAt < cutoff) {
        delete this.sessions[token];
        changed = true;
      }
    }
    if (changed) this.save();
  }
}
