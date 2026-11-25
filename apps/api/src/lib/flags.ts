export async function isFlagEnabled(db: D1Database, key: string, fallback = false): Promise<boolean> {
  const row = await db.prepare("SELECT enabled FROM feature_flags WHERE key = ?1").bind(key).first<{ enabled: number }>();
  return row ? row.enabled === 1 : fallback;
}
