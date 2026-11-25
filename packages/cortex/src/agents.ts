import { AUTONOMY_LEVELS, type AutonomyLevel } from './types.js';
import { s, ValidationError } from './validator.js';

export interface AgentManifest {
  slug: string;
  name_fa: string;
  name_en?: string;
  description?: string;
  /** Capabilities, e.g. 'research.search'. A trailing '.*' grants a whole domain ('research.*'). */
  capabilities: string[];
  allowedTools: string[];
  /** Permission tags held by the agent, matched against tool permission tags. */
  permissions: string[];
  enabled: boolean;
  /** Higher wins ties (default 0). */
  priority?: number;
  /** Floor autonomy level for every action this agent takes. */
  autonomy?: AutonomyLevel;
  version?: string;
}

const SLUG = /^[a-z0-9][a-z0-9._-]{0,119}$/;

export const agentManifestSchema = s
  .object({
    slug: s.string().regex(SLUG, 'slug must be lowercase [a-z0-9._-], max 120'),
    name_fa: s.string().min(1).max(200),
    name_en: s.string().max(200).optional(),
    description: s.string().max(2000).optional(),
    capabilities: s.array(s.string().min(1).max(100)).min(1).max(64),
    allowedTools: s.array(s.string().min(1).max(100)).max(128).default([]),
    permissions: s.array(s.string().min(1).max(100)).max(64).default([]),
    enabled: s.boolean().default(true),
    priority: s.number().min(-1000).max(1000).optional(),
    autonomy: s.enum(AUTONOMY_LEVELS).optional(),
    version: s.string().max(40).optional(),
  })
  .strict();

/** Insertion into an index of string -> Set<slug>. */
function addIdx(idx: Map<string, Set<string>>, key: string, slug: string) {
  let set = idx.get(key);
  if (!set) idx.set(key, (set = new Set()));
  set.add(slug);
}
function delIdx(idx: Map<string, Set<string>>, key: string, slug: string) {
  const set = idx.get(key);
  if (!set) return;
  set.delete(slug);
  if (set.size === 0) idx.delete(key);
}

/** Domain wildcard key for a capability: 'research.search' -> 'research.*'. */
function domainKey(cap: string): string | undefined {
  const i = cap.indexOf('.');
  return i > 0 ? `${cap.slice(0, i)}.*` : undefined;
}

/**
 * Indexed, in-memory registry of agent manifests. Agents are data, not processes: 100k manifests
 * cost only memory, and lookups go through capability/tool indexes (O(candidates), not O(agents)).
 */
export class AgentRegistry {
  private readonly bySlug = new Map<string, AgentManifest>();
  private readonly byCapability = new Map<string, Set<string>>();
  private readonly byTool = new Map<string, Set<string>>();
  private enabledCount = 0;

  get size() {
    return this.bySlug.size;
  }
  get enabledSize() {
    return this.enabledCount;
  }

  /** Validate and insert/replace a manifest. */
  upsert(input: unknown): AgentManifest {
    const m = agentManifestSchema.parse(input) as AgentManifest;
    m.capabilities = [...new Set(m.capabilities)];
    m.allowedTools = [...new Set(m.allowedTools)];
    m.permissions = [...new Set(m.permissions)];
    if (this.bySlug.has(m.slug)) this.remove(m.slug);
    this.bySlug.set(m.slug, Object.freeze(m) as AgentManifest);
    for (const c of m.capabilities) addIdx(this.byCapability, c, m.slug);
    for (const t of m.allowedTools) addIdx(this.byTool, t, m.slug);
    if (m.enabled) this.enabledCount++;
    return m;
  }

  /** Bulk load. Invalid manifests are collected, not thrown, so one bad file can't block 100k good ones. */
  load(manifests: Iterable<unknown>): { loaded: number; errors: { index: number; slug?: string; message: string }[] } {
    let loaded = 0;
    let index = 0;
    const errors: { index: number; slug?: string; message: string }[] = [];
    for (const m of manifests) {
      try {
        this.upsert(m);
        loaded++;
      } catch (e) {
        const slug = m && typeof m === 'object' && typeof (m as { slug?: unknown }).slug === 'string' ? (m as { slug: string }).slug : undefined;
        errors.push({ index, slug, message: e instanceof ValidationError ? e.message : String(e) });
      }
      index++;
    }
    return { loaded, errors };
  }

  /** Load from a JSON array string or newline-delimited JSON (one manifest per line). */
  loadJson(text: string) {
    const trimmed = text.trim();
    if (trimmed.startsWith('[')) return this.load(JSON.parse(trimmed) as unknown[]);
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
    return this.load(
      (function* () {
        for (const l of lines) {
          try {
            yield JSON.parse(l);
          } catch {
            yield { __invalid_json: l.slice(0, 40) };
          }
        }
      })(),
    );
  }

