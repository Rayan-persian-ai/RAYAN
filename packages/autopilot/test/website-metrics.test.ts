import { describe, expect, it } from "vitest";
import {
  WebsiteVersioning,
  MemorySnapshotStore,
  D1SnapshotStore,
  ApprovalGate,
  MemoryApprovalStore,
  ApprovalRequiredError,
  proposeThemeChange,
  applyThemeProposal,
  themeApprovalContent,
  rollbackApprovalContent,
  StaleProposalError,
  tokensToCss,
  diffContent,
  EventCalendar,
  computeMetrics,
  compareCampaigns,
  twoProportionTest,
  wilsonInterval,
  normalCdf,
  contrastRatio,
  type SnapshotStore,
  type SiteContent,
} from "../src/index.js";
import { createSqliteD1 } from "./helpers/sqlite-d1.js";

const owner = { id: "owner_1", kind: "human" as const, role: "owner" as const };
const v1: SiteContent = {
  files: { "index.html": "<h1>سلام</h1>", "style.css": "body{}" },
  themeTokens: { "color.primary": "#1d4ed8", "color.onPrimary": "#ffffff", "color.text": "#111111", "color.background": "#ffffff", "radius.md": "8px" },
};
const v2: SiteContent = { ...v1, files: { "index.html": "<h1>سلام دنیا</h1>", "about.html": "درباره" } };

function suite(name: string, mk: () => SnapshotStore) {
  describe(`WebsiteVersioning (${name})`, () => {
    const setup = () => {
      const gate = new ApprovalGate(new MemoryApprovalStore());
      return { gate, v: new WebsiteVersioning({ store: mk(), gate }) };
    };
    const t = (m: number) => new Date(Date.UTC(2026, 10, 25, 10, m));

    it("snapshots, diffs and rolls back staging non-destructively", async () => {
      const { v } = setup();
      const s1 = await v.snapshot("site", "staging", v1, { createdBy: "editor", now: t(0), label: "v1" });
      const s2 = await v.snapshot("site", "staging", v2, { createdBy: "editor", now: t(1), label: "v2" });
      expect(s2.parentId).toBe(s1.id);
      expect(await v.diff(s1.id, s2.id)).toEqual({ added: ["about.html"], removed: ["style.css"], changed: ["index.html"], tokens: [] });
      const rb = await v.rollback("site", "staging", s1.id, { createdBy: "editor", now: t(2) });
      expect(rb.reason).toBe("rollback");
      expect(rb.contentHash).toBe(s1.contentHash);
      expect((await v.active("site", "staging"))!.id).toBe(rb.id);
      expect((await v.history("site", "staging")).map((s) => s.label)).toEqual([`rollback to ${s1.id}`, "v2", "v1"]);
    });

    it("promotion and production rollback require approval", async () => {
      const { v, gate } = setup();
      const s1 = await v.snapshot("site", "staging", v1, { createdBy: "editor", now: t(0) });
      await expect(v.promote("site", s1.id, { createdBy: "editor", now: t(1) })).rejects.toBeInstanceOf(ApprovalRequiredError);
      await gate.approve({ subjectType: "snapshot", subjectId: s1.id, action: "promote", content: { contentHash: s1.contentHash }, approver: owner, now: t(1) });
      const p1 = await v.promote("site", s1.id, { createdBy: "editor", now: t(2) });
      expect(p1.environment).toBe("production");
      const s2 = await v.snapshot("site", "staging", v2, { createdBy: "editor", now: t(3) });
      await gate.approve({ subjectType: "snapshot", subjectId: s2.id, action: "promote", content: { contentHash: s2.contentHash }, approver: owner, now: t(3) });
      await v.promote("site", s2.id, { createdBy: "editor", now: t(4) });
      await expect(v.rollback("site", "production", p1.id, { createdBy: "editor", now: t(5) })).rejects.toBeInstanceOf(ApprovalRequiredError);
      await gate.approve({ subjectType: "snapshot", subjectId: p1.id, action: "rollback", content: rollbackApprovalContent(p1), approver: owner, now: t(5) });
      const rb = await v.rollback("site", "production", p1.id, { createdBy: "editor", now: t(6) });
      expect((await v.active("site", "production"))!.contentHash).toBe(p1.contentHash);
      expect(rb.id).not.toBe(p1.id);
      await expect(v.rollback("site", "production", s1.id, { createdBy: "x" })).rejects.toThrow(/same site and environment/);
    });

    it("theme proposals: event palette, contrast, staging apply, production approval, staleness", async () => {
      const { v, gate } = setup();
      await v.snapshot("site", "staging", v1, { createdBy: "editor", now: t(0) });
      const yalda = new EventCalendar().occurrencesInYear(2026).find((e) => e.id === "yalda")!;
      const p = proposeThemeChange({ siteId: "site", current: v1.themeTokens, event: yalda, now: t(1) });
      expect(p.status).toBe("pending_approval");
      expect(p.changes.map((c) => c.token)).toEqual(expect.arrayContaining(["color.primary", "color.accent"]));
      expect(p.changes.find((c) => c.token === "color.primary")).toMatchObject({ from: "#1d4ed8", to: "#b3122e" });
      expect(p.contrast.every((c) => c.passesAA)).toBe(true);
      const snap = await applyThemeProposal(v, gate, p, "staging", { createdBy: "editor", now: t(2) });
      expect(snap.content.themeTokens["color.primary"]).toBe("#b3122e");
      expect(snap.reason).toBe("theme_apply");
      // the same proposal is now stale on staging (tokens already changed)
      await expect(applyThemeProposal(v, gate, p, "staging", { createdBy: "editor" })).rejects.toBeInstanceOf(StaleProposalError);
      // production
      await v.snapshot("site", "production", v1, { createdBy: "editor", now: t(3) });
      await expect(applyThemeProposal(v, gate, p, "production", { createdBy: "editor", now: t(4) })).rejects.toBeInstanceOf(ApprovalRequiredError);
      await gate.approve({ subjectType: "theme_proposal", subjectId: p.id, action: "apply", content: themeApprovalContent(p), approver: owner, now: t(4) });
      expect((await applyThemeProposal(v, gate, p, "production", { createdBy: "editor", now: t(5) })).content.themeTokens["color.primary"]).toBe("#b3122e");
    });

    it("theme proposals validate colors and flag poor contrast", () => {
      expect(() => proposeThemeChange({ siteId: "s", current: v1.themeTokens, changes: { "color.primary": "red;}" } })).toThrow(/hex/);
      expect(() => proposeThemeChange({ siteId: "s", current: v1.themeTokens, changes: { "font.body": "x}</style>" } })).toThrow(/forbidden/);
      const bad = proposeThemeChange({ siteId: "s", current: v1.themeTokens, changes: { "color.text": "#eeeeee" } });
      expect(bad.contrast.find((c) => c.foreground === "color.text")!.passesAA).toBe(false);
      expect(bad.warnings.length).toBe(1);
      expect(tokensToCss({ "color.primary": "#000000" })).toBe(":root {\n  --color-primary: #000000;\n}\n");
    });
  });
}

