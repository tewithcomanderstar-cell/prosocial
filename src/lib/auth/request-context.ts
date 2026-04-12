import { NextRequest } from 'next/server';
import { AuthenticationError, PermissionError } from '@/src/lib/errors';

export type RequestContext = {
  userId: string;
  workspaceId: string;
  roles: string[];
  idempotencyKey?: string;
  ipAddress?: string;
  userAgent?: string;
};

export async function getRequestContext(request: NextRequest): Promise<RequestContext> {
  const userId = request.headers.get('x-user-id') ?? 'dev-user';
  const workspaceId = request.headers.get('x-workspace-id') ?? 'dev-workspace';
  const rolesHeader = request.headers.get('x-roles') ?? 'owner';
  const roles = rolesHeader.split(',').map((value) => value.trim()).filter(Boolean);
  const idempotencyKey = request.headers.get('idempotency-key') ?? undefined;
  const ipAddress = request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? undefined;
  const userAgent = request.headers.get('user-agent') ?? undefined;

  if (!userId || !workspaceId) {
    throw new AuthenticationError('Missing workspace or user context');
  }

  return { userId, workspaceId, roles, idempotencyKey, ipAddress, userAgent };
}

export function requireRole(context: RequestContext, allowedRoles: string[]) {
  if (!allowedRoles.some((role) => context.roles.includes(role))) {
    throw new PermissionError('Role not permitted for this action');
  }
}
