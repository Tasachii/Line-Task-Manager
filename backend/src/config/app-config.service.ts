import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Typed, defaulted access to every env var the app uses. Inject this instead of reading
// process.env ad hoc, so defaults/parsing live in one place and tests can override config.
@Injectable()
export class AppConfigService {
  private readonly logger = new Logger(AppConfigService.name);

  constructor(private readonly config: ConfigService) {}

  // --- LINE ---
  get lineChannelSecret(): string {
    return this.config.get<string>('LINE_CHANNEL_SECRET') ?? '';
  }
  get lineChannelAccessToken(): string {
    return this.config.get<string>('LINE_CHANNEL_ACCESS_TOKEN') ?? '';
  }

  // --- Database ---
  get databaseUrl(): string | undefined {
    return this.config.get<string>('DATABASE_URL');
  }

  // --- Security ---
  get boardPassword(): string | undefined {
    return this.config.get<string>('BOARD_PASSWORD') || undefined;
  }
  get corsOrigin(): string {
    return this.config.get<string>('CORS_ORIGIN') ?? '*';
  }

  // Parsed BOARD_GROUPS map { group_id: board_key }. Invalid JSON logs a warning and is ignored
  // (assertProdConfig / env validation surface the real error at boot); empty when unset.
  get boardGroups(): Record<string, string> {
    const raw = this.config.get<string>('BOARD_GROUPS');
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: Record<string, string> = {};
        for (const [groupId, key] of Object.entries(parsed)) {
          if (typeof key === 'string' && key.length > 0) out[groupId] = key;
        }
        return out;
      }
    } catch {
      this.logger.warn('BOARD_GROUPS is not valid JSON — ignoring per-group key map');
    }
    return {};
  }

  // True when per-group isolation is active (BOARD_GROUPS configured with at least one entry).
  get perGroupAuthEnabled(): boolean {
    return Object.keys(this.boardGroups).length > 0;
  }

  // --- Notifications ---
  get notifyStatuses(): string {
    return this.config.get<string>('NOTIFY_STATUSES') ?? 'todo,in_process,test,done';
  }
  get notifyAssign(): boolean {
    return (this.config.get<string>('NOTIFY_ASSIGN') ?? 'true') !== 'false';
  }

  // --- AI extraction ---
  get anthropicApiKey(): string | undefined {
    return this.config.get<string>('ANTHROPIC_API_KEY') || undefined;
  }
  get aiExtractModel(): string {
    return this.config.get<string>('AI_EXTRACT_MODEL') ?? 'claude-haiku-4-5';
  }

  // --- Webhook / keyword ---
  get taskKeyword(): string {
    return this.config.get<string>('TASK_KEYWORD') ?? '/task';
  }
  get webhookConcurrency(): number {
    return Math.max(1, Number(this.config.get('WEBHOOK_CONCURRENCY') ?? 3));
  }

  // --- Server / throttle ---
  get port(): number {
    return Number(this.config.get('PORT') ?? 3000);
  }
  get throttleLimit(): number {
    return Number(this.config.get('THROTTLE_LIMIT') ?? 120);
  }
  get throttleTtlMs(): number {
    return Number(this.config.get('THROTTLE_TTL_MS') ?? 60_000);
  }
}
