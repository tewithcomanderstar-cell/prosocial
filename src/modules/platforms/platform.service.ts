import { prisma } from '@/src/lib/db/prisma';
import type { PlatformDto } from './platform.types';

export class PlatformService {
  async listPlatforms(): Promise<PlatformDto[]> {
    return prisma.platform.findMany({ orderBy: { name: 'asc' } });
  }
}
