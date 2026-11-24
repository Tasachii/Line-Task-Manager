import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { DatabaseService } from '../database/database.service';
import { NotificationOutboxService } from '../notifications/notification-outbox.service';

// Health check endpoint for Docker / load balancer — no auth, not rate limited (probes hit it often).
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly db: DatabaseService,
    private readonly notifications: NotificationOutboxService,
  ) {}

  @Get()
  async check() {
    try {
      await this.db.query('SELECT 1');
      const counts = await this.notifications.countUndelivered();
      return {
        status: 'ok',
        db: 'up',
        notifications: {
          undelivered: counts.pending + counts.failed,
          ...counts,
        },
      };
    } catch {
      throw new ServiceUnavailableException({ status: 'error', db: 'down' });
    }
  }
}
