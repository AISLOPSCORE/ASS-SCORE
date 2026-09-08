import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/**
 * SQLite persistence for scans.
 * Table: scans(id TEXT PRIMARY KEY, url TEXT, score INTEGER, breakdown TEXT/JSON,
 * created_at TEXT, partial INTEGER, note TEXT, worst_page TEXT/JSON).
 * The phase-2 columns (partial/note/worst_page) are added with an ALTER TABLE
 * migration on open, so databases created by the v1 schema keep working.
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

  // Migration for phase-2 fields + branding (additive; idempotent).
  const cols = db.prepare('PRAGMA table_info(scans)').all().map((c) => c.name);
  if (!cols.includes('partial')) db.exec('ALTER TABLE scans ADD COLUMN partial INTEGER');
  if (!cols.includes('note')) db.exec('ALTER TABLE scans ADD COLUMN note TEXT');
  if (!cols.includes('worst_page')) db.exec('ALTER TABLE scans ADD COLUMN worst_page TEXT');
  if (!cols.includes('branding')) db.exec('ALTER TABLE scans ADD COLUMN branding TEXT');

  const insertStmt = db.prepare(
    'INSERT INTO scans (id, url, score, breakdown, created_at, partial, note, worst_page, branding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const getStmt = db.prepare(
    'SELECT id, url, score, breakdown, created_at, partial, note, worst_page, branding FROM scans WHERE id = ?'
  );

  return {
    /**
     * @param {{ id: string, url: string, score: number, breakdown: object,
     *           createdAt: string, partial?: boolean, note?: string,
     *           worstPage?: object, branding?: object }} scan
     */
    insertScan(scan) {
      insertStmt.run(
        scan.id,
        scan.url,
        scan.score,
        JSON.stringify(scan.breakdown),
        scan.createdAt,
        scan.partial === undefined ? null : scan.partial ? 1 : 0,
        scan.note ?? null,
        scan.worstPage === undefined ? null : JSON.stringify(scan.worstPage),
        scan.branding === undefined || scan.branding === null ? null : JSON.stringify(scan.branding),
      );
    },
    /** @returns {null | { id, url, score, breakdown, created_at, partial, note, worstPage, branding }} */
    getScan(id) {
      const row = getStmt.get(id);
      if (!row) return null;
      return {
        ...row,
        breakdown: JSON.parse(row.breakdown),
        partial: row.partial === null ? undefined : Boolean(row.partial),
        worstPage: row.worst_page ? JSON.parse(row.worst_page) : undefined,
        branding: row.branding ? JSON.parse(row.branding) : undefined,
      };
    },
    close() {
      db.close();
    },
  };
}