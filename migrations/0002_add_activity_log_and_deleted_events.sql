-- Activity log: records every create/update/delete/restore made by CMS members.
CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  entity_name TEXT,
  action TEXT NOT NULL,
  changes TEXT,
  actor_id TEXT,
  actor_name TEXT,
  actor_email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  undone INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_entity ON activity_logs (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs (created_at);

-- Deleted events: a replica of the events table. Deleting an event moves the
-- row here instead of destroying it, so it can be restored (undo).
CREATE TABLE IF NOT EXISTS deleted_events (
  id INTEGER PRIMARY KEY,
  event_name TEXT NOT NULL,
  club_name TEXT,
  event_type TEXT,
  event_for TEXT,
  poster_path TEXT,
  start_date_time TEXT,
  end_date_time TEXT,
  price_per_person INTEGER,
  participation_type TEXT,
  event_venue TEXT,
  short_description TEXT,
  long_description TEXT,
  is_special_event BOOLEAN,
  registration_link TEXT,
  team_size TEXT,
  faculty_coord_emp_id TEXT,
  faculty_coord_name TEXT,
  faculty_coord_mobile TEXT,
  faculty_coord_email TEXT,
  deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_by_id TEXT,
  deleted_by_name TEXT,
  deleted_by_email TEXT
);
