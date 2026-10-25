import path from "node:path";
import { homedir } from "node:os";
import type { PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { eventsSettings } from "./shared/events";
import { cancelSubscriptionRpc, clearCredentialRpc, setCredentialRpc, statusRpc } from "./shared/rpc";
import { GitHubClient } from "./server/github";
import { EventsHttp } from "./server/http";
import { CAPABILITY_ENV, injectApplies, injectEvents } from "./server/inject";
import { SubscriptionManager } from "./server/manager";
import { McpServer } from "./server/mcp";
import { CredentialService } from "./server/service";
import { SessionStore } from "./server/sessions";
import { WebhookListener } from "./server/listener";
import { ExternalSource } from "./server/sources/external";
import { GitHubSource } from "./server/sources/github";
import { WebhookSource } from "./server/sources/webhook";
import type { Source } from "./server/sources/types";
import { eventsTools } from "./server/tools";
import { TokenStore } from "./server/tokens";

const DEFAULT_PORT = 47841;

export default function contribute(server: PluginServerContext) {
  const tokens = new TokenStore(path.join(homedir(), ".paseo", "events", "tokens.json"));
  const github = new GitHubClient(tokens);
  const webhookSecrets = new TokenStore(path.join(homedir(), ".paseo", "events", "webhook-secrets.json"));
  const externalSecrets = new TokenStore(path.join(homedir(), ".paseo", "events", "external-secrets.json"));
  const sessions = new SessionStore();
  const settings = server.registerSettings(eventsSettings);

  // Sources are rebuilt from settings: webhook names and external servers are configuration.
  let latest = eventsSettings.schema.parse({});
  const externals = new Map<string, { key: string; source: ExternalSource }>();
  let listenerUrl: string | null = null;
  let listenerError: string | null = null;
  const webhook = new WebhookSource(webhookSecrets, () => latest.webhooks, (name) => void subscriptions.hint((s) => s.source === "webhook" && s.filter.name === name));
  webhook.setListener(() => ({ url: latest.webhookPublicUrl || listenerUrl, error: listenerError }));
  const githubSource = new GitHubSource(github, tokens);
  const external = (id: string) => externals.get(id)?.source;
  const sources = (): Source[] => {
    const wanted = new Set(latest.externalSources.map((e) => e.id));
    for (const id of [...externals.keys()]) if (!wanted.has(id)) externals.delete(id);
    for (const cfg of latest.externalSources) {
      const key = JSON.stringify(cfg);
      if (externals.get(cfg.id)?.key === key) continue;
      const src = new ExternalSource(cfg, () => externalSecrets.get(cfg.id), () => latest.webhookPublicUrl || null);
      void src.refreshTypes();
      externals.set(cfg.id, { key, source: src });
    }
    return [githubSource, webhook, ...[...externals.values()].map((e) => e.source)];
  };

  async function currentSettings() {
    const state = await settings.read();
    latest = state.status === "ready" ? state.values : eventsSettings.schema.parse({});
    return latest;
  }
  const listener = new WebhookListener({ webhook, external });
  let listening: { port: number; bind: string } | null = null;
  async function syncListener() {
    const s = await currentSettings();
    const want = s.webhookPort ? { port: s.webhookPort, bind: s.webhookBind } : null;
    if (JSON.stringify(want) === JSON.stringify(listening)) return;
    await listener.stop();
    listening = want;
    listenerUrl = null;
    listenerError = null;
    if (!want) return;
    try {
      listenerUrl = await listener.start(want.port, want.bind);
    } catch (err) {
      listenerError = `webhook listener cannot listen on ${want.bind}:${want.port}: ${(err as Error).message}`;
      console.error(listenerError);
    }
  }
  void syncListener();
  const stopWatching = settings.subscribe(() => void syncListener());

  // The Paseo API only reaches a plugin through hook and RPC contexts. Keep the first one seen,
  // and let wake-ups wait for it.
  let paseo: PluginHookContext["paseo"] | null = null;
  let paseoReady!: () => void;
  const hasPaseo = new Promise<void>((resolve) => (paseoReady = resolve));
  const capture = (ctx: { paseo: PluginHookContext["paseo"] } | undefined) => {
    if (ctx?.paseo && !paseo) {
      paseo = ctx.paseo;
      paseoReady();
    }
  };

  const subscriptions = new SubscriptionManager({
    sources,
    settings: currentSettings,
    send: async (agentId, text) => {
      await Promise.race([hasPaseo, new Promise((_, reject) => setTimeout(() => reject(new Error("Paseo API not available yet")), 30_000))]);
      await paseo!.agents.ref(agentId).send(text, { activeTurnBehavior: "steer" });
    },
  });
  subscriptions.start();
  const credentials = new CredentialService(github, tokens, webhookSecrets, externalSecrets);
  const http = new EventsHttp({ sessions, mcp: new McpServer(eventsTools), context: () => ({ subscriptions, sources: sources() }) });

  let url: string | null = null;
  let startError: string | null = null;
  const port = Number(process.env.PASEO_EVENTS_PORT ?? DEFAULT_PORT);
  const started = http.start(port).then(
    (u) => {
      url = u;
    },
    (err: Error) => {
      startError = `events cannot listen on 127.0.0.1:${port}: ${err.message}. Set PASEO_EVENTS_PORT on the daemon.`;
      console.error(startError);
    },
  );

  const removeCreate = server.before("agent.create", async ({ request }, ctx) => {
    capture(ctx);
    if (!injectApplies((await currentSettings()).injectInto, request.env)) return;
    await started;
    // Without the endpoint the agent just does not get the tools; creating it must not fail.
    if (!url) return;
    return injectEvents(request, { url, capability: sessions.create(request.config.cwd) });
  });
  const removeOpen = server.before("agent.session_open", ({ request }, ctx) => {
    capture(ctx);
    const capability = request.env[CAPABILITY_ENV];
    if (capability) sessions.bind(capability, request.agentId);
  });
  const removeArchived = server.on("agent.archived", ({ agent }, ctx) => {
    capture(ctx);
    sessions.forgetAgent(agent.id);
    subscriptions.dropAgent(agent.id);
  });

  server.handle(statusRpc, (_input, ctx) => {
    capture(ctx);
    return {
      sources: sources().map((s) => s.status()),
      subscriptions: subscriptions.list().reverse(),
      deliveries: subscriptions.recentDeliveries(),
      endpoint: { url, error: startError },
      factory: false,
      credentials: [
        ...tokens.owners().map((key) => ({ source: "github", key, error: github.errorFor(key) })),
        ...latest.webhooks.map((key) => ({ source: "webhook", key, error: webhookSecrets.has(key) ? null : "No secret set" })),
        ...latest.externalSources.map((e) => ({ source: "external", key: e.id, error: externalSecrets.has(e.id) ? null : "No secret set" })),
      ],
    };
  });
  server.handle(cancelSubscriptionRpc, ({ id }) => {
    subscriptions.cancel(id);
    return {};
  });
  server.handle(setCredentialRpc, async ({ source, key, secret }) => {
    await credentials.set(source, key, secret);
    return {};
  });
  server.handle(clearCredentialRpc, ({ source, key }) => {
    credentials.clear(source, key);
    return {};
  });

  return async () => {
    removeCreate();
    removeOpen();
    removeArchived();
    subscriptions.stop();
    stopWatching();
    await listener.stop();
    await http.stop();
  };
}
