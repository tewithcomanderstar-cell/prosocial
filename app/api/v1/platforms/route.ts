import { NextRequest } from 'next/server';
import { apiOk, withRouteHandler } from '@/src/lib/http/responses';
import { PlatformService } from '@/src/modules/platforms/platform.service';

const service = new PlatformService();
export const GET = withRouteHandler(async (_request: NextRequest) => apiOk(await service.listPlatforms()));
