import { validateEnv } from '../config/env.validation';

// Refuse to boot a misconfigured production deploy. A missing board auth (neither BOARD_PASSWORD
// nor BOARD_GROUPS) disables REST/WS auth, an unset/'*' CORS_ORIGIN opens the board to any origin,
// and an empty LINE_CHANNEL_SECRET disables webhook signature verification — any of these silently
// exposes the API publicly. Also runs the shared env-schema validation (validateEnv) so malformed
// values (e.g. non-numeric PORT, invalid BOARD_GROUPS JSON) fail fast in every environment.
export function assertProdConfig(env: NodeJS.ProcessEnv = process.env): void {
  // Reuse the ConfigModule schema: throws on any malformed env var regardless of NODE_ENV.
  validateEnv(env as Record<string, unknown>);

  if (env.NODE_ENV !== 'production') return;
  const errors: string[] = [];
  if (!env.BOARD_PASSWORD && !env.BOARD_GROUPS) {
    errors.push('BOARD_PASSWORD or BOARD_GROUPS must be set in production');
  }
  const cors = env.CORS_ORIGIN;
  if (!cors || cors === '*') {
    errors.push('CORS_ORIGIN must be an explicit origin (not unset/"*") in production');
  }
  if (!env.LINE_CHANNEL_SECRET) errors.push('LINE_CHANNEL_SECRET must be set in production');
  if (errors.length) throw new Error('Refusing to start:\n - ' + errors.join('\n - '));
}
