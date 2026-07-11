import {
  BadRequestException,
  Controller,
  Headers,
  Post,
  Req,
  RawBodyRequest,
  ServiceUnavailableException,
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
    // Acknowledge only after classification and durable intake both succeed. If AI extraction
    // or the database is unavailable, return a retryable response instead of losing the event.
    try {
      await this.webhookService.handleEvents(body.events ?? []);
    } catch (cause) {
      // 503 explicitly tells LINE that verified intake did not complete and should be retried.
      // The internal cause is retained for observability without exposing upstream details.
      throw new ServiceUnavailableException('webhook intake temporarily unavailable', { cause });
    }
    return { ok: true };
  }
}
