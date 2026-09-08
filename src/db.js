import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/**
 * SQLite persistence for scans.
 * Table: scans(id TEXT PRIMARY KEY, url TEXT, score INTEGER, breakdown TEXT/JSON, created_at TEXT).
 * The DB file lives under data/ (gitignored); the directory is created on open.
 */
export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS scans (
      id         TEXT PRIMARY KEY,
      url        TEXT NOT NULL,
      score      INTEGER NOT NULL,
      breakdown  TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  const insertStmt = db.prepare(
    'INSERT INTO scans (id, url, score, breakdown, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  const getStmt = db.prepare('SELECT id, url, score, breakdown, created_at FROM scans WHERE id = ?');

  return {
    /** @param {{ id: string, url: string, score: number, breakdown: object, createdAt: string }} scan */
    insertScan(scan) {
      insertStmt.run(scan.id, scan.url, scan.score, JSON.stringify(scan.breakdown), scan.createdAt);
    },
    /** @returns {null | { id, url, score, breakdown, created_at }} */
    getScan(id) {
      const row = getStmt.get(id);
      if (!row) return null;
      return { ...row, breakdown: JSON.parse(row.breakdown) };
    },
    close() {
      db.close();
    },
  };
}