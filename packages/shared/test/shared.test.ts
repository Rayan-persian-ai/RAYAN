import { describe, expect, it } from "vitest";
import { AGENT_MANIFESTS, agentManifestSchema, PERMISSIONS, ROLE_PERMISSIONS, ROLES, signupSchema } from "../src/index";

describe("agent manifests", () => {
  it("contains exactly 20 valid manifests with unique slugs", () => {
    expect(AGENT_MANIFESTS).toHaveLength(20);
    const slugs = new Set<string>();
    for (const m of AGENT_MANIFESTS) {
      expect(() => agentManifestSchema.parse(m)).not.toThrow();
      expect(m.name_fa).toMatch(/[\u0600-\u06FF]/);
      slugs.add(m.slug);
    }
    expect(slugs.size).toBe(20);
  });
});

describe("rbac catalogue", () => {
  it("every role maps only to known permissions; super_admin has all", () => {
    for (const r of ROLES) for (const p of ROLE_PERMISSIONS[r]) expect(PERMISSIONS).toContain(p);
    expect(new Set(ROLE_PERMISSIONS.super_admin)).toEqual(new Set(PERMISSIONS));
    expect(ROLE_PERMISSIONS.member).not.toContain("users:manage");
    expect(ROLE_PERMISSIONS.admin).not.toContain("users:manage");
  });
});

describe("schemas", () => {
  it("normalises email and enforces password length", () => {
    expect(signupSchema.parse({ email: "  A@B.COM ", password: "0123456789" }).email).toBe("a@b.com");
    expect(signupSchema.safeParse({ email: "a@b.com", password: "short" }).success).toBe(false);
    expect(signupSchema.safeParse({ email: "nope", password: "0123456789" }).success).toBe(false);
  });
});
