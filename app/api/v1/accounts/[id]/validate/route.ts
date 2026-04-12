import { NextRequest } from 'next/server';
import { apiOk, withRouteHandler } from '@/src/lib/http/responses';
import { getRequestContext } from '@/src/lib/auth/request-context';
import { parseOrThrow } from '@/src/lib/validation/parse';
import { AccountService } from '@/src/modules/accounts/account.service';
import { validateAccountParamsSchema } from '@/src/modules/accounts/account.schemas';

const service = new AccountService();
export const POST = withRouteHandler(async (request: NextRequest, contextData: { params: Promise<{ id: string }> }) => {
  const context = await getRequestContext(request);
  const params = parseOrThrow(validateAccountParamsSchema, await contextData.params);
  return apiOk(await service.validateAccount(context, params.id));
});
