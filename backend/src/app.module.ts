import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppConfigModule } from './config/app-config.module';
import { AppConfigService } from './config/app-config.service';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { LineModule } from './line/line.module';
import { RealtimeModule } from './realtime/realtime.module';
import { TasksModule } from './tasks/tasks.module';
import { WebhookModule } from './webhook/webhook.module';

@Module({
  imports: [
    AppConfigModule,
    // Per-IP rate limit (default 120 req/min) applied globally. The LINE webhook and
    // /health opt out via @SkipThrottle() since they are protected by signature / used by probes.
    ThrottlerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => [
        { ttl: config.throttleTtlMs, limit: config.throttleLimit },
      ],
    }),
    DatabaseModule,
    LineModule,
    RealtimeModule,
    TasksModule,
    WebhookModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
