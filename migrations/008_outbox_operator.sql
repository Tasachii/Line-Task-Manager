BEGIN;

-- The legacy row id is also the provider retry key. Only expose this independent handle.
ALTER TABLE public.notification_outbox
  ADD COLUMN IF NOT EXISTS operator_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS redrive_attempt integer,
  ADD COLUMN IF NOT EXISTS failure_kind text;
CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_operator_id
  ON public.notification_outbox (operator_id);

-- Survives deletion of a successfully delivered queue row.
CREATE TABLE IF NOT EXISTS public.notification_redrive_audit (
  operator_id uuid PRIMARY KEY,
  requested_by name NOT NULL,
  requested_at timestamptz NOT NULL,
  attempts_before integer NOT NULL
);

-- Preserve the original authorization even when a definitive late rejection
-- cancels it before the additional claim.
ALTER TABLE public.notification_redrive_audit
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

-- The first durable claim precedes the first possible send. Reserve an hour of
-- LINE's 24h window for timing uncertainty and in-flight requests.
CREATE OR REPLACE FUNCTION public.notification_retry_deadline(key text, first_claim timestamptz)
RETURNS timestamptz LANGUAGE sql STABLE STRICT
SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN key ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
                   AND isfinite(first_claim) AND first_claim <= statement_timestamp()
              THEN first_claim + interval '23 hours' END
$$;

CREATE OR REPLACE VIEW public.failed_notifications WITH (security_barrier = true) AS
SELECT operator_id, attempts, first_attempt_at,
       CASE WHEN failure_kind IN ('ambiguous', 'rate_limited', 'rejected', 'interrupted', 'window_closed')
            THEN failure_kind ELSE 'unknown' END AS diagnostic,
       CASE WHEN redrive_attempt IS NOT NULL THEN 'redrive_used'
            WHEN attempts NOT BETWEEN 1 AND 2147483646 THEN 'unknown_history'
            WHEN first_attempt_at > updated_at OR public.notification_retry_deadline(retry_key, first_attempt_at) IS NULL
              THEN 'unknown_history'
            WHEN public.notification_retry_deadline(retry_key, first_attempt_at) <= clock_timestamp() THEN 'window_closed'
            WHEN failure_kind IN ('ambiguous', 'rate_limited', 'interrupted') THEN 'eligible'
            WHEN failure_kind = 'rejected' THEN 'rejected'
            ELSE 'unknown_history' END AS redrive
FROM public.notification_outbox WHERE status = 'failed';

CREATE OR REPLACE FUNCTION public.redrive_notification(target uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE prior_attempts integer;
BEGIN
  SELECT attempts INTO prior_attempts FROM public.notification_outbox
    WHERE operator_id = target AND status = 'failed' FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.failed_notifications WHERE operator_id = target AND redrive = 'eligible'
  ) THEN RETURN false; END IF;

  INSERT INTO public.notification_redrive_audit(operator_id, requested_by, requested_at, attempts_before)
    VALUES (target, session_user, clock_timestamp(), prior_attempts);
  UPDATE public.notification_outbox
    SET status = 'pending', redrive_attempt = prior_attempts + 1,
        next_attempt_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE operator_id = target;
  RETURN true;
END
$$;
REVOKE ALL ON public.failed_notifications, public.notification_redrive_audit FROM PUBLIC;
REVOKE ALL ON FUNCTION public.redrive_notification(uuid) FROM PUBLIC;
COMMIT;
