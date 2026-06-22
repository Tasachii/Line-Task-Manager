import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { BoardAuthService } from './board-auth.service';

// Request augmented with the group_id the board key resolved to (undefined = all groups).
export interface BoardRequest extends Request {
  boardGroupId?: string;
}

// Protects the board REST API with a board key (header: x-board-key). The key resolves to the
// group_id it authorizes, which the controller threads into the query so a key for group A can
// never read group B (A-8/D-3). If no auth is configured, auth is disabled (dev mode).
@Injectable()
export class BoardKeyGuard implements CanActivate {
  constructor(private readonly auth: BoardAuthService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<BoardRequest>();
    const result = this.auth.resolve(req.headers['x-board-key']);
    if (!result.ok) throw new UnauthorizedException('invalid board key');
    req.boardGroupId = result.groupId;
    return true;
  }
}
