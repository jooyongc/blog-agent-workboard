CREATE TABLE oauth_states(state TEXT PRIMARY KEY,site_id TEXT NOT NULL,redirect_uri TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE connection_tokens(site_id TEXT PRIMARY KEY,ciphertext TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE media_assets(asset_key TEXT PRIMARY KEY,site_id TEXT NOT NULL,month TEXT NOT NULL,data BLOB,mime TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TRIGGER media_month_guard BEFORE INSERT ON media_assets BEGIN
 SELECT RAISE(ABORT,'media_month_limit') WHERE (SELECT COUNT(*) FROM media_assets WHERE month=NEW.month)>=100;
END;
CREATE TABLE site_measurements(id TEXT PRIMARY KEY,site_id TEXT NOT NULL,metrics_json TEXT NOT NULL,created_at TEXT NOT NULL,next_measure_at TEXT NOT NULL);
CREATE INDEX measurement_site_date ON site_measurements(site_id,created_at);
