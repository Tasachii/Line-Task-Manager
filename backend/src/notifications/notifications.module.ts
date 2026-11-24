import { Module } from '@nestjs/common';
import { LineModule } from '../line/line.module';
import { NotificationOutboxRepository } from './notification-outbox.repository';
import { NotificationOutboxService } from './notification-outbox.service';

@Module({
  imports: [LineModule],
  providers: [NotificationOutboxRepository, NotificationOutboxService],
  exports: [NotificationOutboxRepository, NotificationOutboxService],
})
export class NotificationsModule {}
