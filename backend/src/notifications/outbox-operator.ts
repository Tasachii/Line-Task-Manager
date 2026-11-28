// Standalone DB command. Starting a Nest context here would start the delivery worker.
import { Pool } from 'pg';

const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export async function runOperator(args: string[], url: string | undefined): Promise<number> {
  const [command, id] = args;
  const list = command === 'list';
  const validId = id !== undefined && uuid.test(id);
  const validCommand = list ? (id === undefined || validId) : (command === 'redrive' && validId);
  if (!validCommand || args.length > 2) {
    console.error('Usage: outbox list [after-uuid] | outbox redrive <uuid>');
    return 2;
  }
  if (!url || !/^postgres(?:ql)?:\/\//i.test(url)) {
    console.error('OUTBOX_OPERATOR_DATABASE_URL is required.');
    return 2;
  }
  const pool = new Pool({ connectionString: url });
  try {
    if (list) {
      const { rows } = await pool.query(
        `SELECT operator_id, attempts, first_attempt_at, diagnostic, redrive
         FROM public.failed_notifications
         WHERE ($1::uuid IS NULL OR operator_id > $1)
         ORDER BY operator_id LIMIT 100`, [id ?? null],
      );
      console.log(JSON.stringify(rows));
      return 0;
    }
    const { rows } = await pool.query('SELECT public.redrive_notification($1::uuid) AS queued', [id]);
    console.log(JSON.stringify({ queued: rows[0].queued }));
    return rows[0].queued ? 0 : 1;
  } catch {
    console.error('Outbox command failed. Check database connection, migration and operator grants.');
    return 2;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  runOperator(process.argv.slice(2), process.env.OUTBOX_OPERATOR_DATABASE_URL)
    .then(code => { process.exitCode = code; })
    .catch(() => { console.error('Outbox command failed.'); process.exitCode = 2; });
}
