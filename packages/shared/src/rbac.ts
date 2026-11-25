/**
 * RBAC catalogue shared by API and web.
 * The source of truth at runtime is the D1 `roles` / `permissions` /
 * `role_permissions` tables (seeded by migration 0002); these constants must
 * stay in sync with that migration — a test in apps/api enforces it.
 */
export const ROLES = ["super_admin", "admin", "member"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "chat:use",
  "tasks:create",
  "tasks:read:own",
  "tasks:read:all",
  "tasks:cancel:own",
  "tasks:cancel:all",
  "agents:read",
  "agents:manage",
  "users:read",
  "users:manage",
  "audit:read",
  "usage:read",
  "usage:manage",
  "flags:manage",
  "cortex:run",
  "autopilot:read",
  "autopilot:manage",
  "autopilot:approve",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const MEMBER: Permission[] = ["chat:use", "tasks:create", "tasks:read:own", "tasks:cancel:own", "agents:read", "cortex:run"];
const ADMIN: Permission[] = [
  ...MEMBER,
  "tasks:read:all",
  "tasks:cancel:all",
  "agents:manage",
  "users:read",
  "audit:read",
  "usage:read",
  "autopilot:read",
  "autopilot:manage",
  "autopilot:approve",
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  member: MEMBER,
  admin: ADMIN,
  super_admin: [...PERMISSIONS],
};

/** Roles that may be granted/revoked through the admin API. super_admin is bootstrap-only. */
export const ASSIGNABLE_ROLES = ["admin", "member"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];
