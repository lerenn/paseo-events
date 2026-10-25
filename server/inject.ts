import type { PluginBeforeRequests } from "@getpaseo/plugin/server";
import { TOOL_NAMES } from "./tools";

type CreateRequest = PluginBeforeRequests["agent.create"];

export const SERVER_NAME = "events";
export const CAPABILITY_ENV = "PASEO_EVENTS_CAPABILITY";
export const OPT_ENV = "PASEO_EVENTS";

const flag = (env: Record<string, string | undefined> | undefined) => env?.[OPT_ENV]?.trim().toLowerCase();

/** `PASEO_EVENTS=off` always opts out; `injectInto: opt-in` needs `PASEO_EVENTS=on`. */
export function injectApplies(injectInto: "all" | "opt-in", env: Record<string, string | undefined> | undefined): boolean {
  const v = flag(env);
  if (v === "off" || v === "0" || v === "false") return false;
  return injectInto === "all" || v === "on" || v === "1" || v === "true";
}

/** Give a new agent the Events MCP tools (preapproved: they only watch). */
export function injectEvents(request: CreateRequest, o: { url: string; capability: string }): CreateRequest {
  return {
    ...request,
    config: {
      ...request.config,
      mcpServers: {
        ...(request.config.mcpServers ?? {}),
        [SERVER_NAME]: { type: "http", url: `${o.url}/mcp`, headers: { authorization: `Bearer ${o.capability}` }, alwaysLoad: true },
      },
      toolPolicy: {
        preapproved: [
          ...(request.config.toolPolicy?.preapproved ?? []),
          ...TOOL_NAMES.map((tool) => ({ kind: "mcp" as const, server: SERVER_NAME, tool })),
        ],
      },
    },
    env: { ...(request.env ?? {}), [CAPABILITY_ENV]: o.capability },
  };
}
