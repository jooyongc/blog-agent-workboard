CREATE TABLE agent_workflows(job_id TEXT PRIMARY KEY,topic_id TEXT UNIQUE NOT NULL,site_id TEXT NOT NULL,stage TEXT NOT NULL,status TEXT NOT NULL,payload_json TEXT NOT NULL DEFAULT '{}',lease_until TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE agent_steps(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,agent TEXT NOT NULL,status TEXT NOT NULL,output_json TEXT,error TEXT,started_at TEXT NOT NULL,finished_at TEXT);
CREATE INDEX workflow_pending ON agent_workflows(status,created_at);
UPDATE workspace_records SET config_json=json_set(config_json,'$.schedule.mode','draft');
