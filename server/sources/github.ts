import { z } from "zod";
import type { EventObject, SourceView } from "../../shared/events";
import { GitHubError, NoTokenError, type GitHubClient } from "../github";
import { quote, UsageError, type PollResult, type Source, type WatchContext } from "./types";
import type { TokenStore } from "../tokens";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const GITHUB_TYPES = ["checks_completed", "review_submitted", "pr_merged", "pr_closed", "pr_head_updated", "comment_created"] as const;
export type GitHubType = (typeof GITHUB_TYPES)[number];

export const githubFilterSchema = z.object({
  repo: z.string().optional().describe("owner/name. Defaults to the origin remote of your working directory."),
  number: z.number().int().positive().optional().describe("Pull request number."),
  url: z.string().optional().describe("Pull request URL, instead of repo and number."),
  types: z.array(z.enum(GITHUB_TYPES)).min(1),
  head_sha: z.string().optional().describe("Only consider checks on this commit, instead of the current head."),
  ignore_authors: z.array(z.string()).optional().describe("Logins whose comments and reviews do not count, for example your own."),
});

type Json = Record<string, any>;
type Bucket = "pass" | "fail" | "pending" | "skipping" | "cancel";
interface Check {
  name: string;
  bucket: Bucket;
  link: string;
}

/** What we remember about a pull request; later observations are diffed against it. */
export interface GitHubBaseline {
  headSha: string;
  /** Commit whose finished checks were already reported (or were finished at subscribe time). */
  checksDoneSha: string | null;
  reviewIds: number[];
  commentIds: number[];
  reviewCommentIds: number[];
  merged: boolean;
  closed: boolean;
}

const SETTLE_MS = 20_000;

export function parseRepo(text: string): { owner: string; repo: string } | null {
  const m =
    text.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/) ??
    text.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

function bucketOf(conclusion: string | null, status: string): Bucket {
  if (status !== "completed") return "pending";
  switch (conclusion) {
    case "success":
    case "neutral":
      return "pass";
    case "skipped":
      return "skipping";
    case "cancelled":
      return "cancel";
    default:
      return "fail";
  }
}

export const settled = (checks: Check[] | undefined) => Boolean(checks?.length) && !checks!.some((c) => c.bucket === "pending");

export class GitHubSource implements Source {
  id = "github";
  name = "GitHub";
  types = GITHUB_TYPES;

  constructor(
    private readonly client: GitHubClient,
    private readonly tokens: TokenStore,
    private readonly settleMs = SETTLE_MS,
  ) {}

  async parseFilter(raw: unknown, ctx: { cwd?: string }) {
    const parsed = githubFilterSchema.safeParse(raw);
    if (!parsed.success) throw new UsageError(`Invalid github filter: ${z.prettifyError(parsed.error)}`);
    const f = parsed.data;
    let repo = f.repo ? parseRepo(f.repo) : null;
    let number = f.number;
    if (f.url) {
      const m = f.url.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
      if (!m) throw new UsageError(`Not a pull request URL: ${f.url}`);
      repo = { owner: m[1], repo: m[2] };
      number = Number(m[3]);
    }
    if (f.repo && !repo) throw new UsageError(`Not a repository: ${f.repo}. Use owner/name.`);
    if (!repo && ctx.cwd) {
      try {
        const { stdout } = await run("git", ["-C", ctx.cwd, "remote", "get-url", "origin"]);
        repo = parseRepo(stdout.trim());
      } catch {
        // handled below
      }
    }
    if (!repo) throw new UsageError("Could not infer the repository from the working directory. Pass filter.repo as owner/name.");
    if (!number) throw new UsageError("Pass filter.number (the pull request number) or filter.url.");
    return { repo: `${repo.owner}/${repo.repo}`.toLowerCase(), number, types: [...new Set(f.types)], head_sha: f.head_sha, ignore_authors: f.ignore_authors ?? [] };
  }

  label(filter: Json) {
    return `${filter.repo}#${filter.number}`;
  }

  status(): SourceView {
    const owners = this.tokens.owners();
    if (!owners.length) return { id: this.id, name: this.name, state: "not_configured", detail: "No token yet. Add one per owner." };
    const bad = owners.map((o) => [o, this.client.errorFor(o)] as const).filter(([, e]) => e);
    if (bad.length) return { id: this.id, name: this.name, state: "error", detail: bad.map(([o, e]) => `${o}: ${e}`).join("; ") };
    return { id: this.id, name: this.name, state: "connected", detail: `Tokens for ${owners.join(", ")}` };
  }

