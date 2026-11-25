/** Generates real example files into examples/output/ (SVG banners/posters + landing HTML). */
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CampaignPlanner, EventCalendar, type BusinessProfile } from "../src/index.js";
import { assertWellFormedXml } from "./helpers/xml.js";

const outDir = fileURLToPath(new URL("../examples/output/", import.meta.url));
const NOW = new Date("2026-11-25T08:00:00Z");

const profiles: Record<string, BusinessProfile> = {
  yalda: { id: "biz_anar", name: "قنادی انار", industry: "food", city: "تهران", websiteUrl: "https://anar.example.ir" },
  black_friday: { id: "biz_digi", name: "دیجی‌کالای محله", industry: "electronics", priceRange: "budget", websiteUrl: "https://digi.example.ir" },
  nowruz: { id: "biz_mod", name: "مزون نیلوفر", industry: "fashion", priceRange: "premium", websiteUrl: "https://niloofar.example.ir", tone: "friendly" },
  valentines_day: { id: "biz_gol", name: "گل‌فروشی رز", industry: "general", websiteUrl: "https://rose.example.ir", brandColors: { primary: "#c2185b" } },
};

describe("example asset generation", () => {
  it("writes SVG + HTML drafts to examples/output", async () => {
    mkdirSync(outDir, { recursive: true });
    const cal = new EventCalendar();
    const planner = new CampaignPlanner();
    for (const [id, profile] of Object.entries(profiles)) {
      const ev = cal.next(id, "2026-11-25")!;
      const d = await planner.plan(ev, profile, { now: NOW });
      writeFileSync(`${outDir}${id}-banner.svg`, d.assets.bannerSvg);
      writeFileSync(`${outDir}${id}-poster.svg`, d.assets.posterSvg);
      writeFileSync(`${outDir}${id}-landing.html`, d.assets.landingHtml);
      writeFileSync(`${outDir}${id}-draft.json`, JSON.stringify({ ...d, assets: "(see files)" }, null, 2));
      assertWellFormedXml(readFileSync(`${outDir}${id}-banner.svg`, "utf8"));
      expect(d.status).toBe("pending_approval");
    }
  });
});
