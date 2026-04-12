import { prisma } from '@/src/lib/db/prisma';
import { NotFoundError } from '@/src/lib/errors';
import type { RequestContext } from '@/src/lib/auth/request-context';

export class CredentialService {
  async validateCredential(context: RequestContext, credentialId: string) {
    const credential = await prisma.credential.findFirst({
      where: { id: credentialId, account: { workspaceId: context.workspaceId } },
      include: { account: true },
    });
    if (!credential) throw new NotFoundError('Credential not found');
    return {
      credentialId: credential.id,
      accountId: credential.accountId,
      status: credential.status,
      expiresAt: credential.expiresAt,
      accepted: true,
      validationQueued: true,
    };
  }

  async listExpiringCredentialIds(hoursAhead: number) {
    const threshold = new Date(Date.now() + hoursAhead * 60 * 60 * 1000);
    const credentials = await prisma.credential.findMany({
      where: { status: 'active', expiresAt: { lte: threshold } },
      select: { id: true },
      take: 200,
    });
    return credentials.map((credential: typeof credentials[number]) => credential.id);
  }
}
