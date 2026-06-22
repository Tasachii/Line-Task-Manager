import {
  BadRequestException,
  Controller,
  Headers,
  Post,
  Req,
  RawBodyRequest,
} from '@nestjs/common';
import { Request } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { webhook } from '@line/bot-sdk';
import { LineClientService } from '../line/line-client.service';
import { WebhookService } from './webhook.service';

// Not rate limited: LINE delivers bursts from its own IPs and the HMAC signature is the gate.
@SkipThrottle()
@Controller('webhook')
export class WebhookController {
  constructor(
    private readonly line: LineClientService,
    private readonly webhookService: WebhookService,
  ) {}

  @Post()
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-line-signature') signature: string,
  ) {
    // Raw body is required for signature verification (HMAC is computed over the raw bytes).
    const raw = req.rawBody;
    if (!raw || !this.line.verifySignature(raw, signature)) {
      throw new BadRequestException('invalid signature');
    }

    const body = req.body as { events?: webhook.Event[] };
    // Respond 200 to LINE immediately, then process events asynchronously to prevent LINE retries.
    // handleEvents isolates per-event errors internally; the .catch() guards against any
    // unexpected top-level rejection so a future change can't crash the process.
    this.webhookService.handleEvents(body.events ?? []).catch(() => {});
    return { ok: true };
  }
}
