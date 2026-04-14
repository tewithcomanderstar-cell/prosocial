import { randomUUID } from 'crypto';
import { enqueueScheduledContent } from '@/src/jobs/schedulers/enqueue-scheduled-content';
import { enqueueRetryablePublishJobs } from '@/src/jobs/schedulers/enqueue-retryable-publish-jobs';
import { detectStuckRuns } from '@/src/jobs/schedulers/detect-stuck-runs';
import { validateExpiringCredentials } from '@/src/jobs/schedulers/validate-expiring-credentials';
import { logger } from '@/src/lib/logger/structured-logger';

export async function runPlatformScheduler(params?: { correlationId?: string }) {
  const correlationId = params?.correlationId ?? randomUUID();
  logger.info('[SCHEDULER] started', {
    correlationId,
    schedulerEngine: 'prisma',
  });

  const [scheduledContent, retryablePublishJobs, stuckRuns, credentials] = await Promise.all([
    enqueueScheduledContent({ correlationId }),
    enqueueRetryablePublishJobs({ correlationId }),
    detectStuckRuns({ correlationId }),
    validateExpiringCredentials({ correlationId }),
  ]);

  const summary = {
    correlationId,
    schedulerEngine: 'prisma',
    scheduledContent,
    retryablePublishJobs,
    stuckRuns,
    credentials,
  };

  logger.info('[SCHEDULER] completed', summary);
  return summary;
}
