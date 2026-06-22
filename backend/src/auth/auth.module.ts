import { Module } from '@nestjs/common';
import { BoardAuthService } from './board-auth.service';
import { BoardKeyGuard } from './board-key.guard';

// Provides board authentication (key → group_id resolution) for REST and WebSocket.
@Module({
  providers: [BoardAuthService, BoardKeyGuard],
  exports: [BoardAuthService, BoardKeyGuard],
})
export class AuthModule {}
