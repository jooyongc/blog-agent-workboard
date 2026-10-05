CREATE TABLE IF NOT EXISTS ai_runs (id TEXT PRIMARY KEY, article_key TEXT NOT NULL, month TEXT NOT NULL, week TEXT NOT NULL, reserved REAL NOT NULL CHECK(reserved >= 0), actual REAL, status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS ai_budget_guard BEFORE INSERT ON ai_runs BEGIN
 SELECT RAISE(ABORT,'monthly_budget_exceeded') WHERE COALESCE((SELECT SUM(reserved) FROM ai_runs WHERE month=NEW.month),0)+NEW.reserved>10;
 SELECT RAISE(ABORT,'weekly_budget_exceeded') WHERE COALESCE((SELECT SUM(reserved) FROM ai_runs WHERE week=NEW.week),0)+NEW.reserved>2;
 SELECT RAISE(ABORT,'article_budget_exceeded') WHERE COALESCE((SELECT SUM(reserved) FROM ai_runs WHERE article_key=NEW.article_key AND month=NEW.month),0)+NEW.reserved>0.5;
END;
CREATE TABLE IF NOT EXISTS login_attempts (bucket TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS draft_receipts (request_id TEXT PRIMARY KEY, site_id TEXT NOT NULL, payload_hash TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS topic_ideas (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'idea', created_at TEXT NOT NULL);
