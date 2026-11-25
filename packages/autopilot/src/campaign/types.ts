import type { Channel } from "../antispam/guard.js";
import type { EventTag } from "../calendar/events.js";

export type Industry =
  | "fashion" | "food" | "restaurant" | "electronics" | "beauty" | "education" | "home" | "travel"
  | "health" | "kids" | "jewelry" | "books" | "services" | "general";

export interface BusinessProfile {
  id: string;
  /** Brand name as it should appear in Persian copy. */
  name: string;
  industry: Industry;
  city?: string;
  priceRange?: "budget" | "mid" | "premium";
  brandColors?: { primary: string; secondary?: string };
  websiteUrl?: string;
  tone?: "formal" | "friendly";
  /** Hard cap for suggested discount (percent). Default 30. */
  maxDiscountPercent?: number;
  /** Set false to never suggest percentage discounts (e.g. luxury brands). */
  allowDiscounts?: boolean;
  description?: string;
  channels?: Channel[];
}

export type CampaignStatus = "pending_approval" | "approved" | "rejected" | "published" | "sent" | "archived";

export interface CampaignCopy {
  headline: string;
  body: string;
  cta: string;
  /** Short SMS text (without opt-out footer, which the anti-spam guard appends). */
  sms: string;
  hashtags: string[];
}

export interface CampaignIdea {
  title: string;
  summary: string;
  angle: string;
}

export interface DiscountSuggestion {
  type: "percent" | "gift" | "free_shipping" | "none";
  value: number; // percent for "percent", 0 otherwise
  code: string | null;
  validFrom: string; // ISO date
  validTo: string; // ISO date
  rationale: string;
}

export interface AudienceDefinition {
  channel: Channel;
  /** Always true — audiences can only include contacts with explicit marketing consent. */
  consentRequired: true;
  tagsAny?: string[];
  cities?: string[];
  purchasedWithinDays?: number;
  excludeContactIds?: string[];
}

export interface Audience {
  definition: AudienceDefinition;
  contactIds: string[];
  size: number;
  excluded: { noConsent: number; noAddress: number; filteredOut: number };
}

export type BannerFormat = "social_banner" | "story_poster" | "square_post";
export type BannerMotif = "pomegranate" | "sabzeh" | "heart" | "tag" | "book" | "star" | "leaf" | "none";

export interface BannerSpec {
  format: BannerFormat;
  width: number;
  height: number;
  lang: "fa";
  direction: "rtl";
  fontFamily: string;
  background: { from: string; to: string };
  textColor: string;
  accentColor: string;
  ctaTextColor: string;
  brand: string;
  headline: string;
  subline: string;
  cta: string;
  badge: string | null;
  code: string | null;
  motif: BannerMotif;
  dateLabel: string;
}

export interface RelevanceResult {
  score: number; // 0..100
  recommendation: "recommended" | "optional" | "skip";
  reasons: string[];
  daysUntil: number;
}

export interface CampaignDraft {
  id: string;
  version: number;
  status: CampaignStatus;
  businessId: string;
  event: { id: string; instanceId: string; titleFa: string; date: string; jalaliDate: string; approximate: boolean };
  createdAt: string;
  relevance: RelevanceResult;
  idea: CampaignIdea;
  copy: CampaignCopy;
  discount: DiscountSuggestion;
  audience: Audience;
  banner: BannerSpec;
  poster: BannerSpec;
  assets: { bannerSvg: string; posterSvg: string; landingHtml: string };
  schedule: { startDate: string; suggestedSendDate: string; suggestedSendLocalTime: string };
  generator: "llm" | "template";
  warnings: string[];
  tags: EventTag[];
}

export interface LlmRequest {
  system: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
}

/** Inject any model (Workers AI, local, etc.). Must return the raw text completion. */
export type LlmFn = (req: LlmRequest) => Promise<string>;
