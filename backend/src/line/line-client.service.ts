import { Injectable, Logger } from '@nestjs/common';
import { messagingApi, validateSignature } from '@line/bot-sdk';
import { AppConfigService } from '../config/app-config.service';

const { MessagingApiClient } = messagingApi;

@Injectable()
export class LineClientService {
  private readonly logger = new Logger(LineClientService.name);
  private readonly client: messagingApi.MessagingApiClient;

  constructor(private readonly config: AppConfigService) {
    this.client = new MessagingApiClient({
      channelAccessToken: this.config.lineChannelAccessToken,
    });
  }

  // Verifies the request originates from LINE (HMAC-SHA256 over the raw body).
  verifySignature(rawBody: Buffer | string, signature: string | undefined): boolean {
    if (!signature) return false;
    // An empty/unset secret must never validate any request — otherwise a forged
    // request crafted against the empty key would pass. Refuse in all environments.
    const secret = this.config.lineChannelSecret;
    if (!secret) return false;
    const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    return validateSignature(body, secret, signature);
  }

  // Fetches a group member's display name; returns 'Unknown' on failure to avoid breaking the flow.
  async getGroupMemberName(groupId: string, userId: string): Promise<string> {
    try {
      const profile = await this.client.getGroupMemberProfile(groupId, userId);
      return profile.displayName;
    } catch (e) {
      this.logger.warn(`get profile failed for ${userId}: ${(e as Error).message}`);
      return 'Unknown';
    }
  }

  // Sends a reply to the group (optional confirmation); swallows errors silently.
  async replyText(replyToken: string, text: string): Promise<void> {
    try {
      await this.client.replyMessage({
        replyToken,
        messages: [{ type: 'text', text }],
      });
    } catch (e) {
      this.logger.warn(`reply failed: ${(e as Error).message}`);
    }
  }

  // Pushes a message with a stable retry key. LINE returns 409 when that key was already accepted;
  // treating that response as success prevents duplicate delivery after an ambiguous timeout.
  async pushToGroup(groupId: string, text: string, retryKey: string): Promise<void> {
    try {
      await this.client.pushMessage({
        to: groupId,
        messages: [{ type: 'text', text }],
      }, retryKey);
    } catch (e) {
      const response = e as { status?: number; headers?: Headers };
      if (response.status === 409 && response.headers?.get('x-line-accepted-request-id')?.trim()) return;
      throw e;
    }
  }
}
