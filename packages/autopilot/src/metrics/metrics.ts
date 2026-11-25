export interface CampaignStats {
  campaignId: string;
  impressions: number;
  clicks: number;
  conversions: number;
  /** Optional, in the campaign currency (e.g. Toman). */
  revenue?: number;
  cost?: number;
}

export interface CampaignMetrics {
  campaignId: string;
  impressions: number;
  clicks: number;
  conversions: number;
  /** clicks / impressions */
  ctr: number | null;
  /** conversions / clicks */
  conversionRate: number | null;
  /** conversions / impressions */
  impressionConversionRate: number | null;
  cpc: number | null;
  cpa: number | null;
  roas: number | null;
  /** 95% Wilson interval for CTR */
  ctrInterval: [number, number] | null;
  warnings: string[];
}

function assertCount(name: string, v: number): void {
  if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v)) throw new RangeError(`${name} must be a non-negative integer`);
}

const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

export function wilsonInterval(successes: number, trials: number, z = 1.959964): [number, number] | null {
  if (trials <= 0) return null;
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

export function computeMetrics(s: CampaignStats): CampaignMetrics {
  assertCount("impressions", s.impressions);
  assertCount("clicks", s.clicks);
  assertCount("conversions", s.conversions);
  const warnings: string[] = [];
  if (s.clicks > s.impressions) warnings.push("clicks exceed impressions — check tracking");
  if (s.conversions > s.clicks) warnings.push("conversions exceed clicks — view-through or tracking issue");
  if (s.impressions > 0 && s.impressions < 100) warnings.push("fewer than 100 impressions — rates are unreliable");
  return {
    campaignId: s.campaignId,
    impressions: s.impressions,
    clicks: s.clicks,
    conversions: s.conversions,
    ctr: ratio(s.clicks, s.impressions),
    conversionRate: ratio(s.conversions, s.clicks),
    impressionConversionRate: ratio(s.conversions, s.impressions),
    cpc: s.cost !== undefined ? ratio(s.cost, s.clicks) : null,
    cpa: s.cost !== undefined ? ratio(s.cost, s.conversions) : null,
    roas: s.cost !== undefined && s.revenue !== undefined ? ratio(s.revenue, s.cost) : null,
    ctrInterval: s.clicks <= s.impressions ? wilsonInterval(s.clicks, s.impressions) : null,
    warnings,
  };
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 erf approximation, |error| < 1.5e-7). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x / Math.SQRT2));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-((x / Math.SQRT2) ** 2));
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

export interface ProportionTest {
  metric: "ctr" | "conversionRate";
  a: number | null;
  b: number | null;
  /** (b - a) / a */
  relativeLift: number | null;
  absoluteDiff: number | null;
  z: number | null;
  pValue: number | null;
  significant: boolean;
}

/** Two-proportion pooled z-test (two-sided). */
export function twoProportionTest(metric: ProportionTest["metric"], sa: number, na: number, sb: number, nb: number, alpha = 0.05): ProportionTest {
  const a = ratio(sa, na);
  const b = ratio(sb, nb);
  if (a === null || b === null) return { metric, a, b, relativeLift: null, absoluteDiff: null, z: null, pValue: null, significant: false };
  const pooled = (sa + sb) / (na + nb);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / na + 1 / nb));
  const z = se > 0 ? (b - a) / se : 0;
  const pValue = se > 0 ? 2 * (1 - normalCdf(Math.abs(z))) : 1;
  return { metric, a, b, relativeLift: a > 0 ? (b - a) / a : null, absoluteDiff: b - a, z, pValue, significant: pValue < alpha };
}

export interface CampaignComparison {
  a: CampaignMetrics;
  b: CampaignMetrics;
  ctr: ProportionTest;
  conversionRate: ProportionTest;
  /** Winner on conversions per impression when significant, else "inconclusive". */
  winner: string | "inconclusive";
  summaryFa: string;
}

const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(2)}٪`);

export function compareCampaigns(sa: CampaignStats, sb: CampaignStats, alpha = 0.05): CampaignComparison {
  const a = computeMetrics(sa);
  const b = computeMetrics(sb);
  const ctr = twoProportionTest("ctr", sa.clicks, sa.impressions, sb.clicks, sb.impressions, alpha);
  const cvr = twoProportionTest("conversionRate", sa.conversions, sa.clicks, sb.conversions, sb.clicks, alpha);
  const overall = twoProportionTest("conversionRate", sa.conversions, sa.impressions, sb.conversions, sb.impressions, alpha);
  let winner: string = "inconclusive";
  if (overall.significant && overall.absoluteDiff !== null && overall.absoluteDiff !== 0) winner = overall.absoluteDiff > 0 ? sb.campaignId : sa.campaignId;
  else if (ctr.significant && ctr.absoluteDiff !== null && ctr.absoluteDiff !== 0 && sa.conversions + sb.conversions === 0)
    winner = ctr.absoluteDiff > 0 ? sb.campaignId : sa.campaignId;
  const summaryFa =
    `نرخ کلیک: ${pct(ctr.a)} در برابر ${pct(ctr.b)}` +
    (ctr.pValue !== null ? ` (p=${ctr.pValue.toFixed(3)})` : "") +
    `؛ نرخ تبدیل: ${pct(cvr.a)} در برابر ${pct(cvr.b)}` +
    (cvr.pValue !== null ? ` (p=${cvr.pValue.toFixed(3)})` : "") +
    `. ${winner === "inconclusive" ? "تفاوت معنادار نیست." : `برنده: ${winner}`}`;
  return { a, b, ctr, conversionRate: cvr, winner, summaryFa };
}
