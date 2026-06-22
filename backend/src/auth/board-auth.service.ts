import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { safeEqual } from '../common/safe-equal';

// Result of resolving a board key.
//   - { ok: false }          → no valid key (reject)
//   - { ok: true, groupId }  → authorized; groupId is the scope (undefined = all groups)
export type BoardAuthResult =
  | { ok: false }
  | { ok: true; groupId: string | undefined };

// Resolves an x-board-key / WS auth.key to the group_id it authorizes.
//
// Three modes (all backward-compatible — single-group deploys need zero or one env var):
//   1. No BOARD_PASSWORD and no BOARD_GROUPS → auth disabled (dev). groupId undefined (all groups).
//   2. BOARD_PASSWORD only (single-group deploy) → the key authorizes the whole board.
//      groupId undefined → findAll returns all groups (single tenant; no cross-group leak possible).
//   3. BOARD_GROUPS set (multi-tenant) → each key authorizes exactly one group_id; a key for
//      group A resolves to groupId 'A' and can never read group B (the data-leak fix, A-8/D-3).
@Injectable()
export class BoardAuthService {
  constructor(private readonly config: AppConfigService) {}

  // True when no auth is configured at all (dev mode — guard/gateway let everything through).
  get authDisabled(): boolean {
    return !this.config.boardPassword && !this.config.perGroupAuthEnabled;
  }

  resolve(providedKey: unknown): BoardAuthResult {
    if (this.authDisabled) return { ok: true, groupId: undefined };
    if (typeof providedKey !== 'string') return { ok: false };

    // Per-group key map takes precedence: the key scopes reads/writes to one group.
    if (this.config.perGroupAuthEnabled) {
      for (const [groupId, key] of Object.entries(this.config.boardGroups)) {
        if (safeEqual(providedKey, key)) return { ok: true, groupId };
      }
      return { ok: false };
    }

    // Single shared board password: authorizes the whole (single-tenant) board.
    const password = this.config.boardPassword;
    if (password && safeEqual(providedKey, password)) return { ok: true, groupId: undefined };
    return { ok: false };
  }
}
