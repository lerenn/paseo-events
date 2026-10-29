import { z } from "zod";
import { deliverSchema } from "../shared/events";
import type { SubscriptionManager } from "./manager";
import { UsageError, type Source } from "./sources/types";

export interface ToolContext {
  agentId: string | null;
  cwd?: string;
  subscriptions: SubscriptionManager;
  sources: Source[];
}

export interface ToolDef {
  name: string;
  description: string;
  input: z.ZodType;
  run(args: any, ctx: ToolContext): Promise<unknown>;
}

export const eventsTools: ToolDef[] = [
  {
    name: "events_subscribe",
    description:
      "Get woken up (you receive a prompt) when something happens in an external service, or when the ttl passes. End your turn after subscribing instead of polling. " +
      "source 'github': filter {repo?, number | url, types[] (checks_completed, review_submitted, pr_merged, pr_closed, pr_head_updated, comment_created), head_sha?, ignore_authors?}. " +
      "Fires once by default (mode 'once') and then ends; mode 'persistent' stays until the ttl and groups events into batches. If the condition already holds you get the answer immediately. " +
      "deliver defaults to the host's setting. {kind:'agent'} wakes you with a prompt that lands mid-turn, but when Agents Mail is installed it is always turned into {kind:'mail'} to you. {kind:'mail', to?} sends an Agents Mail (to defaults to you; an agent id, title or @alias; one mail per batch, subject 'Event: <source> <type> <ref>'), " +
      "which you read when idle; if Agents Mail is not installed or not answering, the prompt is sent directly. {kind:'factory', blueprint, vars_map} starts a Paseo Factory blueprint instead, when Factory is installed.",
    input: z.object({
      source: z.string().describe("Event source id, see events_sources. For example 'github'."),
      filter: z.record(z.string(), z.any()).describe("Source-specific filter."),
      deliver: deliverSchema.optional(),
      ttl_seconds: z.number().int().min(30).optional().describe("Deadline. You are woken with an expiry notice if nothing happened. Defaults to the host's setting."),
      mode: z.enum(["once", "persistent"]).optional(),
    }),
    async run({ source, filter, deliver, ttl_seconds, mode }, ctx) {
      return ctx.subscriptions.subscribe({ agentId: ctx.agentId, cwd: ctx.cwd }, { source, filter, deliver, ttlSeconds: ttl_seconds, mode });
    },
  },
  {
    name: "events_list",
    description: "List your subscriptions, active and recently finished.",
    input: z.object({ source: z.string().optional(), status: z.enum(["active", "fired", "timed_out", "cancelled"]).optional() }),
    async run({ source, status }, ctx) {
      return ctx.subscriptions.list(ctx.agentId ?? undefined).filter((s) => (!source || s.source === source) && (!status || s.status === status));
    },
  },
  {
    name: "events_unsubscribe",
    description: "Cancel one of your active subscriptions.",
    input: z.object({ id: z.string() }),
    async run({ id }, ctx) {
      if (!ctx.subscriptions.cancel(id, ctx.agentId ?? undefined)) throw new UsageError(`No active subscription ${id} for this agent.`);
      return { cancelled: id };
    },
  },
  {
    name: "events_sources",
    description: "The event sources, their event types and whether they are connected.",
    input: z.object({}),
    async run(_args, ctx) {
      return ctx.sources.map((s) => ({ ...s.status(), types: s.types }));
    },
  },
];

export const TOOL_NAMES = eventsTools.map((t) => t.name);
