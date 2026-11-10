import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const createActive = `
  CREATE TABLE ledger (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL CHECK (version = 2),
    body TEXT NOT NULL
  ) STRICT;
`

function transaction(database, update) {
  database.exec('BEGIN IMMEDIATE')
  try {
    const value = update()
    database.exec('COMMIT')
    return value
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function migrate(database) {
  const hasLedger = database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'ledger'").get()
  if (!hasLedger) {
    database.exec(createActive + `INSERT INTO ledger VALUES (1, 2, '{"grants":{},"jobs":{}}');`)
  } else {
    const { version } = database.prepare('SELECT version FROM ledger WHERE id = 1').get()
    if (version === 1) {
      // The returned 0.4.0 build must fail closed on this database instead of
      // accepting an old task name from the archived part it cannot see.
      database.exec('ALTER TABLE ledger RENAME TO ledger_v1;' + createActive + `
        INSERT INTO ledger SELECT id, 2, body FROM ledger_v1;
        DROP TABLE ledger_v1;
      `)
    } else if (version !== 2) {
      throw new Error('Unsupported workflow ledger version')
    }
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS grant_history (
      key TEXT PRIMARY KEY,
      body TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS job_history (
      id TEXT PRIMARY KEY,
      task_key TEXT NOT NULL,
      item TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      body TEXT NOT NULL,
      UNIQUE (task_key, item, attempt)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS job_quarantine (
      id TEXT PRIMARY KEY,
      task_key TEXT,
      body TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS job_quarantine_task ON job_quarantine(task_key);
  `)
}

// Only the bounded active snapshot is read by the timer. Historical reads use
// indexed lookups. Moving a row and updating the snapshot are one transaction.
export function openLedger(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const lock = new DatabaseSync(join(dir, 'dispatcher.sqlite'), { timeout: 0 })
  let database
  try {
    lock.exec('PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE;')
    database = new DatabaseSync(join(dir, 'workflow-v1.sqlite'), { timeout: 1000 })
    database.exec('PRAGMA synchronous = FULL; PRAGMA trusted_schema = OFF;')
    transaction(database, () => migrate(database))
    const get = database.prepare('SELECT body FROM ledger WHERE id = 1')
    const set = database.prepare('UPDATE ledger SET body = ? WHERE id = 1 AND version = 2')
    const grant = database.prepare('SELECT body FROM grant_history WHERE key = ?')
    const job = database.prepare('SELECT body FROM job_history WHERE id = ?')
    const attempt = database.prepare('SELECT body FROM job_history WHERE task_key = ? AND item = ? AND attempt = ?')
    const jobsFor = database.prepare('SELECT body FROM job_history WHERE task_key = ? ORDER BY rowid DESC LIMIT 64')
    const jobCount = database.prepare('SELECT count(*) AS count FROM job_history WHERE task_key = ?')
    const quarantined = database.prepare('SELECT body FROM job_quarantine WHERE task_key = ?')
    const hasQuarantined = database.prepare('SELECT 1 FROM job_quarantine WHERE task_key = ? LIMIT 1')
    const quarantinedAttempt = database.prepare(`SELECT 1 FROM job_quarantine WHERE task_key = ?
      AND json_extract(body, '$.record.item') = ? AND json_extract(body, '$.record.attempt') = ? LIMIT 1`)
    const saveQuarantine = database.prepare('INSERT OR IGNORE INTO job_quarantine VALUES (?, ?, ?)')
    const saveGrant = database.prepare('INSERT INTO grant_history VALUES (?, ?)')
    const saveJob = database.prepare(`INSERT INTO job_history VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET body = excluded.body`)
    const unpack = (row) => row && JSON.parse(row.body)
    const read = () => unpack(get.get())
    const history = {
      grant: (key) => unpack(grant.get(key)),
      job: (id) => unpack(job.get(id)),
      attempt: (key, item, number) => unpack(attempt.get(key, item, number)),
      jobsFor: (key) => jobsFor.all(key).map(unpack),
      jobCount: (key) => jobCount.get(key).count,
      quarantined: (key) => quarantined.all(key).map(unpack),
      hasQuarantined: (key) => Boolean(hasQuarantined.get(key)),
      quarantinedAttempt: (key, item, number) => Boolean(quarantinedAttempt.get(key, item, number)),
    }
    const archive = {
      grant: (key, entry) => saveGrant.run(key, JSON.stringify(entry)),
      job: (entry) => saveJob.run(entry.id, entry.key, entry.item, entry.attempt, JSON.stringify(entry)),
      badJob: (id, key, entry) => saveQuarantine.run(id, key, JSON.stringify(entry)),
    }
    return {
      read,
      history,
      change(update) {
        return transaction(database, () => {
          const state = read()
          const { changed, value } = update(state, archive)
          if (changed && set.run(JSON.stringify(state)).changes !== 1) throw new Error('Workflow ledger write failed')
          return value
        })
      },
      close() {
        try { database.close() } finally { lock.close() }
      },
    }
  } catch (error) {
    try { database?.close() } finally { lock.close() }
    throw error
  }
}
