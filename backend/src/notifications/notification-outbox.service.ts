import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { LineClientService } from '../line/line-client.service';
import {
  NotificationOutboxRepository,
  UndeliveredCounts,
} from './notification-outbox.repository';

@Injectable()
export class NotificationOutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationOutboxService.name);
  private timer?: NodeJS.Timeout;
  private processing = false;

  constructor(
    private readonly repo: NotificationOutboxRepository,
    private readonly line: LineClientService,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(
      () => this.run(() => this.processPending()),
      this.config.notificationRetryIntervalMs,
    );
    this.timer.unref();
    this.run(() => this.processPending());
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async processPending(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (await this.processOne()) {
        // Drain all notifications that are due now. Failed attempts are delayed before another claim.
      }
    } finally {
      this.processing = false;
    }
  }

  countUndelivered(): Promise<UndeliveredCounts> {
    return this.repo.countUndelivered();
  }

  kick(): void {
    this.run(() => this.processPending());
  }

  private async processOne(): Promise<boolean> {
    const started = performance.now();
    const wallStart = Date.now();
    const notification = await this.repo.claimDue(
      this.config.notificationRetryIntervalMs,
      this.config.notificationRetryLimit,
    );
    if (!notification) return false;

    // Use the database's window, subtracting even the time spent obtaining the claim.
    const elapsed = Math.max(performance.now() - started, Date.now() - wallStart);
    if (notification.remaining_ms === null || !(notification.remaining_ms > elapsed)) {
      await this.repo.markFailedAttempt(notification.id, notification.attempts, 'window_closed', true);
      return true;
    }

    try {
      await this.line.pushToGroup(
        notification.group_id,
        notification.message_text,
        notification.retry_key,
      );
    } catch (error) {
      const status = (error as { status?: number } | null)?.status;
      const kind = status === 429 ? 'rate_limited'
        : status !== undefined && status >= 400 && status < 500 ? 'rejected' : 'ambiguous';
      const terminal = kind !== 'ambiguous' || notification.attempts >= notification.attempt_limit;
      await this.repo.markFailedAttempt(notification.id, notification.attempts, kind, terminal);
      this.logger.warn(`LINE notification ${notification.operator_id} attempt ${notification.attempts}: ${kind}`);
      return true;
    }

    // Even an older claim's confirmed acceptance settles the same immutable request.
    // A DB failure here leaves an ambiguous claim for the normal bounded recovery path.
    await this.repo.markDelivered(notification.id, notification.retry_key);
    return true;
  }

  private run(operation: () => Promise<unknown>): void {
    void operation().catch(() => {
      this.logger.error('LINE notification worker database operation failed');
    });
  }
}
