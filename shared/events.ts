import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** GitHub may be polled no faster than this. */
export const MIN_POLL_SECONDS = 15;

export const eventsSettings = defineSettings({
  id: "events",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Which new agents get the Events MCP tools. PASEO_EVENTS=off always opts an agent out. */
    injectInto: z.enum(["all", "opt-in"]).default("all"),
    /** Polling interval for watched sources. */
    pollSeconds: z.number().int().min(MIN_POLL_SECONDS).default(30),
    /** Applied when a subscription does not ask for a ttl. */
    defaultTtlMinutes: z.number().int().min(1).default(240),
    /** Longest ttl an agent may ask for. */
    maxTtlMinutes: z.number().int().min(1).default(1440),
    /** Persistent subscriptions group the events seen within this window into one wake-up. */
    batchSeconds: z.number().int().min(0).default(20),
  }),
});
export type EventsSettings = z.output<typeof eventsSettings.schema>;

/** SEP-3415 style event: `id` is stable and used for deduplication. */
export interface EventObject {
  id: string;
  source: string;
  type: string;
  subject: string;
  time: string;
  data: Record<string, any>;
}

export const deliverSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent") }),
  z.object({
    kind: z.literal("factory"),
    blueprint: z.string().min(1),
    /** Blueprint var -> JSONPath-like path into the event, for example {"pr": "subject"} or {"sha": "data.sha"}. */
    vars_map: z.record(z.string(), z.string()).default({}),
  }),
]);
export type Deliver = z.infer<typeof deliverSchema>;

export const subscriptionStatusSchema = z.enum(["active", "fired", "timed_out", "cancelled"]);

export const subscriptionViewSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  source: z.string(),
  filter: z.record(z.string(), z.any()),
  deliver: z.record(z.string(), z.any()),
  mode: z.enum(["once", "persistent"]),
  status: subscriptionStatusSchema,
  createdAt: z.string(),
  /** ISO time when the subscription expires. */
  expiresAt: z.string(),
  outcome: z.string().nullable(),
});
export type SubscriptionView = z.infer<typeof subscriptionViewSchema>;

export const deliveryViewSchema = z.object({
  at: z.string(),
  subscriptionId: z.string(),
  source: z.string(),
  types: z.array(z.string()),
  target: z.string(),
  ok: z.boolean(),
  detail: z.string().nullable(),
});
export type DeliveryView = z.infer<typeof deliveryViewSchema>;

export const sourceViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.enum(["connected", "not_configured", "error"]),
  detail: z.string().nullable(),
});
export type SourceView = z.infer<typeof sourceViewSchema>;
