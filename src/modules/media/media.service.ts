import { prisma } from '@/src/lib/db/prisma';
import { NotFoundError } from '@/src/lib/errors';
import type { RequestContext } from '@/src/lib/auth/request-context';
import { toPersistableJson } from '@/src/lib/json/persistable';
import type { MediaAssetDto } from './media.types';

export class MediaService {
  async uploadMedia(context: RequestContext, input: any): Promise<MediaAssetDto> {
    return prisma.mediaAsset.create({
      data: {
        workspaceId: context.workspaceId,
        contentItemId: input.contentItemId,
        type: input.type,
        storageKey: input.storageKey,
        publicUrl: input.publicUrl,
        mimeType: input.mimeType,
        sizeBytes: BigInt(input.sizeBytes),
        width: input.width,
        height: input.height,
        durationMs: input.durationMs,
        checksum: input.checksum,
        metadataJson: input.metadataJson === undefined ? undefined : toPersistableJson(input.metadataJson),
      },
    });
  }

  async getMediaById(context: RequestContext, id: string): Promise<MediaAssetDto> {
    const media = await prisma.mediaAsset.findFirst({ where: { id, workspaceId: context.workspaceId } });
    if (!media) throw new NotFoundError('Media asset not found');
    return media;
  }

  async deleteMedia(context: RequestContext, id: string): Promise<void> {
    await this.getMediaById(context, id);
    await prisma.mediaAsset.delete({ where: { id } });
  }
}