suite("memory", () => new MemorySnapshotStore());
suite("D1 on SQLite", () => new D1SnapshotStore(createSqliteD1()));

describe("diffContent / color", () => {
  it("diffs tokens", () => {
    expect(diffContent(v1, { ...v1, themeTokens: { ...v1.themeTokens, "color.primary": "#000000" } }).tokens).toEqual([
      { token: "color.primary", from: "#1d4ed8", to: "#000000" },
    ]);
    expect(contrastRatio("#000000", "#ffffff")).toBe(21);
  });
});

describe("metrics", () => {
  it("computes CTR, conversion, CPC, CPA, ROAS", () => {
    const m = computeMetrics({ campaignId: "a", impressions: 10_000, clicks: 250, conversions: 20, cost: 5_000_000, revenue: 40_000_000 });
    expect(m.ctr).toBeCloseTo(0.025);
    expect(m.conversionRate).toBeCloseTo(0.08);
    expect(m.impressionConversionRate).toBeCloseTo(0.002);
    expect(m.cpc).toBe(20_000);
    expect(m.cpa).toBe(250_000);
    expect(m.roas).toBe(8);
    expect(m.ctrInterval![0]).toBeLessThan(0.025);
    expect(m.ctrInterval![1]).toBeGreaterThan(0.025);
  });
  it("handles zero denominators and bad data", () => {
    const m = computeMetrics({ campaignId: "z", impressions: 0, clicks: 0, conversions: 0 });
    expect([m.ctr, m.conversionRate, m.cpc, m.roas, m.ctrInterval]).toEqual([null, null, null, null, null]);
    expect(computeMetrics({ campaignId: "w", impressions: 10, clicks: 20, conversions: 0 }).warnings.join()).toMatch(/clicks exceed/);
    expect(() => computeMetrics({ campaignId: "n", impressions: -1, clicks: 0, conversions: 0 })).toThrow(RangeError);
  });
  it("statistics helpers", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    const w = wilsonInterval(50, 100)!;
    expect(w[0]).toBeCloseTo(0.4038, 3);
    expect(w[1]).toBeCloseTo(0.5962, 3);
    const tst = twoProportionTest("ctr", 200, 10_000, 260, 10_000);
    expect(tst.relativeLift).toBeCloseTo(0.3);
    expect(tst.pValue!).toBeLessThan(0.01);
    expect(tst.significant).toBe(true);
  });
  it("compares campaigns and picks a winner only when significant", () => {
    const c = compareCampaigns(
      { campaignId: "A", impressions: 20_000, clicks: 400, conversions: 30 },
      { campaignId: "B", impressions: 20_000, clicks: 520, conversions: 55 },
    );
    expect(c.winner).toBe("B");
    expect(c.summaryFa).toContain("برنده: B");
    const tie = compareCampaigns({ campaignId: "A", impressions: 1000, clicks: 20, conversions: 2 }, { campaignId: "B", impressions: 1000, clicks: 22, conversions: 2 });
    expect(tie.winner).toBe("inconclusive");
  });
});

describe("D1 schema", () => {
  it("applies cleanly and enforces constraints", () => {
    const db = createSqliteD1();
    const tables = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'autopilot_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual([
      "autopilot_approvals", "autopilot_campaigns", "autopilot_events", "autopilot_job_runs", "autopilot_jobs",
      "autopilot_send_dedupe", "autopilot_send_log", "autopilot_site_pointers", "autopilot_snapshots",
    ]);
    expect(() => db.raw.exec("INSERT INTO autopilot_jobs (id,name,cron,handler,status,created_at,updated_at) VALUES ('x','x','* * * * *','h','bogus',0,0)")).toThrow(/CHECK/);
    db.raw.exec("INSERT INTO autopilot_snapshots (id,site_id,environment,reason,content_json,content_hash,created_by,created_at) VALUES ('s','site','staging','manual','{}','h','u',0)");
    expect(() => db.raw.exec("UPDATE autopilot_snapshots SET label='x'")).toThrow(/immutable/);
  });
});
