import { createClient } from "@/lib/supabase/server";
import { db } from "@/../db";
import { users, agents, userRoles, roles, rolePermissions, permissions } from "@/../db/schema";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "crypto";
import { generateHumanId } from "@/lib/id-generators";

export interface AuthenticatedUser {
  id: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  status: string;
  supabaseUserId: string;
  maxAgents: number;
  roles: string[];
  agents: {
    agentId: string;
    displayName: string;
    isDefault: boolean;
    claimedAt: Date;
  }[];
}

/**
 * Get the authenticated user from the Supabase session.
 * Returns null if not authenticated or user not found in DB.
 */
export async function getAuthUser(): Promise<AuthenticatedUser | null> {
  const supabase = await createClient();
  const {
    data: { user: supabaseUser },
  } = await supabase.auth.getUser();

  if (!supabaseUser) return null;

  const [dbUser] = await db
    .select()
    .from(users)
    .where(eq(users.supabaseUserId, supabaseUser.id))
    .limit(1);

  if (!dbUser) return null;

  // Load roles
  const userRoleRows = await db
    .select({ roleName: roles.name })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(userRoles.userId, dbUser.id));

  // Load agents
  const agentRows = await db
    .select()
    .from(agents)
    .where(eq(agents.userId, dbUser.id));

  return {
    id: dbUser.id,
    displayName: dbUser.displayName,
    email: dbUser.email,
    avatarUrl: dbUser.avatarUrl,
    status: dbUser.status,
    supabaseUserId: dbUser.supabaseUserId,
    maxAgents: dbUser.maxAgents,
    roles: userRoleRows.map((r) => r.roleName),
    agents: agentRows.map((a) => ({
      agentId: a.agentId,
      displayName: a.displayName,
      isDefault: a.isDefault,
      claimedAt: a.claimedAt || a.createdAt,
    })),
  };
}

/**
 * Require authentication. Returns 401 response data if not authenticated.
 */
export async function requireAuth(): Promise<
  | { user: AuthenticatedUser; error: null }
  | { user: null; error: { status: 401; message: string } }
> {
  const user = await getAuthUser();
  if (!user) {
    return { user: null, error: { status: 401, message: "Unauthorized" } };
  }
  return { user, error: null };
}

/**
 * Check if user has a specific role.
 */
export function hasRole(user: AuthenticatedUser, ...roleNames: string[]): boolean {
  return roleNames.some((r) => user.roles.includes(r));
}

/**
 * Check if user has a specific permission via their roles.
 */
export async function hasPermission(
  userId: string,
  resource: string,
  action: string,
  scope: string = "own",
): Promise<boolean> {
  // Super admin bypass
  const userRoleRows = await db
    .select({ roleName: roles.name })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(userRoles.userId, userId));

  if (userRoleRows.some((r) => r.roleName === "super_admin")) return true;

  const permName = `${resource}:${action}:${scope}`;
  const result = await db
    .select({ id: permissions.id })
    .from(permissions)
    .innerJoin(rolePermissions, eq(permissions.id, rolePermissions.permissionId))
    .innerJoin(userRoles, eq(rolePermissions.roleId, userRoles.roleId))
    .where(and(eq(userRoles.userId, userId), eq(permissions.name, permName)))
    .limit(1);

  return result.length > 0;
}

/**
 * Find or create a user from Supabase auth user data.
 * Called during OAuth callback to ensure DB user record exists.
 */
export async function findOrCreateUser(supabaseUser: {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
}): Promise<string> {
  // Check if user exists
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.supabaseUserId, supabaseUser.id))
    .limit(1);

  if (existing) {
    // Update last login
    await db
      .update(users)
      .set({ lastLoginAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, existing.id));
    return existing.id;
  }

  // Create new user
  const metadata = supabaseUser.user_metadata || {};
  const displayName =
    (metadata.full_name as string) ||
    (metadata.name as string) ||
    (metadata.preferred_username as string) ||
    supabaseUser.email?.split("@")[0] ||
    "User";
  const avatarUrl = (metadata.avatar_url as string) || (metadata.picture as string) || null;
  const now = new Date();
  const userId = randomUUID();

  const [newUser] = await db
    .insert(users)
    .values({
      id: userId,
      displayName,
      email: supabaseUser.email || null,
      avatarUrl,
      status: "active",
      supabaseUserId: supabaseUser.id,
      maxAgents: 10,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
      betaAccess: false,
      betaAdmin: false,
      humanId: generateHumanId(),
    })
    .returning({ id: users.id });

  // Assign member role
  const [memberRole] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, "member"))
    .limit(1);

  if (memberRole) {
    await db.insert(userRoles).values({
      userId: newUser.id,
      roleId: memberRole.id,
    });
  }

  return newUser.id;
}
