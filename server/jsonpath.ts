/**
 * The JSONPath subset filters need: `$.a.b`, `$.a[0].b`, `$['a-b']`. No wildcards or filters;
 * a filter matches a path against a value (or a list of accepted values).
 */
export function readJsonPath(root: unknown, path: string): unknown {
  const tokens: (string | number)[] = [];
  const re = /\.([^.[\]]+)|\[(\d+)\]|\[['"]([^'"]+)['"]\]/g;
  const body = path.startsWith("$") ? path.slice(1) : `.${path}`;
  let consumed = 0;
  for (const m of body.matchAll(re)) {
    if (m.index !== consumed) throw new Error(`Unsupported JSONPath: ${path}`);
    consumed += m[0].length;
    tokens.push(m[1] ?? (m[2] !== undefined ? Number(m[2]) : m[3]));
  }
  if (consumed !== body.length) throw new Error(`Unsupported JSONPath: ${path}`);
  let cur: any = root;
  for (const t of tokens) cur = cur == null ? undefined : cur[t];
  return cur;
}

export type MatchSpec = Record<string, string | number | boolean | (string | number | boolean)[]>;

/** Every path in `spec` must equal its value, or be one of the listed values. */
export function matches(payload: unknown, spec: MatchSpec | undefined): boolean {
  for (const [p, want] of Object.entries(spec ?? {})) {
    const got = readJsonPath(payload, p);
    const ok = Array.isArray(want) ? want.some((w) => w === got) : want === got;
    if (!ok) return false;
  }
  return true;
}

export function validateMatch(spec: MatchSpec | undefined) {
  for (const p of Object.keys(spec ?? {})) readJsonPath({}, p);
}
