// SQLite usage log for free-router: one row per successful routed request.
// Backend: node:sqlite (Node >= 22.5), better-sqlite3 as an optional fallback.
import fs from 'node:fs';
import path from 'node:path';

let DatabaseSync = null;
let backend = 'node:sqlite';
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  try {
    ({ default: DatabaseSync } = await import('better-sqlite3'));
    backend = 'better-sqlite3';
  } catch {
    throw new Error(
      'No SQLite backend available: need Node >= 22.5 (node:sqlite) or the better-sqlite3 package',
    );
  }
}

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  route TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  streaming INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts);
CREATE INDEX IF NOT EXISTS idx_usage_provider_model ON usage(provider, model);
`;

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Math.round(Number(value));
  }
  return null;
}

// usage.prompt_tokens | usage.input_tokens | usage.promptTokenCount — first wins.
function pickTokens(usage) {
  if (!usage || typeof usage !== 'object') {
    return { prompt: null, completion: null, total: null };
  }
  const prompt = toNumber(
    usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount,
  );
  const completion = toNumber(
    usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount,
  );
  let total = toNumber(usage.total_tokens ?? usage.totalTokens);
  if (total === null && (prompt !== null || completion !== null)) {
    total = (prompt || 0) + (completion || 0);
  }
  return { prompt, completion, total };
}

// "6h" | "7d" | "30m" | ISO date — returns ISO string or '' when unusable.
export function resolveSince(raw) {
  if (!raw) return '';
  const text = String(raw).trim();
  const relative = text.match(/^(\d+)([smhdw])$/);
  if (relative) {
    const units = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
    return new Date(Date.now() - Number(relative[1]) * units[relative[2]]).toISOString();
  }
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return '';
}

function whereFor(filters) {
  const clauses = [];
  const params = [];
  if (filters.since) {
    clauses.push('ts >= ?');
    params.push(filters.since);
  }
  if (filters.provider) {
    clauses.push('provider = ?');
    params.push(filters.provider);
  }
  if (filters.model) {
    clauses.push('model = ?');
    params.push(filters.model);
  }
  if (filters.route) {
    clauses.push('route = ?');
    params.push(filters.route);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return { where, params };
}

export function createUsageStore(dbPath, { enabled = true } = {}) {
  if (enabled === false) return null;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(CREATE_SQL);

  const insertStmt = db.prepare(`
    INSERT INTO usage (ts, route, provider, model, prompt_tokens, completion_tokens, total_tokens, streaming)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function record({ route, provider, model, usage, streaming }) {
    const { prompt, completion, total } = pickTokens(usage);
    insertStmt.run(
      new Date().toISOString(),
      String(route || ''),
      String(provider || ''),
      String(model || ''),
      prompt,
      completion,
      total,
      streaming ? 1 : 0,
    );
  }

  function list(rawFilters) {
    const since = resolveSince(rawFilters.since);
    const limit = clampInt(rawFilters.limit, 100, 1, 1000);
    const offset = clampInt(rawFilters.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const { where, params } = whereFor({
      since,
      provider: String(rawFilters.provider || '').trim(),
      model: String(rawFilters.model || '').trim(),
      route: String(rawFilters.route || '').trim(),
    });

    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM usage ${where}`)
      .get(...params)?.n ?? 0;
    const rows = db
      .prepare(
        `SELECT id, ts, route, provider, model, prompt_tokens, completion_tokens, total_tokens, streaming
         FROM usage ${where}
         ORDER BY ts DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);

    return {
      object: 'list',
      total,
      limit,
      offset,
      since: since || null,
      data: rows.map((row) => ({
        id: row.id,
        ts: row.ts,
        route: row.route,
        provider: row.provider,
        model: row.model,
        prompt_tokens: row.prompt_tokens,
        completion_tokens: row.completion_tokens,
        total_tokens: row.total_tokens,
        streaming: row.streaming === 1,
      })),
    };
  }

  function summary(rawFilters) {
    const since = resolveSince(rawFilters.since);
    const { where, params } = whereFor({ since });
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS requests,
                SUM(COALESCE(prompt_tokens, 0)) AS prompt_tokens,
                SUM(COALESCE(completion_tokens, 0)) AS completion_tokens,
                SUM(COALESCE(total_tokens, 0)) AS total_tokens,
                SUM(CASE WHEN prompt_tokens IS NULL THEN 1 ELSE 0 END) AS missing_usage
         FROM usage ${where}`,
      )
      .get(...params);
    const rows = db
      .prepare(
        `SELECT provider, model,
                COUNT(*) AS requests,
                SUM(COALESCE(prompt_tokens, 0)) AS prompt_tokens,
                SUM(COALESCE(completion_tokens, 0)) AS completion_tokens,
                SUM(COALESCE(total_tokens, 0)) AS total_tokens,
                SUM(CASE WHEN prompt_tokens IS NULL THEN 1 ELSE 0 END) AS missing_usage,
                MIN(ts) AS first_used,
                MAX(ts) AS last_used
         FROM usage ${where}
         GROUP BY provider, model
         ORDER BY requests DESC, total_tokens DESC`,
      )
      .all(...params);

    return {
      object: 'usage_summary',
      since: since || null,
      totals: {
        requests: totals?.requests ?? 0,
        prompt_tokens: totals?.prompt_tokens ?? 0,
        completion_tokens: totals?.completion_tokens ?? 0,
        total_tokens: totals?.total_tokens ?? 0,
        missing_usage: totals?.missing_usage ?? 0,
      },
      data: rows,
    };
  }

  return { backend, record, list, summary };
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
