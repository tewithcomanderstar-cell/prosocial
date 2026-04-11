import { NextRequest } from 'next/server';
import { apiOk, withRouteHandler } from '@/src/lib/http/responses';
import { getRequestContext } from '@/src/lib/auth/request-context';
import { parseOrThrow } from '@/src/lib/validation/parse';
import { ApprovalService } from '@/src/modules/approvals/approval.service';
import { listApprovalsQuerySchema } from '@/src/modules/approvals/approval.schemas';

const service = new ApprovalService();
export const GET = withRouteHandler(async (request: NextRequest) => {
  const context = await getRequestContext(request);
  const query = parseOrThrow(listApprovalsQuerySchema, Object.fromEntries(new URL(request.url).searchParams.entries()));
  return apiOk(await service.listApprovals(context, query));
});
