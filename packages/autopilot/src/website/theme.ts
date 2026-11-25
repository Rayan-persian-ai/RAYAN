import type { ApprovalGate } from "../approval/approval.js";
import type { CalendarEvent } from "../calendar/events.js";
import { THEME_PALETTES, themeFor } from "../campaign/templates.js";
import { bestTextColor, contrastRatio, isHexColor, normalizeHex } from "../util/color.js";
import { randomId } from "../util/hash.js";
import type { SiteEnvironment, Snapshot, ThemeTokens, WebsiteVersioning } from "./versioning.js";

export interface TokenChange {
  token: string;
  from: string | null;
  to: string;
}

export interface ContrastCheck {
  foreground: string;
  background: string;
  ratio: number;
  passesAA: boolean; // >= 4.5 for body text
}

export interface ThemeProposal {
  id: string;
  siteId: string;
  status: "pending_approval";
  reason: string;
  baseSnapshotId: string | null;
  changes: TokenChange[];
  proposedTokens: ThemeTokens;
  contrast: ContrastCheck[];
  warnings: string[];
  createdAt: string;
}

/** Token pairs (foreground, background) checked for WCAG AA. */
export const CONTRAST_PAIRS: [string, string][] = [
  ["color.text", "color.background"],
  ["color.onPrimary", "color.primary"],
  ["color.onAccent", "color.accent"],
];

const COLOR_TOKEN = /^color\./;

export function themeTokensForEvent(event: CalendarEvent, current: ThemeTokens): ThemeTokens {
  const p = THEME_PALETTES[themeFor(event)];
  const out: ThemeTokens = { "color.primary": p.to, "color.accent": p.accent };
  out["color.onPrimary"] = bestTextColor(p.to);
  out["color.onAccent"] = bestTextColor(p.accent);
  // keep only tokens the site actually uses (plus the core ones)
  return Object.fromEntries(Object.entries(out).filter(([k]) => k in current || k === "color.primary" || k === "color.accent"));
}

/**
 * Build a theme-token change PROPOSAL (never applied here). Either pass explicit `changes`
 * or an `event` to derive a seasonal palette. Validates hex colors and checks contrast.
 */
export function proposeThemeChange(input: {
  siteId: string;
  current: ThemeTokens;
  baseSnapshotId?: string | null;
  changes?: ThemeTokens;
  event?: CalendarEvent;
  reason?: string;
  now?: Date;
}): ThemeProposal {
  const requested = { ...(input.event ? themeTokensForEvent(input.event, input.current) : {}), ...(input.changes ?? {}) };
  if (Object.keys(requested).length === 0) throw new Error("No theme changes requested");
  const warnings: string[] = [];
  const changes: TokenChange[] = [];
  for (const [token, raw] of Object.entries(requested)) {
    let value = raw.trim();
    if (COLOR_TOKEN.test(token)) {
      if (!isHexColor(value)) throw new Error(`Token ${token} must be a hex color, got "${raw}"`);
      value = normalizeHex(value);
    } else if (/[<>{};]/.test(value)) {
      throw new Error(`Token ${token} contains forbidden characters`);
    }
    const from = input.current[token] ?? null;
    if (from !== value) changes.push({ token, from, to: value });
  }
  const proposed: ThemeTokens = { ...input.current };
  for (const c of changes) proposed[c.token] = c.to;
  const contrast: ContrastCheck[] = [];
  for (const [fg, bg] of CONTRAST_PAIRS) {
    const f = proposed[fg];
    const b = proposed[bg];
    if (!f || !b || !isHexColor(f) || !isHexColor(b)) continue;
    const ratio = contrastRatio(f, b);
    const passesAA = ratio >= 4.5;
    contrast.push({ foreground: fg, background: bg, ratio, passesAA });
    if (!passesAA) warnings.push(`کنتراست ${fg} روی ${bg} برابر ${ratio} است (حداقل ۴٫۵ برای WCAG AA).`);
  }
  if (changes.length === 0) warnings.push("هیچ تغییری نسبت به تم فعلی وجود ندارد.");
  return {
    id: randomId("thm_"),
    siteId: input.siteId,
    status: "pending_approval",
    reason: input.reason ?? (input.event ? `تم مناسبتی ${input.event.titleFa}` : "تغییر تم"),
    baseSnapshotId: input.baseSnapshotId ?? null,
    changes,
    proposedTokens: proposed,
    contrast,
    warnings,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
}

export function themeApprovalContent(p: ThemeProposal): unknown {
  return { id: p.id, siteId: p.siteId, baseSnapshotId: p.baseSnapshotId, changes: p.changes };
}

export class StaleProposalError extends Error {
  override name = "StaleProposalError";
}

/**
 * Apply a proposal by creating a new snapshot with the proposed tokens. Staging needs no
 * approval (it is a sandbox); production requires approval (subject: theme_proposal <id>, action "apply").
 * Refuses if the active tokens no longer match the proposal's "from" values.
 */
export async function applyThemeProposal(
  versioning: WebsiteVersioning,
  gate: ApprovalGate,
  proposal: ThemeProposal,
  env: SiteEnvironment,
  opts: { createdBy: string; now?: Date },
): Promise<Snapshot> {
  const active = await versioning.active(proposal.siteId, env);
  if (!active) throw new Error(`No active ${env} snapshot for site ${proposal.siteId}`);
  for (const c of proposal.changes) {
    if ((active.content.themeTokens[c.token] ?? null) !== c.from) {
      throw new StaleProposalError(`Token ${c.token} changed since the proposal was made; create a new proposal`);
    }
  }
  if (proposal.contrast.some((c) => !c.passesAA) && env === "production") {
    throw new Error("Proposal fails WCAG AA contrast; fix before applying to production");
  }
  if (env === "production") {
    await gate.assert({ subjectType: "theme_proposal", subjectId: proposal.id, action: "apply", content: themeApprovalContent(proposal), ...(opts.now ? { now: opts.now } : {}) });
  }
  const tokens = { ...active.content.themeTokens };
  for (const c of proposal.changes) tokens[c.token] = c.to;
  return versioning.snapshot(proposal.siteId, env, { ...active.content, themeTokens: tokens }, {
    label: `theme ${proposal.id}`,
    reason: "theme_apply",
    createdBy: opts.createdBy,
    ...(opts.now ? { now: opts.now } : {}),
  });
}

export function tokensToCss(tokens: ThemeTokens, selector = ":root"): string {
  const lines = Object.entries(tokens)
    .filter(([, v]) => !/[<>{};]/.test(v))
    .map(([k, v]) => `  --${k.replace(/\./g, "-")}: ${v};`);
  return `${selector} {\n${lines.join("\n")}\n}\n`;
}
