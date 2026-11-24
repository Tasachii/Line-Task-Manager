import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { LineClientService } from '../line/line-client.service';
import {
  NotificationOutboxRepository,
  UndeliveredCounts,
} from './notification-outbox.repository';

const LINE_RETRY_KEY_WINDOW_MS = 23 * 60 * 60 * 1000;

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
    const notification = await this.repo.claimDue(
      this.config.notificationRetryIntervalMs,
      this.config.notificationRetryLimit,
    );
    if (!notification) return false;

    const retryWindowExpired =
      notification.attempts > 1 &&
      Date.now() - new Date(notification.first_attempt_at).getTime() >= LINE_RETRY_KEY_WINDOW_MS;
    if (retryWindowExpired) {
      await this.repo.markFailedAttempt(
        notification.id,
        notification.attempts,
        'LINE retry-key window expired',
        true,
      );
      this.logger.error(`LINE notification ${notification.id} expired before delivery`);
      return true;
    }

    try {
      await this.line.pushToGroup(
        notification.group_id,
        notification.message_text,
        notification.retry_key,
      );
      await this.repo.markDelivered(notification.id);
    } catch (error) {
      const terminal = notification.attempts >= this.config.notificationRetryLimit;
      const message = this.errorMessage(error);
      await this.repo.markFailedAttempt(notification.id, notification.attempts, message, terminal);
      const detail = terminal ? 'gave up' : 'will retry';
      this.logger.warn(
        `LINE notification ${notification.id} attempt ${notification.attempts} failed (${detail}): ${message}`,
      );
    }
    return true;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private run(operation: () => Promise<unknown>): void {
    void operation().catch((error) => {
      this.logger.error(`LINE notification worker failed: ${this.errorMessage(error)}`);
    });
  }
}