  private async checks(owner: string, repo: string, sha: string): Promise<Check[]> {
    const base = `/repos/${owner}/${repo}`;
    let runs: Check[];
    try {
      const data = (await this.client.get<Json>(owner, `${base}/commits/${sha}/check-runs?per_page=100`)).data;
      runs = (data.check_runs as Json[]).map((r) => ({ name: r.name, bucket: bucketOf(r.conclusion, r.status), link: r.html_url ?? "" }));
    } catch (err) {
      if (!(err instanceof GitHubError && err.status === 403)) throw err;
      // Fine-grained tokens without Checks read: use the head's workflow runs.
      const data = (await this.client.get<Json>(owner, `${base}/actions/runs?head_sha=${sha}&per_page=100`)).data;
      runs = (data.workflow_runs as Json[]).map((r) => ({ name: r.name, bucket: bucketOf(r.conclusion, r.status), link: r.html_url ?? "" }));
    }
    let statuses: Json[] = [];
    try {
      statuses = (await this.client.get<Json>(owner, `${base}/commits/${sha}/status`)).data.statuses as Json[];
    } catch (err) {
      if (!(err instanceof GitHubError && err.status === 403)) throw err;
    }
    return [
      ...runs,
      ...statuses.map((s): Check => ({ name: s.context, bucket: s.state === "success" ? "pass" : s.state === "pending" ? "pending" : "fail", link: s.target_url ?? "" })),
    ];
  }

  private async snapshot(filter: Json) {
    const [owner, repo] = (filter.repo as string).split("/");
    const n = filter.number as number;
    const types = new Set<string>(filter.types);
    const base = `/repos/${owner}/${repo}`;
    const pr = (await this.client.get<Json>(owner, `${base}/pulls/${n}`)).data;
    const sha: string = pr.head.sha;
    const checkSha: string = filter.head_sha ?? sha;
    return {
      pr,
      headSha: sha,
      checkSha,
      merged: Boolean(pr.merged_at || pr.merged),
      closed: pr.state === "closed",
      checks: types.has("checks_completed") ? await this.checks(owner, repo, checkSha) : undefined,
      reviews: types.has("review_submitted") ? await this.client.getAll<Json>(owner, `${base}/pulls/${n}/reviews?per_page=100`) : undefined,
      comments: types.has("comment_created") ? await this.client.getAll<Json>(owner, `${base}/issues/${n}/comments?per_page=100`) : undefined,
      reviewComments: types.has("comment_created") ? await this.client.getAll<Json>(owner, `${base}/pulls/${n}/comments?per_page=100`) : undefined,
    };
  }

  async init(filter: Json) {
    const s = await this.snapshot(filter);
    const done = settled(s.checks);
    const baseline: GitHubBaseline = {
      headSha: s.headSha,
      checksDoneSha: done ? s.checkSha : null,
      reviewIds: (s.reviews ?? []).filter((r) => r.state !== "PENDING").map((r) => r.id),
      commentIds: (s.comments ?? []).map((c) => c.id),
      reviewCommentIds: (s.reviewComments ?? []).map((c) => c.id),
      merged: s.merged,
      closed: s.closed,
    };
    const types = filter.types as string[];
    const where = `${filter.repo}#${filter.number}`;
    let satisfied: string | undefined;
    if (types.includes("pr_merged") && s.merged) satisfied = `${where} is already merged.`;
    else if (types.includes("pr_closed") && s.closed && !s.merged) satisfied = `${where} is already closed.`;
    else if (types.includes("checks_completed") && done) {
      const bad = s.checks!.filter((c) => c.bucket === "fail").length;
      satisfied = `Checks on ${where} (commit ${s.checkSha.slice(0, 8)}) have already finished: ${bad ? `${bad} failed` : "all passed"}. Subscribe after the next push to wait for new checks.`;
    }
    return { baseline, satisfied };
  }

