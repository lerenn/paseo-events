import { useRpc, useSettings, type PluginScreenProps } from "@getpaseo/plugin/client";
import { SettingsInput } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { eventsSettings, type DeliveryView, type SourceView, type SubscriptionView } from "../shared/events";
import { cancelSubscriptionRpc, clearCredentialRpc, setCredentialRpc, statusRpc } from "../shared/rpc";

const STATUS_KEY = ["events", "status"];

const STATE_LABEL = { connected: "Connected", not_configured: "Not configured", error: "Error" } as const;

export function EventsScreen({ theme, layout }: PluginScreenProps) {
  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
  const queryClient = useQueryClient();
  const status = useRpc(statusRpc);
  const query = useQuery({ queryKey: STATUS_KEY, queryFn: () => status({}), refetchInterval: 10_000 });
  const reload = () => queryClient.invalidateQueries({ queryKey: STATUS_KEY });
  const data = query.data;
  const active = data?.subscriptions.filter((s) => s.status === "active") ?? [];

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Events</Text>
      <Text style={styles.statusLine} accessibilityRole="header">
        {data ? `${active.length} active subscription${active.length === 1 ? "" : "s"} · ${data.sources.filter((s) => s.state === "connected").length} of ${data.sources.length} sources connected` : "Loading…"}
      </Text>
      {data?.endpoint.error ? <Text style={styles.error}>{data.endpoint.error}</Text> : null}
      {query.error ? <Text style={styles.error}>{(query.error as Error).message}</Text> : null}

      <Section title="Sources" styles={styles}>
        {data?.sources.map((src) => <SourceCard key={src.id} source={src} credentials={data.credentials} styles={styles} onChanged={reload} />)}
        {data ? <SourceCard source={{ id: "external", name: "External event servers", state: "connected", detail: "Add servers below; each one also appears above." }} credentials={data.credentials} styles={styles} onChanged={reload} /> : null}
      </Section>

      <Section title="Active subscriptions" styles={styles}>
        {active.length === 0 ? <Text style={styles.muted}>No agent is waiting.</Text> : null}
        {active.map((s) => <SubscriptionRow key={s.id} sub={s} styles={styles} onChanged={reload} />)}
      </Section>

      <Section title="Recent deliveries" collapsible summary={`${data?.deliveries.length ?? 0}`} styles={styles}>
        {data?.deliveries.length === 0 ? <Text style={styles.muted}>Nothing delivered yet.</Text> : null}
        {data?.deliveries.map((d, i) => <DeliveryRow key={`${d.at}-${i}`} delivery={d} styles={styles} />)}
      </Section>

      <Section title="Settings" collapsible styles={styles}>
        <SettingsPanel styles={styles} />
        <Text style={styles.muted}>
          Agents reach Events on {data?.endpoint.url ?? "no address (it could not start)"}, this machine only. Set PASEO_EVENTS_PORT for the daemon to change the port.
          {data?.factory ? " Paseo Factory detected." : " Paseo Factory not detected: blueprint delivery is unavailable."}
        </Text>
      </Section>
    </ScrollView>
  );
}

function Section({ title, summary, collapsible, styles, children }: { title: string; summary?: string; collapsible?: boolean; styles: Styles; children: React.ReactNode }) {
  const [open, setOpen] = useState(!collapsible);
  return (
    <View style={styles.panel}>
      {collapsible ? (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={title} onPress={() => setOpen((v) => !v)}>
          <Text style={styles.heading}>{open ? "▾" : "▸"} {title}{summary ? ` · ${summary}` : ""}</Text>
        </Pressable>
      ) : (
        <Text style={styles.heading}>{title}</Text>
      )}
      {open ? children : null}
    </View>
  );
}

type Credential = { source: string; key: string; error: string | null };

/** One source: status, its credentials and its own settings, collapsed by default when it is not configured. */
function SourceCard({ source, credentials, styles, onChanged }: { source: SourceView; credentials: Credential[]; styles: Styles; onChanged(): void }) {
  const [open, setOpen] = useState(source.state === "error");
  const mine = credentials.filter((c) => c.source === source.id);
  return (
    <View style={styles.card}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={source.name} onPress={() => setOpen((v) => !v)}>
        <View style={styles.line}>
          <Text style={styles.name}>{open ? "▾" : "▸"} {source.name}</Text>
          <Text style={styles.badge}>{STATE_LABEL[source.state]}</Text>
        </View>
      </Pressable>
      {source.detail ? <Text style={styles.muted}>{source.detail}</Text> : null}
      {open ? <SourceSettings source={source} credentials={mine} styles={styles} onChanged={onChanged} /> : null}
    </View>
  );
}

