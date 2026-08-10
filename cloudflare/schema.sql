CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  nickname TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  games_played INTEGER DEFAULT 0,
  score INTEGER DEFAULT 0,
  avatar_data TEXT,
  nickname_updated_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_login TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS game_history (
  id TEXT PRIMARY KEY,
  room_name TEXT,
  players TEXT,
  landlord TEXT,
  hidden_landlord TEXT,
  winner TEXT,
  winner_team TEXT,
  scores TEXT,
  turn_history TEXT,
  marked_card TEXT,
  initial_hands TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS runtime_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO runtime_config (key, value) VALUES ('aiDifficulty', 'normal');
