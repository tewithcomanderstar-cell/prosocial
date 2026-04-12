import { NextRequest } from 'next/server';
import { apiOk, withRouteHandler } from '@/src/lib/http/responses';
import { getRequestContext } from '@/src/lib/auth/request-context';
import { parseOrThrow } from '@/src/lib/validation/parse';
import { AuditLogService } from '@/src/modules/audit/audit.service';
import { auditLogQuerySchema } from '@/src/modules/audit/audit.schemas';

const service = new AuditLogService();
export const GET = withRouteHandler(async (request: NextRequest) => {
  const context = await getRequestContext(request);
  const query = parseOrThrow(auditLogQuerySchema, Object.fromEntries(new URL(request.url).searchParams.entries()));
  return apiOk(await service.listAuditLogs(context, query));
});
