import { describe, expect, it } from "vitest";
import { dummyHash, hashPassword, needsRehash, storedIterations, verifyPassword } from "../src/lib/crypto";

describe("crypto helpers", () => {
  it("builds the dummy hash with the configured (clamped) iteration count", async () => {
    expect(storedIterations(dummyHash(30000))).toBe(30000);
    expect(storedIterations(dummyHash(5))).toBe(10000);
    expect(storedIterations(dummyHash(10_000_000))).toBe(100000);
    expect(await verifyPassword("anything", dummyHash(30000))).toBe(false);
  });
  it("flags only hashes below the configured count", async () => {
    const h = await hashPassword("pw-123456789", 20000);
    expect(needsRehash(h, 50000)).toBe(true);
    expect(needsRehash(h, 20000)).toBe(false);
    expect(needsRehash(h, 10000)).toBe(false);
    expect(needsRehash("garbage", 50000)).toBe(false);
  });
});
