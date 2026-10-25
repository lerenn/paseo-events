import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { deliveryViewSchema, sourceViewSchema, subscriptionViewSchema } from "./events";

export const statusRpc = defineRpc({
  name: "events.status",
  input: z.object({}),
  output: z.object({
    sources: z.array(sourceViewSchema),
    subscriptions: z.array(subscriptionViewSchema),
    deliveries: z.array(deliveryViewSchema),
    endpoint: z.object({ url: z.string().nullable(), error: z.string().nullable() }),
    factory: z.boolean(),
    /** Which credentials are set, never their values. */
    credentials: z.array(z.object({ source: z.string(), key: z.string(), error: z.string().nullable() })),
  }),
});

/** Store a credential for a source (GitHub: per owner). Validated, then never returned. */
export const setCredentialRpc = defineRpc({
  name: "events.set-credential",
  input: z.object({ source: z.string(), key: z.string(), secret: z.string() }),
  output: z.object({}),
});

export const clearCredentialRpc = defineRpc({
  name: "events.clear-credential",
  input: z.object({ source: z.string(), key: z.string() }),
  output: z.object({}),
});

export const cancelSubscriptionRpc = defineRpc({
  name: "events.cancel-subscription",
  input: z.object({ id: z.string() }),
  output: z.object({}),
});
