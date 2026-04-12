import { NextRequest } from 'next/server';
import { getRequestContext, type RequestContext } from '@/src/lib/auth/request-context';
import type { Permission } from '@/src/modules/rbac/permissions';
import { RbacService, type AuthorizedContext } from '@/src/modules/rbac/rbac.service';

const rbacService = new RbacService();

export async function getAuthorizedContext(request: NextRequest, permission: Permission): Promise<AuthorizedContext> {
  const context = await getRequestContext(request);
  return rbacService.assertPermission(context, permission);
}

export async function assertPermission(context: RequestContext, permission: Permission): Promise<AuthorizedContext> {
  return rbacService.assertPermission(context, permission);
}
