-- RAYAN Phase 2 — permissions for Cortex/Autopilot, the cortex.run scheduler row and the first real
-- Autopilot job. Must match packages/shared/src/rbac.ts (enforced by apps/api/test/rbac.test.ts).

INSERT INTO permissions (name, description_fa) VALUES
  ('cortex:run', 'اجرای هدف با هستهٔ عامل‌ها (Cortex)'),
  ('autopilot:read', 'مشاهدهٔ مناسبت‌ها، کمپین‌ها و کارهای اتوپایلوت'),
  ('autopilot:manage', 'ساخت پیش‌نویس کمپین و مدیریت کارهای زمان‌بندی‌شده'),
  ('autopilot:approve', 'تأیید یا رد پیش‌نویس کمپین (تأیید انسانی)');

INSERT INTO role_permissions (role, permission) VALUES
  ('member', 'cortex:run'),
  ('admin', 'cortex:run'),
  ('admin', 'autopilot:read'),
  ('admin', 'autopilot:manage'),
  ('admin', 'autopilot:approve'),
  ('super_admin', 'cortex:run'),
  ('super_admin', 'autopilot:read'),
  ('super_admin', 'autopilot:manage'),
  ('super_admin', 'autopilot:approve');

INSERT INTO scheduled_jobs (name, cron, run_count, updated_at) VALUES
  ('autopilot', '*/15 * * * *', 0, unixepoch() * 1000);

-- Daily at 09:00 Asia/Tehran (utc_offset 210; Iran has no DST since 1401). The first run happens at the
-- first cron tick after deploy (next_run_at = now), afterwards the scheduler advances it to the next 09:00.
-- It only creates DRAFTS (status pending_approval); nothing is ever published or sent automatically.
INSERT INTO autopilot_jobs (id, name, cron, handler, payload_json, status, utc_offset_minutes, max_runs, run_count,
                            failure_count, next_run_at, created_at, updated_at)
VALUES ('autopilot.scan_events', 'پویش مناسبت‌های ۱۴ روز آینده و ساخت پیش‌نویس کمپین', '0 9 * * *', 'autopilot.scan_events',
        '{"horizonDays":14,"business":{"id":"default","name":"رایان","industry":"general","tone":"friendly","maxDiscountPercent":20}}',
        'active', 210, NULL, 0, 0, unixepoch() * 1000, unixepoch() * 1000, unixepoch() * 1000)
ON CONFLICT(id) DO NOTHING;
