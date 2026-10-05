CREATE TABLE reusable_media(id TEXT PRIMARY KEY,site_id TEXT NOT NULL,provider TEXT NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,tags_json TEXT NOT NULL,url TEXT NOT NULL,source_url TEXT NOT NULL,license_reference TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX reusable_media_site ON reusable_media(site_id,created_at);