  async poll(filter: Json, raw: unknown, ctx: WatchContext): Promise<PollResult> {
    const b = raw as GitHubBaseline;
    const s = await this.snapshot(filter);
    const types = filter.types as string[];
    const subject = `${filter.repo}#${filter.number}`;
    const ignored = new Set((filter.ignore_authors as string[]).map((a) => a.toLowerCase()));
    const by = (u: Json | null | undefined) => u?.login ?? "unknown";
    const time = new Date(ctx.now).toISOString();
    const events: EventObject[] = [];
    const next: GitHubBaseline = { ...b };
    let recheckInMs: number | null = null;
    const ev = (type: GitHubType, id: string, data: Json) => events.push({ id: `github:${subject}:${type}:${id}`, source: "github", type, subject, time, data });

    if (types.includes("pr_head_updated") && s.headSha !== b.headSha) {
      ev("pr_head_updated", s.headSha, { sha: s.headSha, previous: b.headSha });
    }
    next.headSha = s.headSha;

    if (types.includes("pr_merged") && s.merged && !b.merged) {
      ev("pr_merged", String(filter.number), { merged_by: by(s.pr.merged_by), merge_commit: s.pr.merge_commit_sha ?? null });
    }
    if (types.includes("pr_closed") && s.closed && !s.merged && !b.closed) ev("pr_closed", String(filter.number), {});
    next.merged = s.merged;
    next.closed = s.closed;

    if (types.includes("review_submitted")) {
      const seen = new Set(b.reviewIds);
      const fresh = (s.reviews ?? []).filter((r) => !seen.has(r.id) && r.state !== "PENDING" && !ignored.has(by(r.user).toLowerCase()));
      for (const r of fresh) ev("review_submitted", String(r.id), { author: by(r.user), state: r.state, body: r.body ?? "", url: r.html_url });
      // Pending reviews are not marked seen, so they fire when submitted.
      next.reviewIds = [...new Set([...b.reviewIds, ...(s.reviews ?? []).filter((r) => r.state !== "PENDING").map((r) => r.id)])];
    }
    if (types.includes("comment_created")) {
      const seenIssue = new Set(b.commentIds);
      const seenReview = new Set(b.reviewCommentIds);
      for (const c of (s.comments ?? []).filter((c) => !seenIssue.has(c.id) && !ignored.has(by(c.user).toLowerCase()))) {
        ev("comment_created", `i${c.id}`, { author: by(c.user), body: c.body ?? "", url: c.html_url, path: null });
      }
      for (const c of (s.reviewComments ?? []).filter((c) => !seenReview.has(c.id) && !ignored.has(by(c.user).toLowerCase()))) {
        ev("comment_created", `r${c.id}`, { author: by(c.user), body: c.body ?? "", url: c.html_url, path: c.path ?? null });
      }
      next.commentIds = (s.comments ?? []).map((c) => c.id);
      next.reviewCommentIds = (s.reviewComments ?? []).map((c) => c.id);
    }
    if (types.includes("checks_completed")) {
      const done = settled(s.checks);
      const sinceKey = `settledSince:${s.checkSha}`;
      if (!done) {
        delete ctx.memo[sinceKey];
      } else if (b.checksDoneSha !== s.checkSha) {
        ctx.memo[sinceKey] ??= ctx.now;
        const waited = ctx.now - ctx.memo[sinceKey];
        if (waited >= this.settleMs) {
          const checks = s.checks!;
          ev("checks_completed", s.checkSha, {
            sha: s.checkSha,
            overall: checks.some((c) => c.bucket === "fail") ? "fail" : "pass",
            checks: checks.map((c) => ({ name: c.name, bucket: c.bucket, link: c.link })),
          });
          next.checksDoneSha = s.checkSha;
        } else {
          recheckInMs = this.settleMs - waited + 1000;
        }
      }
    }
    return { events, baseline: next, recheckInMs };
  }

  async stateLine(filter: Json): Promise<string | null> {
    try {
      const s = await this.snapshot({ ...filter, types: filter.types.filter((t: string) => t === "checks_completed") });
      const checks = s.checks ? (s.checks.length ? (s.checks.some((c) => c.bucket === "pending") ? "still running" : s.checks.some((c) => c.bucket === "fail") ? "failed" : "passed") : "not reported") : null;
      return `Current state: ${s.merged ? "merged" : s.closed ? "closed" : "open"}, head ${s.headSha.slice(0, 8)}${checks ? `, checks ${checks}` : ""}.`;
    } catch {
      return null;
    }
  }

  describe(e: EventObject): string {
    const d = e.data;
    const head = e.subject;
    switch (e.type) {
      case "checks_completed": {
        const bad = (d.checks as Check[]).filter((c) => c.bucket === "fail" || c.bucket === "cancel");
        return `Checks finished on ${head} (commit ${String(d.sha).slice(0, 8)}): ${d.overall === "pass" ? "all passed" : `${bad.length} failed`}.\n` +
          (d.checks as Check[]).map((c) => `- ${c.name}: ${c.bucket}${c.link ? ` ${c.link}` : ""}`).join("\n");
      }
      case "review_submitted":
        return `Review on ${head} by ${d.author}: ${d.state}${d.url ? ` (${d.url})` : ""}\n${quote(d.body)}`;
      case "pr_merged":
        return `${head} was merged by ${d.merged_by}${d.merge_commit ? ` (commit ${String(d.merge_commit).slice(0, 8)})` : ""}.`;
      case "pr_closed":
        return `${head} was closed without merging.`;
      case "pr_head_updated":
        return `${head} got a new head commit ${String(d.sha).slice(0, 8)} (was ${String(d.previous).slice(0, 8)}).`;
      case "comment_created":
        return `New comment on ${head} by ${d.author}${d.path ? ` on ${d.path}` : ""}${d.url ? ` (${d.url})` : ""}\n${quote(d.body)}`;
      default:
        return `${e.type} on ${head}`;
    }
  }
}

export { NoTokenError };
