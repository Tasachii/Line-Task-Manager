import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';

// Protects the board REST API with a shared password (header: x-board-key).
// If BOARD_PASSWORD is not set, auth is disabled (dev mode). webhook/health bypass this guard.
@Injectable()
export class BoardKeyGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const password = process.env.BOARD_PASSWORD;
    if (!password) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const provided = req.headers['x-board-key'];
    if (typeof provided === 'string' && safeEqual(provided, password)) return true;
    throw new UnauthorizedException('invalid board key');
  }
}

// Constant-time comparison so a wrong key can't be guessed byte-by-byte from response timing.
// Length is compared first via the buffer sizes; timingSafeEqual requires equal-length inputs.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
