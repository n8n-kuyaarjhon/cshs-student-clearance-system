'use strict';

/**
 * SQLite layer. Uses only the built-in `node:sqlite` module (Node 22.5+),
 * so there is nothing to install.
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const ROLES = ['registrar', 'admin_assistant', 'principal'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS students (
  lrn TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  middle_name TEXT,
  last_name TEXT NOT NULL,
  strand TEXT,
  last_grade_level INTEGER,
  section TEXT,
  year_graduated INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_students_name ON students(last_name, first_name);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  phone TEXT UNIQUE,
  email TEXT UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  channel TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  target TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otp_target ON otp_codes(channel, target, id);

CREATE TABLE IF NOT EXISTS email_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tracking TEXT NOT NULL UNIQUE,
  doc TEXT NOT NULL,
  name TEXT NOT NULL,
  lrn TEXT,
  section TEXT,
  phone TEXT,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,
  purpose_other TEXT,
  employment TEXT,
  id_type TEXT,
  university TEXT,
  claimant TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  reason TEXT,
  release TEXT,
  auth_check TEXT,
  id_verified INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 1,
  claimed_by TEXT,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  rejected_at TEXT,
  ready_at TEXT,
  claimed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_tracking ON requests(tracking);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status, release);

CREATE TABLE IF NOT EXISTS request_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_request ON request_files(request_id);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  via TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_staff ON notifications(staff_id, read);

CREATE TABLE IF NOT EXISTS request_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  via TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_request ON request_messages(request_id);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
`;

const now = () => new Date().toISOString();

function openDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  // Databases created before the government ID type was stored need the column.
  const requestColumns = db.prepare('PRAGMA table_info(requests)').all().map((column) => column.name);
  if (!requestColumns.includes('id_type')) db.exec('ALTER TABLE requests ADD COLUMN id_type TEXT');

  const q = (sql) => db.prepare(sql);
  const stmt = {
    metaGet: q('SELECT value FROM meta WHERE key = ?'),
    metaSet: q('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  };

  const repo = {
    db,
    close() {
      try { db.close(); } catch { /* already closed */ }
    },
    meta: {
      get(key) {
        const row = stmt.metaGet.get(key);
        return row ? row.value : null;
      },
      set(key, value) {
        stmt.metaSet.run(key, String(value));
      },
    },
    students: {
      upsert(s) {
        const ts = now();
        db.prepare(`INSERT INTO students (lrn, first_name, middle_name, last_name, strand, last_grade_level, section, year_graduated, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(lrn) DO UPDATE SET
            first_name = excluded.first_name, middle_name = excluded.middle_name, last_name = excluded.last_name,
            strand = excluded.strand, last_grade_level = excluded.last_grade_level, section = excluded.section,
            year_graduated = excluded.year_graduated, updated_at = excluded.updated_at`)
          .run(s.lrn, s.first_name, s.middle_name || null, s.last_name, s.strand || null,
            s.last_grade_level == null ? null : Number(s.last_grade_level), s.section || null,
            s.year_graduated == null ? null : Number(s.year_graduated), ts, ts);
        return repo.students.byLrn(s.lrn);
      },
      byLrn(lrn) {
        return db.prepare('SELECT * FROM students WHERE lrn = ?').get(String(lrn));
      },
      search(f) {
        const lc = (v) => String(v || '').toLowerCase();
        const rows = db.prepare('SELECT * FROM students').all();
        return rows.filter((s) =>
          lc(s.first_name) === lc(f.first_name) &&
          lc(s.last_name) === lc(f.last_name) &&
          (!f.middle_name || lc(s.middle_name).includes(lc(f.middle_name))) &&
          (!f.strand || s.strand === f.strand) &&
          (!f.year_graduated || String(s.year_graduated) === String(f.year_graduated))
        ).slice(0, 10);
      },
    },
    staff: {
      byPhone(phone) {
        return db.prepare('SELECT * FROM staff WHERE phone = ?').get(phone);
      },
      byEmail(email) {
        return db.prepare('SELECT * FROM staff WHERE email = ?').get(email);
      },
      byId(id) {
        return db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
      },
      all() {
        return db.prepare('SELECT * FROM staff ORDER BY id').all();
      },
      count() {
        return db.prepare('SELECT COUNT(*) AS n FROM staff').get().n;
      },
      create({ name, role, phone, email }) {
        if (!ROLES.includes(role)) throw Object.assign(new Error('Unknown role'), { status: 400 });
        const info = db.prepare('INSERT INTO staff (name, role, phone, email, active, created_at) VALUES (?, ?, ?, ?, 1, ?)')
          .run(name, role, phone || null, email || null, now());
        return repo.staff.byId(Number(info.lastInsertRowid));
      },
      setActive(id, active) {
        db.prepare('UPDATE staff SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
        return repo.staff.byId(id);
      },
      setChannel(id, channel) {
        db.prepare('UPDATE staff SET channel = ? WHERE id = ?').run(channel, id);
      },
    },
    otp: {
      issue({ channel, target, codeHash, expiresAt }) {
        db.prepare('UPDATE otp_codes SET consumed = 1 WHERE channel = ? AND target = ? AND consumed = 0').run(channel, target);
        db.prepare('INSERT INTO otp_codes (channel, target, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(channel, target, codeHash, expiresAt, now());
      },
      latest(channel, target) {
        return db.prepare('SELECT * FROM otp_codes WHERE channel = ? AND target = ? ORDER BY id DESC LIMIT 1').get(channel, target);
      },
      consume(id) {
        db.prepare('UPDATE otp_codes SET consumed = 1 WHERE id = ?').run(id);
      },
      bumpAttempts(id) {
        db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?').run(id);
      },
    },
    emailVerifications: {
      create({ email, tokenHash, expiresAt }) {
        db.prepare('INSERT INTO email_verifications (email, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)')
          .run(email, tokenHash, expiresAt, now());
      },
      find(tokenHash) {
        return db.prepare('SELECT * FROM email_verifications WHERE token_hash = ?').get(tokenHash);
      },
      consume(id) {
        db.prepare('UPDATE email_verifications SET consumed = 1 WHERE id = ?').run(id);
      },
    },
    sessions: {
      create({ tokenHash, staffId, expiresAt }) {
        db.prepare('INSERT INTO sessions (token_hash, staff_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
          .run(tokenHash, staffId, now(), expiresAt);
      },
      find(tokenHash) {
        return db.prepare(`SELECT s.token_hash, s.expires_at, u.* FROM sessions s JOIN staff u ON u.id = s.staff_id
          WHERE s.token_hash = ?`).get(tokenHash);
      },
      delete(tokenHash) {
        db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
      },
      purge() {
        db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
      },
    },
    requests: {
      create(r) {
        const info = db.prepare(`INSERT INTO requests
          (tracking, doc, name, lrn, section, phone, email, purpose, purpose_other, employment, id_type, university, claimant,
           status, id_verified, complete, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`)
          .run(r.tracking, r.doc, r.name, r.lrn || null, r.section || null, r.phone || null, r.email,
            r.purpose, r.purpose_other || null, r.employment || null, r.id_type || null, r.university || null,
            r.claimant ? JSON.stringify(r.claimant) : null, r.complete ? 1 : 0, now());
        return repo.requests.byId(Number(info.lastInsertRowid));
      },
      byId(id) {
        return db.prepare('SELECT * FROM requests WHERE id = ?').get(Number(id));
      },
      byTracking(tracking) {
        return db.prepare('SELECT * FROM requests WHERE tracking = ?').get(String(tracking));
      },
      all() {
        return db.prepare('SELECT * FROM requests ORDER BY id DESC').all();
      },
      approved() {
        return db.prepare("SELECT * FROM requests WHERE status = 'approved' ORDER BY id DESC").all();
      },
      setDecision(id, decision, reason) {
        if (decision === 'approved') {
          db.prepare("UPDATE requests SET status = 'approved', reason = ?, approved_at = ?, release = 'preparing' WHERE id = ?")
            .run(reason || '', now(), id);
        } else {
          db.prepare("UPDATE requests SET status = 'rejected', reason = ?, rejected_at = ? WHERE id = ?")
            .run(reason || '', now(), id);
        }
        return repo.requests.byId(id);
      },
      setAuthCheck(id, value) {
        db.prepare('UPDATE requests SET auth_check = ? WHERE id = ?').run(value, id);
      },
      setIdVerified(id) {
        db.prepare('UPDATE requests SET id_verified = 1, complete = 1 WHERE id = ?').run(id);
      },
      setRelease(id, release, claimedBy) {
        if (release === 'ready') {
          db.prepare("UPDATE requests SET release = 'ready', ready_at = ? WHERE id = ?").run(now(), id);
        } else if (release === 'claimed') {
          db.prepare("UPDATE requests SET release = 'claimed', claimed_at = ?, claimed_by = ? WHERE id = ?")
            .run(now(), claimedBy || '', id);
        } else {
          db.prepare('UPDATE requests SET release = ? WHERE id = ?').run(release, id);
        }
        return repo.requests.byId(id);
      },
      count() {
        return db.prepare('SELECT COUNT(*) AS n FROM requests').get().n;
      },
    },
    files: {
      create({ requestId, kind, filename, mime, size }) {
        const info = db.prepare('INSERT INTO request_files (request_id, kind, filename, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(requestId, kind, filename, mime, size, now());
        return repo.files.byId(Number(info.lastInsertRowid));
      },
      byId(id) {
        return db.prepare('SELECT * FROM request_files WHERE id = ?').get(Number(id));
      },
      forRequest(requestId) {
        return db.prepare('SELECT * FROM request_files WHERE request_id = ? ORDER BY id').all(requestId);
      },
    },
    notifications: {
      create(staffId, message, via) {
        db.prepare('INSERT INTO notifications (staff_id, message, via, created_at) VALUES (?, ?, ?, ?)')
          .run(staffId, message, via, now());
      },
      forStaff(staffId) {
        return db.prepare('SELECT * FROM notifications WHERE staff_id = ? ORDER BY id DESC LIMIT 100').all(staffId);
      },
      unread(staffId) {
        return db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE staff_id = ? AND read = 0').get(staffId).n;
      },
      markAllRead(staffId) {
        db.prepare('UPDATE notifications SET read = 1 WHERE staff_id = ?').run(staffId);
      },
    },
    messages: {
      create(requestId, message, via) {
        db.prepare('INSERT INTO request_messages (request_id, message, via, created_at) VALUES (?, ?, ?, ?)')
          .run(requestId, message, via, now());
      },
      forRequest(requestId) {
        return db.prepare('SELECT * FROM request_messages WHERE request_id = ? ORDER BY id').all(requestId);
      },
    },
    outbox: {
      create({ to, subject, body, status, error }) {
        const info = db.prepare('INSERT INTO outbox (to_addr, subject, body, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(to, subject, body, status, error || null, now());
        return Number(info.lastInsertRowid);
      },
      markSent(id) {
        db.prepare("UPDATE outbox SET status = 'sent', sent_at = ? WHERE id = ?").run(now(), id);
      },
      markFailed(id, error) {
        db.prepare("UPDATE outbox SET status = 'failed', error = ? WHERE id = ?").run(String(error), id);
      },
      list(limit = 50) {
        return db.prepare('SELECT * FROM outbox ORDER BY id DESC LIMIT ?').all(limit);
      },
      lastTo(email) {
        return db.prepare('SELECT * FROM outbox WHERE to_addr = ? ORDER BY id DESC LIMIT 1').get(email);
      },
    },
  };

  return repo;
}

module.exports = { openDatabase, ROLES };
