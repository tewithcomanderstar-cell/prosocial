import type {
  ContentItem,
  Destination,
  Notification,
  Workflow,
  WorkflowRun,
  WorkflowStep,
  WorkflowStepType,
} from '@/lib/domain/types';
import type { PlatformPublisher, PublishPayload } from '@/lib/platforms/publisher';

export interface WorkflowExecutionContext {
  workflow: Workflow;
  workflowRun: WorkflowRun;
  contentItem?: ContentItem;
  destination?: Destination;
  state: Record<string, unknown>;
}

export interface WorkflowStepResult {
  status: 'succeeded' | 'failed' | 'skipped';
  output?: Record<string, unknown>;
  errorMessage?: string;
}

export interface WorkflowStepHandler {
  stepType: WorkflowStepType;
  execute(step: WorkflowStep, context: WorkflowExecutionContext): Promise<WorkflowStepResult>;
}

export interface NotificationDispatcher {
  dispatch(notification: Notification): Promise<void>;
}

export class PublishToDestinationStepHandler implements WorkflowStepHandler {
  stepType: WorkflowStepType = 'publish_to_destination';

  constructor(private readonly publishers: Record<string, PlatformPublisher>) {}

  async execute(step: WorkflowStep, context: WorkflowExecutionContext): Promise<WorkflowStepResult> {
    if (!context.destination) {
      return { status: 'failed', errorMessage: 'Destination is required for publish step.' };
    }

    const platformKey = String(step.configJson?.platformKey ?? context.state['platformKey'] ?? '');
    const publisher = this.publishers[platformKey];

    if (!publisher) {
      return {
        status: 'failed',
        errorMessage: `No publisher registered for platform \"${platformKey}\".`,
      };
    }

    const payload: PublishPayload = {
      contentItemId: context.contentItem?.id ?? String(context.workflowRun.contentItemId ?? ''),
      title: context.contentItem?.title,
      bodyText: context.contentItem?.bodyText ?? String(context.state['bodyText'] ?? ''),
      mediaUrls: Array.isArray(context.state['mediaUrls']) ? (context.state['mediaUrls'] as string[]) : undefined,
      scheduledAt: context.contentItem?.scheduledAt,
      platformPayload: context.contentItem?.platformPayloadJson,
    };

    const result = await publisher.publish(context.destination, payload);

    return result.success
      ? { status: 'succeeded', output: result.rawResponse }
      : { status: 'failed', errorMessage: result.errorMessage ?? 'Publish failed.' };
  }
}
