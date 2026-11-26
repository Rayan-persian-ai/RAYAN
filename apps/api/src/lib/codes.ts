/** One-time 6-digit email codes: HMAC-hashed in D1, 10-minute expiry, max 5 attempts, single use. */
import type { Env } from "../env";
import { hmacHex } from "./secretbox";

export const CODE_TTL_MS = 10 * 60_000;
export const CODE_MAX_ATTEMPTS = 5;
export type CodePurpose = "verify" | "login" | "reset";

/** Persian digits → ASCII. */
export const normDigits = (s: string) => s.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));

export function newCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  return String(n).padStart(6, "0");
}

const hashOf = (env: Env, email: string, purpose: CodePurpose, code: string) => hmacHex(env, `${purpose}:${email.toLowerCase()}:${code}`);

export async function issueCode(env: Env, email: string, purpose: CodePurpose, now: number): Promise<string> {
  const code = newCode();
  await env.DB.batch([
    // a new code invalidates older unused ones for the same email + purpose
    env.DB.prepare("UPDATE email_codes SET consumed_at = ?1 WHERE email = ?2 AND purpose = ?3 AND consumed_at IS NULL").bind(now, email, purpose),
    env.DB.prepare("DELETE FROM email_codes WHERE expires_at < ?1").bind(now - 86_400_000),
    env.DB.prepare("INSERT INTO email_codes (id, email, purpose, code_hash, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(
      crypto.randomUUID(),
      email,
      purpose,
      await hashOf(env, email, purpose, code),
      now,
      now + CODE_TTL_MS,
    ),
  ]);
  return code;
}

/** True when the code matches the newest live code; counts failed attempts and burns the code on success. */
export async function checkCode(env: Env, email: string, purpose: CodePurpose, code: string, now: number): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT id, code_hash, attempts, expires_at FROM email_codes WHERE email = ?1 AND purpose = ?2 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1",
  )
    .bind(email, purpose)
    .first<{ id: string; code_hash: string; attempts: number; expires_at: number }>();
  if (!row || row.expires_at < now || row.attempts >= CODE_MAX_ATTEMPTS) return false;
  const ok = (await hashOf(env, email, purpose, normDigits(code))) === row.code_hash;
  if (ok) await env.DB.prepare("UPDATE email_codes SET consumed_at = ?1 WHERE id = ?2").bind(now, row.id).run();
  else await env.DB.prepare("UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?1").bind(row.id).run();
  return ok;
}

export function codeEmail(purpose: CodePurpose, code: string) {
  const title = purpose === "verify" ? "کد تأیید ایمیل رایان" : purpose === "login" ? "کد ورود به رایان" : "کد بازیابی رمز عبور رایان";
  const what = purpose === "verify" ? "تأیید ایمیل" : purpose === "login" ? "ورود" : "تغییر رمز عبور";
  const text = `سلام،\n\nکد ${what} شما در رایان: ${code}\n\nاین کد تا ۱۰ دقیقه معتبر است. اگر شما درخواست نداده‌اید، این ایمیل را نادیده بگیرید.\n\nرایان — هوش مصنوعی فارسی\nhttps://rayan-c1o.pages.dev`;
  const html = `<div dir="rtl" style="font-family:Tahoma,sans-serif;line-height:1.9;color:#0b1220"><h2 style="color:#1e88ff">رایان</h2><p>کد ${what} شما:</p><p style="font-size:28px;letter-spacing:6px;font-weight:bold;direction:ltr;text-align:center">${code}</p><p>این کد تا ۱۰ دقیقه معتبر است. اگر شما درخواست نداده‌اید، این ایمیل را نادیده بگیرید.</p></div>`;
  return { subject: `${title}: ${code}`, text, html };
}