function SourceSettings({ source, credentials, styles, onChanged }: { source: SourceView; credentials: Credential[]; styles: Styles; onChanged(): void }) {
  const clear = useRpc(clearCredentialRpc);
  const settings = useSettings(eventsSettings);
  const [error, setError] = useState<string | null>(null);
  const v = settings.status === "ready" ? settings.values : null;
  const save = async (patch: Partial<NonNullable<typeof v>>) => {
    if (!v || settings.status !== "ready") return;
    const parsed = eventsSettings.schema.safeParse({ ...v, ...patch });
    if (!parsed.success) return setError(parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "));
    setError(null);
    await settings.save(parsed.data, settings.revision);
  };
  const credentialRows = credentials.map((c) => (
    <View key={`${c.source}:${c.key}`} style={styles.line}>
      <Text style={[styles.value, styles.grow]}>{c.key === c.source ? "Key" : c.key}{c.error ? ` · ${c.error}` : " · set"}</Text>
      {source.id === "github" ? null : <SecretForm credential={c} label={source.id === "webhook" || source.id === "external" ? "Set secret" : "Replace key"} styles={styles} onChanged={onChanged} />}
      <Button styles={styles} small label="Remove" onPress={() => void clear({ source: c.source, key: c.key }).then(onChanged)} />
    </View>
  ));
  const addKey = (placeholder?: string) => credentials.length === 0 ? <SecretForm credential={{ source: source.id, key: source.id }} label={`Add ${source.name} key`} placeholder={placeholder} styles={styles} onChanged={onChanged} /> : null;
  return (
    <View style={styles.form}>
      {source.id === "github" ? <GitHubTokens styles={styles} onChanged={onChanged} /> : null}
      {credentialRows}
      {source.id === "linear" ? addKey("Linear API key") : null}
      {source.id === "sentry" ? addKey("Sentry auth token") : null}
      {source.id === "datadog" ? addKey("<api key>:<application key>") : null}
      {v && source.id === "sentry" ? <SettingsInput label="Sentry URL" hint="Change for self-hosted installs." initialValue={v.sentryUrl} onChangeText={(t) => t.trim() && void save({ sentryUrl: t.trim() })} /> : null}
      {v && source.id === "datadog" ? <SettingsInput label="Datadog API host" hint="For your site, for example api.datadoghq.eu." initialValue={v.datadogSite} onChangeText={(t) => t.trim() && void save({ datadogSite: t.trim() })} /> : null}
      {v && source.id === "webhook" ? (
        <>
          <SettingsInput label="Webhook names (comma separated)" hint="Then set each one's HMAC secret above." initialValue={v.webhooks.join(", ")} onChangeText={(t) => void save({ webhooks: t.split(",").map((n) => n.trim()).filter(Boolean) })} />
          <SettingsInput label="Listener port (0 = off)" hint="Serves /events/webhook/<name> and /events/push/<source>. Put a tunnel or reverse proxy in front." initialValue={String(v.webhookPort)} onChangeText={(t) => Number.isInteger(Number(t)) && t.trim() && void save({ webhookPort: Number(t) })} />
          <SettingsInput label="Listener bind address" initialValue={v.webhookBind} onChangeText={(t) => t.trim() && void save({ webhookBind: t.trim() })} />
          <SettingsInput label="Public URL" hint="For example https://events.example.com. Also sent to external sources as push callback." initialValue={v.webhookPublicUrl} onChangeText={(t) => void save({ webhookPublicUrl: t.trim() })} />
        </>
      ) : null}
      {v && source.id === "external" ? (
        <SettingsInput label="External sources (id=url, comma separated)" hint="Event servers speaking events/list, events/subscribe, events/poll, events/unsubscribe. Then set each one's header value above." initialValue={v.externalSources.map((e) => `${e.id}=${e.url}`).join(", ")} onChangeText={(t) => void save({ externalSources: t.split(",").map((x) => x.trim()).filter(Boolean).map((x) => { const [id, ...rest] = x.split("="); return { id: id.trim(), name: id.trim(), url: rest.join("=").trim(), authHeader: v.externalSources.find((e) => e.id === id.trim())?.authHeader ?? "authorization" }; }) })} />
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

function GitHubTokens({ styles, onChanged }: { styles: Styles; onChanged(): void }) {
  const set = useRpc(setCredentialRpc);
  const [owner, setOwner] = useState("");
  const [token, setToken] = useState("");
  const [adding, setAdding] = useState(false);
  const save = useMutation({
    mutationFn: () => set({ source: "github", key: owner.trim(), secret: token }),
    onSuccess: () => {
      setToken("");
      setOwner("");
      setAdding(false);
      onChanged();
    },
  });
  if (!adding) return <Button styles={styles} small label="Add GitHub token" onPress={() => setAdding(true)} />;
  return (
    <View style={styles.form}>
      <Text style={styles.label}>One token per owner. Saved on this machine and never shown again; adding an existing owner replaces it.</Text>
      <TextInput style={styles.input} value={owner} onChangeText={setOwner} placeholder="Owner, e.g. lerenn" placeholderTextColor={styles.placeholder.color} autoCapitalize="none" autoCorrect={false} accessibilityLabel="GitHub owner or organization" />
      <TextInput style={styles.input} value={token} onChangeText={setToken} placeholder="Paste token" placeholderTextColor={styles.placeholder.color} secureTextEntry autoCapitalize="none" autoCorrect={false} accessibilityLabel="GitHub token" />
      {save.error ? <Text style={styles.error}>{(save.error as Error).message}</Text> : null}
      <View style={styles.line}>
        <Button styles={styles} small primary disabled={!owner.trim() || !token.trim() || save.isPending} label={save.isPending ? "Checking with GitHub…" : "Save"} onPress={() => save.mutate()} />
        <Button styles={styles} small label="Cancel" onPress={() => setAdding(false)} />
      </View>
    </View>
  );
}

/** Write-only secret for a webhook (HMAC key) or an external source (auth header value). */
function SecretForm({ credential, styles, onChanged, label = "Set secret", placeholder }: { credential: { source: string; key: string }; styles: Styles; onChanged(): void; label?: string; placeholder?: string }) {
  const set = useRpc(setCredentialRpc);
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState("");
  const save = useMutation({
    mutationFn: () => set({ source: credential.source, key: credential.key, secret }),
    onSuccess: () => {
      setSecret("");
      setOpen(false);
      onChanged();
    },
  });
  if (!open) return <Button styles={styles} small label={label} onPress={() => setOpen(true)} />;
  return (
    <View style={styles.form}>
      <TextInput style={styles.input} value={secret} onChangeText={setSecret} placeholder={placeholder ?? ({ webhook: "HMAC secret", external: "Header value, e.g. Bearer …" } as Record<string, string>)[credential.source] ?? "API key or token"} placeholderTextColor={styles.placeholder.color} secureTextEntry autoCapitalize="none" autoCorrect={false} accessibilityLabel={`Secret for ${credential.key}`} />
      {save.error ? <Text style={styles.error}>{(save.error as Error).message}</Text> : null}
      <View style={styles.line}>
        <Button styles={styles} small primary disabled={!secret.trim() || save.isPending} label="Save" onPress={() => save.mutate()} />
        <Button styles={styles} small label="Cancel" onPress={() => setOpen(false)} />
      </View>
    </View>
  );
}

const watching = (s: SubscriptionView) => {
  const f = s.filter;
  const what = f.repo ? `${f.repo}#${f.number}` : JSON.stringify(f);
  return `${s.source} · ${what} · ${(f.types as string[] | undefined)?.join(", ") ?? ""}`;
};

function SubscriptionRow({ sub, styles, onChanged }: { sub: SubscriptionView; styles: Styles; onChanged(): void }) {
  const cancel = useRpc(cancelSubscriptionRpc);
  return (
    <View style={styles.field}>
      <View style={styles.line}>
        <Text style={[styles.value, styles.grow]}>{watching(sub)}</Text>
        <Button styles={styles} small label="Cancel" onPress={() => void cancel({ id: sub.id }).then(onChanged)} />
      </View>
      <Text style={styles.muted}>
        agent {sub.agentId.slice(0, 8)} · {sub.mode} · {sub.deliver.kind === "factory" ? `factory ${sub.deliver.blueprint}` : "wakes the agent"} · expires {new Date(sub.expiresAt).toLocaleTimeString()}
      </Text>
    </View>
  );
}

function DeliveryRow({ delivery, styles }: { delivery: DeliveryView; styles: Styles }) {
  return (
    <View style={styles.field}>
      <View style={styles.line}>
        <Text style={[styles.value, styles.grow]}>{delivery.source} · {delivery.types.join(", ")} → {delivery.target}</Text>
        <Text style={styles.badge}>{delivery.ok ? "Done" : "Failed"}</Text>
        <Text style={styles.muted}>{new Date(delivery.at).toLocaleTimeString()}</Text>
      </View>
      {delivery.detail ? <Text style={styles.muted}>{delivery.detail}</Text> : null}
    </View>
  );
}

function SettingsPanel({ styles }: { styles: Styles }) {
  const settings = useSettings(eventsSettings);
  const [error, setError] = useState<string | null>(null);
  if (settings.status !== "ready") {
    return settings.status === "invalid" || settings.status === "error" ? <Text style={styles.error}>{settings.error}</Text> : null;
  }
  const v = settings.values;
  const save = async (patch: Partial<typeof v>) => {
    const parsed = eventsSettings.schema.safeParse({ ...v, ...patch });
    if (!parsed.success) return setError(parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "));
    setError(null);
    await settings.save(parsed.data, settings.revision);
  };
  const num = (key: "pollSeconds" | "defaultTtlMinutes" | "maxTtlMinutes" | "batchSeconds" | "webhookPort") => (text: string) => {
    const n = Number(text);
    if (text.trim() && Number.isInteger(n)) void save({ [key]: n });
  };
  return (
    <View style={styles.form}>
      <SettingsInput label="Check sources every (seconds)" hint="Minimum 15." initialValue={String(v.pollSeconds)} onChangeText={num("pollSeconds")} />
      <SettingsInput label="Default subscription lifetime (minutes)" initialValue={String(v.defaultTtlMinutes)} onChangeText={num("defaultTtlMinutes")} />
      <SettingsInput label="Longest lifetime an agent can ask for (minutes)" initialValue={String(v.maxTtlMinutes)} onChangeText={num("maxTtlMinutes")} />
      <SettingsInput label="Group events of persistent subscriptions within (seconds)" initialValue={String(v.batchSeconds)} onChangeText={num("batchSeconds")} />
      <SettingsInput label="Add Events tools to new agents (all or opt-in)" hint="opt-in: only agents created with PASEO_EVENTS=on. PASEO_EVENTS=off always opts an agent out." initialValue={v.injectInto} onChangeText={(t) => (t.trim() === "all" || t.trim() === "opt-in") && void save({ injectInto: t.trim() as "all" | "opt-in" })} />
      <SettingsInput label="Default delivery (agent or mail)" hint="mail: events arrive as Agents Mail when it is installed, else as a direct prompt. A subscription's own deliver wins." initialValue={v.defaultDeliver} onChangeText={(t) => (t.trim() === "agent" || t.trim() === "mail") && void save({ defaultDeliver: t.trim() as "agent" | "mail" })} />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {settings.saveError ? <Text style={styles.error}>{settings.saveError}</Text> : null}
    </View>
  );
}

function Button({ styles, label, onPress, primary, small, disabled }: { styles: Styles; label: string; onPress(): void; primary?: boolean; small?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, small && styles.buttonSmall, primary && styles.buttonPrimary, disabled && styles.buttonDisabled]}
    >
      <Text style={[primary ? styles.buttonPrimaryText : styles.buttonText, small && styles.buttonSmallText]}>{label}</Text>
    </Pressable>
  );
}

type Styles = ReturnType<typeof makeStyles>;

function makeStyles(theme: PluginScreenProps["theme"], compact: boolean) {
  const pad = compact ? 16 : 24;
  return {
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    content: { padding: pad, gap: 14 },
    line: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
    grow: { flexShrink: 1, flexGrow: 1 },
    title: { color: theme.colors.foreground, fontSize: compact ? 20 : 24 },
    statusLine: { color: theme.colors.foreground, fontSize: compact ? 14 : 16 },
    heading: { color: theme.colors.foreground, fontSize: 16, fontWeight: "600" as const },
    name: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
    label: { color: theme.colors.foregroundMuted, fontSize: 12 },
    muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
    value: { color: theme.colors.foreground, fontSize: 14 },
    error: { color: theme.colors.foregroundMuted, fontSize: 13, fontStyle: "italic" as const },
    badge: { color: theme.colors.foregroundMuted, fontSize: 12, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
    panel: { gap: 10, padding: 14, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 },
    field: { gap: 4 },
    card: { gap: 6, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface0 },
    form: { gap: 8 },
    placeholder: { color: theme.colors.foregroundMuted },
    input: { minHeight: 36, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface2, color: theme.colors.foreground, fontSize: 14 },
    button: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, alignSelf: "flex-start" as const },
    buttonSmall: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 6 },
    buttonSmallText: { fontSize: 13 },
    buttonDisabled: { opacity: 0.5 },
    buttonPrimary: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
    buttonText: { color: theme.colors.foreground, fontSize: 14 },
    buttonPrimaryText: { color: theme.colors.accentForeground, fontSize: 14 },
  };
}
