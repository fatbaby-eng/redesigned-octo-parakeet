CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  area TEXT NOT NULL DEFAULT 'personal',
  status TEXT NOT NULL DEFAULT 'active',
  pinned INTEGER NOT NULL DEFAULT 0,
  next_action TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  dossier TEXT DEFAULT '',
  primary_path TEXT DEFAULT '',
  live_url TEXT DEFAULT '',
  thumbnail TEXT DEFAULT '',
  stack TEXT DEFAULT '[]',
  tags TEXT DEFAULT '[]',
  links TEXT DEFAULT '[]',
  doc_paths TEXT DEFAULT '[]',
  related TEXT DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS log_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reflections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_area ON projects(area);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_log_entries_project_id ON log_entries(project_id);
CREATE INDEX IF NOT EXISTS idx_log_entries_at ON log_entries(at);
CREATE INDEX IF NOT EXISTS idx_reflections_project_id ON reflections(project_id);