  remove(slug: string): boolean {
    const m = this.bySlug.get(slug);
    if (!m) return false;
    for (const c of m.capabilities) delIdx(this.byCapability, c, slug);
    for (const t of m.allowedTools) delIdx(this.byTool, t, slug);
    if (m.enabled) this.enabledCount--;
    this.bySlug.delete(slug);
    return true;
  }

  setEnabled(slug: string, enabled: boolean): boolean {
    const m = this.bySlug.get(slug);
    if (!m) return false;
    if (m.enabled !== enabled) this.upsert({ ...m, enabled });
    return true;
  }

  get(slug: string): AgentManifest | undefined {
    return this.bySlug.get(slug);
  }

  /** Slugs that declare the exact capability or its domain wildcard. */
  slugsForCapability(capability: string): Set<string> {
    const exact = this.byCapability.get(capability);
    const dk = domainKey(capability);
    const sets = [exact, dk ? this.byCapability.get(dk) : undefined, this.byCapability.get('*')].filter((x): x is Set<string> => !!x && x.size > 0);
    if (sets.length === 0) return new Set();
    if (sets.length === 1) return sets[0]!;
    const out = new Set<string>();
    for (const st of sets) for (const v of st) out.add(v);
    return out;
  }

  slugsForTool(tool: string): Set<string> {
    return this.byTool.get(tool) ?? new Set();
  }

  hasCapability(m: AgentManifest, capability: string): boolean {
    const dk = domainKey(capability);
    return m.capabilities.includes(capability) || (!!dk && m.capabilities.includes(dk)) || m.capabilities.includes('*');
  }

  *all(): IterableIterator<AgentManifest> {
    yield* this.bySlug.values();
  }
}

export interface RouteRequest {
  capability: string;
  toolNames?: string[];
  preferredSlug?: string | null;
  exclude?: Iterable<string>;
}

export interface RouteResult {
  agent: AgentManifest;
  score: number;
  candidatesScanned: number;
}

interface AgentStats {
  ok: number;
  fail: number;
}

/**
 * Picks the best enabled agent for a subtask. Starts from the smallest index set among the
 * capability and each required tool, then scores at most `maxScan` candidates.
 */
export class AgentRouter {
  private readonly stats = new Map<string, AgentStats>();
  constructor(private readonly registry: AgentRegistry, private readonly opts: { maxScan?: number } = {}) {}

  pick(req: RouteRequest): RouteResult | undefined {
    const tools = req.toolNames ?? [];
    const exclude = new Set(req.exclude ?? []);
    if (req.preferredSlug) {
      const m = this.registry.get(req.preferredSlug);
      if (m && m.enabled && !exclude.has(m.slug) && this.registry.hasCapability(m, req.capability) && tools.every((t) => m.allowedTools.includes(t))) {
        return { agent: m, score: Number.POSITIVE_INFINITY, candidatesScanned: 1 };
      }
    }
    // Choose the smallest seed set to iterate.
    let seed = this.registry.slugsForCapability(req.capability);
    for (const t of tools) {
      const ts = this.registry.slugsForTool(t);
      if (ts.size < seed.size) seed = ts;
    }
    const maxScan = this.opts.maxScan ?? 5000;
    let best: RouteResult | undefined;
    let scanned = 0;
    for (const slug of seed) {
      if (scanned >= maxScan) break;
      scanned++;
      if (exclude.has(slug)) continue;
      const m = this.registry.get(slug);
      if (!m || !m.enabled) continue;
      if (!this.registry.hasCapability(m, req.capability)) continue;
      if (!tools.every((t) => m.allowedTools.includes(t))) continue;
      const score = this.score(m, req.capability);
      if (!best || score > best.score || (score === best.score && m.slug < best.agent.slug)) best = { agent: m, score, candidatesScanned: 0 };
    }
    if (best) best.candidatesScanned = scanned;
    return best;
  }

  /** Feed execution outcomes back so reliable agents rank higher. */
  recordOutcome(slug: string, ok: boolean) {
    const st = this.stats.get(slug) ?? { ok: 0, fail: 0 };
    if (ok) st.ok++;
    else st.fail++;
    this.stats.set(slug, st);
  }

  private score(m: AgentManifest, capability: string): number {
    const exact = m.capabilities.includes(capability) ? 2 : 1; // specialists beat domain generalists
    const st = this.stats.get(m.slug);
    // Laplace-smoothed success rate in [0,1], neutral 0.5 for unknown agents.
    const reliability = st ? (st.ok + 1) / (st.ok + st.fail + 2) : 0.5;
    // Fewer capabilities = more specialised (small bonus).
    const focus = 1 / Math.sqrt(m.capabilities.length);
    return exact * 10 + reliability * 5 + focus + (m.priority ?? 0) * 0.01;
  }
}
