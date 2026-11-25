-- RAYAN Phase 1 — seed roles, permissions, feature flags and scheduler rows.
-- Must match packages/shared/src/rbac.ts (enforced by apps/api/test/rbac.test.ts).

INSERT INTO roles (name, description_fa) VALUES
  ('super_admin', 'مدیر ارشد سامانه (فقط از طریق راه‌اندازی سمت سرور)'),
  ('admin', 'مدیر'),
  ('member', 'کاربر عضو');

INSERT INTO permissions (name, description_fa) VALUES
  ('chat:use', 'استفاده از گفت‌وگوی هوش مصنوعی'),
  ('tasks:create', 'ایجاد وظیفه'),
  ('tasks:read:own', 'مشاهدهٔ وظایف خود'),
  ('tasks:read:all', 'مشاهدهٔ همهٔ وظایف'),
  ('tasks:cancel:own', 'لغو وظایف خود'),
  ('tasks:cancel:all', 'لغو همهٔ وظایف'),
  ('agents:read', 'مشاهدهٔ عامل‌ها'),
  ('agents:manage', 'فعال/غیرفعال‌سازی عامل‌ها'),
  ('users:read', 'مشاهدهٔ کاربران'),
  ('users:manage', 'مدیریت نقش کاربران'),
  ('audit:read', 'مشاهدهٔ گزارش ممیزی'),
  ('usage:read', 'مشاهدهٔ مصرف و وضعیت زمان‌بند'),
  ('usage:manage', 'تغییر سقف مصرف'),
  ('flags:manage', 'مدیریت پرچم‌های قابلیت');

INSERT INTO role_permissions (role, permission) VALUES
  ('member', 'chat:use'),
  ('member', 'tasks:create'),
  ('member', 'tasks:read:own'),
  ('member', 'tasks:cancel:own'),
  ('member', 'agents:read'),
  ('admin', 'chat:use'),
  ('admin', 'tasks:create'),
  ('admin', 'tasks:read:own'),
  ('admin', 'tasks:cancel:own'),
  ('admin', 'agents:read'),
  ('admin', 'tasks:read:all'),
  ('admin', 'tasks:cancel:all'),
  ('admin', 'agents:manage'),
  ('admin', 'users:read'),
  ('admin', 'audit:read'),
  ('admin', 'usage:read'),
  ('super_admin', 'chat:use'),
  ('super_admin', 'tasks:create'),
  ('super_admin', 'tasks:read:own'),
  ('super_admin', 'tasks:read:all'),
  ('super_admin', 'tasks:cancel:own'),
  ('super_admin', 'tasks:cancel:all'),
  ('super_admin', 'agents:read'),
  ('super_admin', 'agents:manage'),
  ('super_admin', 'users:read'),
  ('super_admin', 'users:manage'),
  ('super_admin', 'audit:read'),
  ('super_admin', 'usage:read'),
  ('super_admin', 'usage:manage'),
  ('super_admin', 'flags:manage');

INSERT INTO feature_flags (key, enabled, description_fa, updated_at) VALUES
  ('signup_enabled', 1, 'امکان ثبت‌نام کاربران جدید', unixepoch() * 1000),
  ('ai_enabled', 1, 'کلید اصلی فعال بودن سرویس هوش مصنوعی', unixepoch() * 1000);

INSERT INTO scheduled_jobs (name, cron, run_count, updated_at) VALUES
  ('heartbeat', '*/15 * * * *', 0, unixepoch() * 1000),
  ('task_processor', '*/15 * * * *', 0, unixepoch() * 1000),
  ('maintenance', '*/15 * * * *', 0, unixepoch() * 1000);
