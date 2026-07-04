-- Supports per-group board isolation. findAll(group_id) orders by (status, position) and the
-- group-scoped move/renumber selects "WHERE status = ? AND group_id = ? ORDER BY position";
-- this composite index serves both without scanning other groups' rows.
CREATE INDEX IF NOT EXISTS idx_tasks_group_status_position ON tasks (group_id, status, position);
