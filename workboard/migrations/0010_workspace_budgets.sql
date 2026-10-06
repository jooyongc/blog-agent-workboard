CREATE TABLE workspace_budget_settings (
 site_id TEXT PRIMARY KEY REFERENCES workspace_records(site_id),
 monthly REAL NOT NULL CHECK(monthly>=0 AND monthly<=10000),
 weekly REAL NOT NULL CHECK(weekly>=0 AND weekly<=monthly),
 article REAL NOT NULL CHECK(article>=0 AND article<=weekly),
 revision INTEGER NOT NULL DEFAULT 1,
 updated_at TEXT NOT NULL
);
INSERT INTO workspace_budget_settings(site_id,monthly,weekly,article,revision,updated_at)
 SELECT site_id,CASE WHEN site_id='workboard-diagnostic' OR disabled=1 OR site_id='asty-cabin' THEN 0 ELSE 10 END,
 CASE WHEN site_id='workboard-diagnostic' OR disabled=1 OR site_id='asty-cabin' THEN 0 ELSE 10 END,
 CASE WHEN site_id='workboard-diagnostic' OR disabled=1 OR site_id='asty-cabin' THEN 0 ELSE MIN((SELECT article FROM budget_settings WHERE id=1),10) END,
 (SELECT revision+1 FROM budget_settings WHERE id=1),datetime('now') FROM workspace_records;
CREATE TRIGGER new_workspace_budget AFTER INSERT ON workspace_records BEGIN
 INSERT OR IGNORE INTO workspace_budget_settings(site_id,monthly,weekly,article,updated_at) VALUES(NEW.site_id,0,0,0,datetime('now'));
END;
CREATE INDEX ai_runs_workspace_month ON ai_runs(substr(article_key,1,instr(article_key,'/')-1),month);
CREATE INDEX ai_runs_workspace_week ON ai_runs(substr(article_key,1,instr(article_key,'/')-1),week);
DROP TRIGGER ai_budget_guard;
CREATE TRIGGER ai_budget_guard BEFORE INSERT ON ai_runs BEGIN
 SELECT RAISE(ABORT,'workspace_budget_missing') WHERE NOT EXISTS(SELECT 1 FROM workspace_budget_settings WHERE site_id=substr(NEW.article_key,1,instr(NEW.article_key,'/')-1));
 SELECT RAISE(ABORT,'monthly_budget_exceeded') WHERE COALESCE((SELECT SUM(reserved) FROM ai_runs WHERE month=NEW.month AND substr(article_key,1,instr(article_key,'/')-1)=substr(NEW.article_key,1,instr(NEW.article_key,'/')-1)),0)+NEW.reserved>(SELECT monthly FROM workspace_budget_settings WHERE site_id=substr(NEW.article_key,1,instr(NEW.article_key,'/')-1));
 SELECT RAISE(ABORT,'weekly_budget_exceeded') WHERE COALESCE((SELECT SUM(reserved) FROM ai_runs WHERE week=NEW.week AND substr(article_key,1,instr(article_key,'/')-1)=substr(NEW.article_key,1,instr(NEW.article_key,'/')-1)),0)+NEW.reserved>(SELECT weekly FROM workspace_budget_settings WHERE site_id=substr(NEW.article_key,1,instr(NEW.article_key,'/')-1));
 SELECT RAISE(ABORT,'article_budget_exceeded') WHERE COALESCE((SELECT SUM(reserved) FROM ai_runs WHERE article_key=NEW.article_key AND month=NEW.month),0)+NEW.reserved>(SELECT article FROM workspace_budget_settings WHERE site_id=substr(NEW.article_key,1,instr(NEW.article_key,'/')-1));
END;
