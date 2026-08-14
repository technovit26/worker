DROP TABLE IF EXISTS events;

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  team_size TEXT
);

