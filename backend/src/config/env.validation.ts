import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBooleanString,
  IsIn,
  IsInt,
  IsJSON,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  validateSync,
} from 'class-validator';

// Single source of truth for every environment variable the backend reads.
// ConfigModule.forRoot({ validate }) runs this at startup; assertProdConfig reuses the
// parsed result to enforce the production-only invariants (see assert-prod-config.ts).
export class EnvVars {
  @IsOptional()
  @IsIn(['development', 'production', 'test'])
  NODE_ENV?: 'development' | 'production' | 'test';

  // --- LINE ---
  // Optional at the schema level (dev/test boot without LINE); required in production via assertProdConfig.
  @IsOptional()
  @IsString()
  LINE_CHANNEL_SECRET?: string;

  @IsOptional()
  @IsString()
  LINE_CHANNEL_ACCESS_TOKEN?: string;

  // --- Database ---
  @IsOptional()
  @IsString()
  DATABASE_URL?: string;

  // --- Security ---
  @IsOptional()
  @IsString()
  BOARD_PASSWORD?: string;

  // JSON map { "<group_id>": "<board_key>" } enabling per-group board isolation (A-8/D-3).
  // When set, each key authorizes reads/writes for exactly one group_id.
  @IsOptional()
  @IsJSON()
  BOARD_GROUPS?: string;

  @IsOptional()
  @IsString()
  CORS_ORIGIN?: string;

  // --- Notifications ---
  @IsOptional()
  @IsString()
  NOTIFY_STATUSES?: string;

  @IsOptional()
  @IsBooleanString()
  NOTIFY_ASSIGN?: string;

  // --- AI extraction ---
  @IsOptional()
  @IsString()
  ANTHROPIC_API_KEY?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  AI_EXTRACT_MODEL?: string;

  // --- Webhook / keyword ---
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  TASK_KEYWORD?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  WEBHOOK_CONCURRENCY?: number;

  // --- Server / throttle ---
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  PORT?: number;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  THROTTLE_LIMIT?: number;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  THROTTLE_TTL_MS?: number;
}

// ConfigModule.forRoot({ validate }) validator. Throws (refusing boot) on any invalid var.
export function validateEnv(config: Record<string, unknown>): EnvVars {
  const validated = plainToInstance(EnvVars, config, { enableImplicitConversion: false });
  const errors = validateSync(validated, { skipMissingProperties: true, whitelist: false });
  if (errors.length > 0) {
    const detail = errors
      .map((e) => Object.values(e.constraints ?? {}).join(', '))
      .join('; ');
    throw new Error(`Invalid environment configuration: ${detail}`);
  }
  return validated;
}
