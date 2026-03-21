import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { roles, permissions, rolePermissions } from "./schema";

const connectionString = process.env.SUPABASE_DB_URL!;
const prepareRaw = process.env.SUPABASE_DB_PREPARE?.toLowerCase();
const usePreparedStatements = prepareRaw === "true";
if (!connectionString) {
  console.error("SUPABASE_DB_URL is required");
  process.exit(1);
}

const client = postgres(connectionString, { max: 1, prepare: usePreparedStatements });
const db = drizzle(client);

const ROLES = [
  { name: "member", displayName: "Member", description: "Default role for new users", isSystem: true, priority: 10 },
  { name: "agent_owner", displayName: "Agent Owner", description: "User who owns at least one agent", isSystem: true, priority: 30 },
  { name: "admin", displayName: "Admin", description: "Platform administrator", isSystem: true, priority: 80 },
  { name: "super_admin", displayName: "Super Admin", description: "Full platform access", isSystem: true, priority: 100 },
] as const;

const PERMISSIONS = [
  { resource: "agent", action: "create", scope: "own", name: "agent:create:own", description: "Create own agents" },
  { resource: "agent", action: "read", scope: "all", name: "agent:read:all", description: "Read all agents" },
  { resource: "agent", action: "update", scope: "own", name: "agent:update:own", description: "Update own agents" },
  { resource: "agent", action: "delete", scope: "own", name: "agent:delete:own", description: "Delete own agents" },
  { resource: "agent", action: "manage", scope: "all", name: "agent:manage:all", description: "Manage all agents" },
  { resource: "room", action: "read", scope: "all", name: "room:read:all", description: "Read all rooms" },
  { resource: "room", action: "manage", scope: "all", name: "room:manage:all", description: "Manage all rooms" },
  { resource: "wallet", action: "read", scope: "own", name: "wallet:read:own", description: "Read own wallet" },
  { resource: "wallet", action: "manage", scope: "all", name: "wallet:manage:all", description: "Manage all wallets" },
  { resource: "user", action: "read", scope: "all", name: "user:read:all", description: "Read all users" },
  { resource: "user", action: "manage", scope: "all", name: "user:manage:all", description: "Manage all users" },
  { resource: "platform", action: "admin", scope: "all", name: "platform:admin:all", description: "Full platform admin access" },
] as const;

const ROLE_PERMISSION_MAP: Record<string, string[]> = {
  member: ["agent:create:own", "agent:read:all", "room:read:all", "wallet:read:own"],
  agent_owner: ["agent:create:own", "agent:read:all", "agent:update:own", "agent:delete:own", "room:read:all", "wallet:read:own"],
  admin: ["agent:create:own", "agent:read:all", "agent:update:own", "agent:delete:own", "agent:manage:all", "room:read:all", "room:manage:all", "wallet:read:own", "user:read:all"],
  super_admin: ["platform:admin:all"],
};

async function seed() {
  console.log("Seeding roles...");
  for (const role of ROLES) {
    await db
      .insert(roles)
      .values(role)
      .onConflictDoNothing({ target: roles.name });
  }

  console.log("Seeding permissions...");
  for (const perm of PERMISSIONS) {
    await db
      .insert(permissions)
      .values(perm)
      .onConflictDoNothing({ target: permissions.name });
  }

  console.log("Seeding role-permission mappings...");
  const allRoles = await db.select().from(roles);
  const allPerms = await db.select().from(permissions);

  const roleMap = new Map(allRoles.map((r) => [r.name, r.id]));
  const permMap = new Map(allPerms.map((p) => [p.name, p.id]));

  for (const [roleName, permNames] of Object.entries(ROLE_PERMISSION_MAP)) {
    const roleId = roleMap.get(roleName);
    if (!roleId) continue;
    for (const permName of permNames) {
      const permId = permMap.get(permName);
      if (!permId) continue;
      await db
        .insert(rolePermissions)
        .values({ roleId, permissionId: permId })
        .onConflictDoNothing();
    }
  }

  console.log("Seed complete.");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
