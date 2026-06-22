import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { TasksRepository } from './tasks.repository';
import { TaskExtractionService } from './task-extraction.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { LineModule } from '../line/line.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [RealtimeModule, LineModule, AuthModule],
  controllers: [TasksController],
  providers: [TasksService, TasksRepository, TaskExtractionService],
  exports: [TasksService, TasksRepository, TaskExtractionService],
})
export class TasksModule {}
