import type { EventObject, SourceView } from "../../shared/events";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface PollResult {
  /** Events beyond the baseline, in order. */
  events: EventObject[];
  /** Baseline after these events, used by persistent subscriptions. */
  baseline: unknown;
  /** Ask for another look sooner than the poll interval (for example while checks settle). */
  recheckInMs?: number | null;
}

export interface WatchContext {
  /** Per-subscription memory that does not need to survive a restart. */
  memo: Record<string, any>;
  now: number;
  /** The caller's working directory, to infer defaults such as the repository. */
  cwd?: string;
}

/**
 * A source of events. The framework owns subscriptions, deadlines, dedupe, batching and delivery;
 * an adapter only knows how to read its service and diff the current state against a baseline.
 * This mirrors a SEP-3415 event source: a typed filter in, `EventObject`s out.
 */
export interface Source {
  id: string;
  name: string;
  /** Event types this source emits. */
  types: readonly string[];
  /** Validate and normalize a filter, for example resolve defaults. Throws UsageError. */
  parseFilter(raw: unknown, ctx: { cwd?: string }): Promise<Record<string, any>>;
  /** Read the current state. `satisfied` answers a once-subscription right away. */
  init(filter: Record<string, any>): Promise<{ baseline: unknown; satisfied?: string }>;
  poll(filter: Record<string, any>, baseline: unknown, ctx: WatchContext): Promise<PollResult>;
  /** Text for the wake-up prompt. Untrusted text must go through `quote`. */
  describe(event: EventObject, filter: Record<string, any>): string;
  /** Used for the timeout notice: a line about the current state, or null. */
  stateLine?(filter: Record<string, any>, baseline: unknown): Promise<string | null>;
  /** Release remote state when a subscription ends. Best effort. */
  close?(filter: Record<string, any>, baseline: unknown): Promise<void>;
  status(): SourceView;
  /** Short label of what a subscription watches, for the screen. */
  label(filter: Record<string, any>): string;
}

const EXCERPT = 600;

/** Untrusted text from a service, quoted and bounded so it reads as data rather than as instructions. */
export function quote(text: string): string {
  const clean = text.replace(/\r/g, "").trim();
  const cut = clean.length > EXCERPT ? `${clean.slice(0, EXCERPT)}… [truncated]` : clean;
  return cut ? cut.split("\n").map((l) => `> ${l}`).join("\n") : "> (empty)";
}
