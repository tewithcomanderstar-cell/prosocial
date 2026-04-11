import { prisma } from '@/src/lib/db/prisma';
import { NotFoundError } from '@/src/lib/errors';
import type { RequestContext } from '@/src/lib/auth/request-context';
import type { AccountDto, AccountValidationResultDto } from './account.types';

export class AccountService {
  async listAccounts(context: RequestContext, filters: { platformId?: string; status?: string }): Promise<AccountDto[]> {
    return prisma.account.findMany({
      where: {
        workspaceId: context.workspaceId,
        platformId: filters.platformId,
        status: filters.status as never,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async validateAccount(context: RequestContext, accountId: string): Promise<AccountValidationResultDto> {
    const account = await prisma.account.findFirst({
      where: { id: accountId, workspaceId: context.workspaceId },
      include: { credentials: { orderBy: { updatedAt: 'desc' }, take: 1 } },
    });

    if (!account) throw new NotFoundError('Account not found');

    const credential = account.credentials[0] ?? null;
    return {
      accountId: account.id,
      status: credential && credential.status === 'active' ? 'ok' : 'warning',
      credentialStatus: credential?.status ?? null,
      expiresAt: credential?.expiresAt ?? null,
      scopes: credential?.scopesJson ?? null,
    };
  }
}
