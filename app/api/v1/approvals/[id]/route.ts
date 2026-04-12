import { NextRequest } from 'next/server';
import { apiOk, withRouteHandler } from '@/src/lib/http/responses';
import { getRequestContext } from '@/src/lib/auth/request-context';
import { parseOrThrow } from '@/src/lib/validation/parse';
import { ApprovalService } from '@/src/modules/approvals/approval.service';
import { approvalIdParamsSchema } from '@/src/modules/approvals/approval.schemas';

const service = new ApprovalService();
export const GET = withRouteHandler(async (request: NextRequest, contextData: { params: Promise<{ id: string }> }) => {
  const context = await getRequestContext(request);
  const params = parseOrThrow(approvalIdParamsSchema, await contextData.params);
  return apiOk(await service.getApprovalById(context, params.id));
});
