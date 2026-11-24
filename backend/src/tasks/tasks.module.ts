import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { TasksRepository } from './tasks.repository';
import { TaskExtractionService } from './task-extraction.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [RealtimeModule, AuthModule, NotificationsModule],
  controllers: [TasksController],
  providers: [TasksService, TasksRepository, TaskExtractionService],
  exports: [TasksService, TasksRepository, TaskExtractionService],
})
export class TasksModule {}
