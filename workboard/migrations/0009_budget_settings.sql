CREATE TABLE budget_settings (
 id INTEGER PRIMARY KEY CHECK(id=1),
 monthly REAL NOT NULL CHECK(monthly>=0 AND monthly<=10000),
 weekly REAL NOT NULL CHECK(weekly>=0 AND weekly<=monthly),
 article REAL NOT NULL CHECK(article>=0 AND article<=weekly),
 revision INTEGER NOT NULL DEFAULT 1,
 updated_at TEXT NOT NULL
);
INSERT INTO budget_settings(id,monthly,weekly,article,updated_at) VALUES(1,10,2,0.5,datetime('now'));
DROP TRIGGER ai_budget_guard;
CREATE TRIGGER ai_budget_guard BEFORE INSERT ON ai_runs BEGIN
 SELECT RAISE(ABORT,'monthly_budget_exceeded') WHERE COALESCE((SELECT SUM(reserved) FROM ai_runs WHERE month=NEW.month),0)+NEW.reserved>(SELECT monthly FROM budget_settings WHERE id=1);
 SELECT RAISE(ABORT,'weekly_budget_exceeded') WHERE COALESCE((SELECT SUM(reserved) FROM ai_runs WHERE week=NEW.week),0)+NEW.reserved>(SELECT weekly FROM budget_settings WHERE id=1);
 SELECT RAISE(ABORT,'article_budget_exceeded') WHERE COALESCE((SELECT SUM(reserved) FROM ai_runs WHERE article_key=NEW.article_key AND month=NEW.month),0)+NEW.reserved>(SELECT article FROM budget_settings WHERE id=1);
END;
