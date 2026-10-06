-- Apply ONLY to SEARCH_DB. Virtual tables must never be installed in authoritative DB.
CREATE TABLE IF NOT EXISTS search_documents (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  policy_revision INTEGER NOT NULL,
  source_watermark INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  indexed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS search_documents_repo ON search_documents(repo_id,kind,id);
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(title,body,content=search_documents,content_rowid=rowid,tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS search_documents_insert AFTER INSERT ON search_documents WHEN new.deleted=0 BEGIN
  INSERT INTO search_fts(rowid,title,body) VALUES(new.rowid,new.title,new.body);
END;
CREATE TRIGGER IF NOT EXISTS search_documents_delete AFTER DELETE ON search_documents WHEN old.deleted=0 BEGIN
  INSERT INTO search_fts(search_fts,rowid,title,body) VALUES('delete',old.rowid,old.title,old.body);
END;
CREATE TRIGGER IF NOT EXISTS search_documents_update_delete AFTER UPDATE ON search_documents WHEN old.deleted=0 BEGIN
  INSERT INTO search_fts(search_fts,rowid,title,body) VALUES('delete',old.rowid,old.title,old.body);
END;
CREATE TRIGGER IF NOT EXISTS search_documents_update_insert AFTER UPDATE ON search_documents WHEN new.deleted=0 BEGIN
  INSERT INTO search_fts(rowid,title,body) VALUES(new.rowid,new.title,new.body);
END;
CREATE TABLE IF NOT EXISTS processed_events (
  consumer TEXT NOT NULL,
  event_id TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY(consumer,event_id)
);
CREATE TABLE IF NOT EXISTS search_repository_state (
  repo_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  policy_revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  cursor TEXT,
  rebuild_id TEXT
);
