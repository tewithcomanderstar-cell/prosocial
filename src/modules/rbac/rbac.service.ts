import { prisma } from '@/src/lib/db/prisma';
import { AuthenticationError, PermissionError } from '@/src/lib/errors';
import type { RequestContext } from '@/src/lib/auth/request-context';
import type { Permission } from '@/src/modules/rbac/permissions';
import { rolePermissionMap, type WorkspaceRole } from '@/src/modules/rbac/roles';

export type AuthorizedContext = RequestContext & {
  membershipRole: WorkspaceRole;
  permissions: Permission[];
};

export class RbacService {
  async getAuthorizedContext(context: RequestContext): Promise<AuthorizedContext> {
    const membership = await prisma.membership.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: context.workspaceId,
          userId: context.userId,
        },
      },
    });

    const fallbackRole = context.roles.find((role): role is WorkspaceRole => role in rolePermissionMap);
    const membershipRole = (membership?.role ?? (process.env.NODE_ENV !== 'production' ? fallbackRole : undefined)) as WorkspaceRole | undefined;

    if (!membershipRole) {
      throw new AuthenticationError('Workspace membership not found');
    }

    const permissions = Array.from(rolePermissionMap[membershipRole]);
    return {
      ...context,
      membershipRole,
      permissions,
    };
  }

  async hasPermission(context: RequestContext, permission: Permission): Promise<boolean> {
    const authorized = await this.getAuthorizedContext(context);
    return authorized.permissions.includes(permission);
  }

  async assertPermission(context: RequestContext, permission: Permission): Promise<AuthorizedContext> {
    const authorized = await this.getAuthorizedContext(context);
    if (!authorized.permissions.includes(permission)) {
      throw new PermissionError(`Missing permission: ${permission}`);
    }
    return authorized;
  }
}
