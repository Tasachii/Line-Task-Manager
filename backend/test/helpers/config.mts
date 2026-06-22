// Test helper: build an AppConfigService whose underlying ConfigService.get() resolves from an
// explicit override map (authoritative, including explicit `undefined`), falling back to
// process.env only for keys the override map does not mention.
//
// This lets unit tests override config deterministically instead of relying on
// construction-time env reads, and isolates a test's config from stray ambient env vars
// (e.g. a test passing only BOARD_GROUPS is not affected by a real BOARD_PASSWORD in the shell).
import type { ConfigService } from '@nestjs/config';
import { AppConfigService } from '../../src/config/app-config.service';

export function fakeConfig(overrides?: Record<string, string | undefined>): AppConfigService {
  const has = overrides ? Object.prototype.hasOwnProperty.bind(overrides) : () => false;
  const stub = {
    get<T = string>(key: string): T | undefined {
      if (overrides && has(key)) return overrides[key] as unknown as T | undefined;
      return process.env[key] as unknown as T | undefined;
    },
  } as unknown as ConfigService;
  return new AppConfigService(stub);
}
