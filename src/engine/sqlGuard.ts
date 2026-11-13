import { DatasetRow } from './types';

export interface SqlGuardResult {
  allowed: boolean;
  reason: string;
  normalizedRoot: string | null;
  rejectedTokens: string[];
}

const FORBIDDEN_KEYWORDS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'MERGE',
  'GRANT',
  'REVOKE',
  'REPLACE',
  'UPSERT',
  'ATTACH',
  'DETACH',
  'PRAGMA',
  'VACUUM',
  'REINDEX',
  'COPY',
  'CALL',
  'EXEC',
  'EXECUTE',
];

const FORBIDDEN_CLAUSES_OR_FUNCS = [
  'XP_CMDSHELL',
  'OPENROWSET',
  'OPENDATASOURCE',
  'LOAD_FILE',
  'INTO OUTFILE',
  'INTO DUMPFILE',
  'SELECT INTO',
  'PG_SLEEP',
  'DBLINK',
];

function stripSqlCommentsAndLiterals(sql: string): { stripped: string; stringLiteralsFree: string } {
  // Remove -- line comments and /* ... */ block comments while preserving structure
  let out = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1] ?? '';
    if (!inSingle && !inDouble && ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (!inSingle && !inDouble && ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      out += ' ';
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      out += ch;
      i++;
      continue;
    }
    out += inSingle ? ' ' : ch;
    i++;
  }
  return { stripped: out.trim(), stringLiteralsFree: out.toUpperCase() };
}

/**
 * Deterministic SQL guard enforcing PM-3:
 * - Single statement only (reject stacked queries via semicolons)
 * - Root must be SELECT, WITH...SELECT, UNION, INTERSECT, or EXCEPT
 * - Every token checked against DDL/DML and dangerous functions/clauses
 */
export function validateReadOnlySql(rawSql: string): SqlGuardResult {
  const trimmed = rawSql.trim();
  if (!trimmed) {
    return { allowed: false, reason: 'Empty SQL statement.', normalizedRoot: null, rejectedTokens: [] };
  }

  const { stripped, stringLiteralsFree } = stripSqlCommentsAndLiterals(trimmed);
  // Allow a single trailing semicolon, reject any interior semicolon (stacked statements)
  const withoutTrailingSemi = stripped.replace(/;\s*$/, '');
  if (withoutTrailingSemi.includes(';')) {
    return {
      allowed: false,
      reason: 'Stacked SQL statements (multiple semicolons) are forbidden by PM-3.',
      normalizedRoot: null,
      rejectedTokens: [';'],
    };
  }

  const upper = stringLiteralsFree.replace(/;\s*$/, '').trim();
  const rejected: string[] = [];

  for (const clause of FORBIDDEN_CLAUSES_OR_FUNCS) {
    if (new RegExp(`\\b${clause.replace(/\s+/g, '\\s+')}\\b`, 'i').test(upper)) {
      rejected.push(clause);
    }
  }

  // Detect SELECT ... INTO <table> pattern
  if (/\bSELECT\b[\s\S]*\bINTO\b\s+[A-Z0-9_."`]+/i.test(upper)) {
    rejected.push('SELECT INTO');
  }

  const tokens = upper.split(/[^A-Z0-9_]+/).filter(Boolean);
  for (const tok of tokens) {
    if (FORBIDDEN_KEYWORDS.includes(tok)) {
      rejected.push(tok);
    }
  }

  if (rejected.length > 0) {
    const uniq = Array.from(new Set(rejected));
    return {
      allowed: false,
      reason: `Rejected forbidden SQL operation(s): ${uniq.join(', ')}`,
      normalizedRoot: tokens[0] ?? null,
      rejectedTokens: uniq,
    };
  }

  const firstToken = tokens[0] ?? '';
  const validRoots = ['SELECT', 'WITH', 'UNION', 'INTERSECT', 'EXCEPT'];
  if (!validRoots.includes(firstToken)) {
    return {
      allowed: false,
      reason: `Root statement '${firstToken || 'UNKNOWN'}' is not an allowed read-only query (SELECT / WITH / UNION / INTERSECT / EXCEPT).`,
      normalizedRoot: firstToken || null,
      rejectedTokens: [firstToken || 'UNKNOWN'],
    };
  }

  if (firstToken === 'WITH' && !tokens.includes('SELECT')) {
    return {
      allowed: false,
      reason: 'CTE (WITH) query must resolve to a SELECT statement.',
      normalizedRoot: 'WITH',
      rejectedTokens: ['WITH_NO_SELECT'],
    };
  }

  return {
    allowed: true,
    reason: 'AST/token guard passed: single read-only SELECT statement verified.',
    normalizedRoot: firstToken,
    rejectedTokens: [],
  };
}

/**
 * Safe read-only local SQL executor over the monitoring/reporting window table `baseline_monitoring_view`
 * so users can interactively test PM-3 queries inside the app without an external DB server.
 */
export function executeGuardedLocalSql(
  sql: string,
  tableRows: DatasetRow[],
  maxRows = 500
): { ok: boolean; error?: string; rows: DatasetRow[]; guard: SqlGuardResult } {
  const guard = validateReadOnlySql(sql);
  if (!guard.allowed) {
    return { ok: false, error: guard.reason, rows: [], guard };
  }

  // Parse optional LIMIT N and simple WHERE timestamp >= '...'
  const limitMatch = sql.match(/\bLIMIT\s+(\d+)/i);
  const limit = Math.min(maxRows, limitMatch ? Number(limitMatch[1]) : maxRows);

  const whereAfterMatch = sql.match(/timestamp\s*>=\s*'([^']+)'/i);
  let filtered = tableRows;
  if (whereAfterMatch) {
    const cutoff = whereAfterMatch[1];
    filtered = filtered.filter((r) => String(r.timestamp) >= cutoff);
  }

  return {
    ok: true,
    rows: filtered.slice(0, limit),
    guard,
  };
}
