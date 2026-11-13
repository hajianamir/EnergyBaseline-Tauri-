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
  'LOAD_EXTENSION',
  'READFILE',
  'WRITEFILE',
  'PG_READ_FILE',
  'PG_READ_BINARY_FILE',
  'PG_LS_DIR',
  'INTO OUTFILE',
  'INTO DUMPFILE',
  'SELECT INTO',
  'PG_SLEEP',
  'SLEEP',
  'BENCHMARK',
  'DBLINK',
  'DBLINK_EXEC',
  'LO_IMPORT',
  'LO_EXPORT',
];

export const MAX_SQL_BYTES = 64 * 1024;
const SQL_UTF8_ENCODER = new TextEncoder();

interface SqlLexResult {
  stripped: string;
  lexicalError?: string;
}

/** Remove comments and string literals without losing statement separators.
 * Quoted identifiers remain visible for conservative keyword/function checks.
 */
function stripSqlCommentsAndLiterals(sql: string): SqlLexResult {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1] ?? '';

    if ((ch === '-' && next === '-') || ch === '#') {
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i++;
      out += ' ';
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      let depth = 1;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      if (depth !== 0) return { stripped: out, lexicalError: 'Unterminated block comment.' };
      out += ' ';
      continue;
    }

    if (ch === "'") {
      i++;
      let terminated = false;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          terminated = true;
          break;
        } else {
          i++;
        }
      }
      if (!terminated) return { stripped: out, lexicalError: 'Unterminated string literal.' };
      out += ' ';
      continue;
    }

    if (ch === '$') {
      const delimiter = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (delimiter) {
        const end = sql.indexOf(delimiter, i + delimiter.length);
        if (end < 0) return { stripped: out, lexicalError: 'Unterminated dollar-quoted string literal.' };
        i = end + delimiter.length;
        out += ' ';
        continue;
      }
    }

    if (ch === '"' || ch === '`' || ch === '[') {
      const start = i;
      const close = ch === '[' ? ']' : ch;
      i++;
      let terminated = false;
      while (i < sql.length) {
        if (sql[i] === close && sql[i + 1] === close) {
          i += 2;
        } else if (sql[i] === close) {
          i++;
          terminated = true;
          break;
        } else {
          i++;
        }
      }
      if (!terminated) return { stripped: out, lexicalError: 'Unterminated quoted identifier.' };
      out += sql.slice(start, i);
      continue;
    }

    out += ch;
    i++;
  }
  return { stripped: out.trim() };
}

/**
 * Deterministic SQL guard enforcing PM-3:
 * - Single statement only (reject stacked queries via semicolons)
 * - Root must be SELECT, WITH...SELECT, UNION, INTERSECT, or EXCEPT
 * - Every token checked against DDL/DML and dangerous functions/clauses
 */
function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function validateReadOnlySql(rawSql: string): SqlGuardResult {
  // Check cheap bounds before trimming or lexing; very large inputs should not
  // trigger an additional allocation just to compute their UTF-8 byte length.
  if (rawSql.length > MAX_SQL_BYTES) {
    return { allowed: false, reason: `SQL exceeds the ${MAX_SQL_BYTES}-byte safety limit.`, normalizedRoot: null, rejectedTokens: ['SQL_TOO_LARGE'] };
  }
  if (hasUnpairedSurrogate(rawSql)) {
    return { allowed: false, reason: 'SQL contains invalid Unicode surrogate code points.', normalizedRoot: null, rejectedTokens: ['INVALID_UNICODE'] };
  }
  if (SQL_UTF8_ENCODER.encode(rawSql).byteLength > MAX_SQL_BYTES) {
    return { allowed: false, reason: `SQL exceeds the ${MAX_SQL_BYTES}-byte safety limit.`, normalizedRoot: null, rejectedTokens: ['SQL_TOO_LARGE'] };
  }

  const trimmed = rawSql.trim();
  if (!trimmed) {
    return { allowed: false, reason: 'Empty SQL statement.', normalizedRoot: null, rejectedTokens: [] };
  }

  if (trimmed.includes('\0')) {
    return { allowed: false, reason: 'SQL containing NUL characters is rejected.', normalizedRoot: null, rejectedTokens: ['NUL'] };
  }

  const scanned = stripSqlCommentsAndLiterals(trimmed);
  if (scanned.lexicalError) {
    return { allowed: false, reason: `Malformed SQL lexical structure: ${scanned.lexicalError}`, normalizedRoot: null, rejectedTokens: ['LEXICAL_ERROR'] };
  }
  // Allow a single trailing semicolon, reject any interior semicolon (stacked statements)
  const withoutTrailingSemi = scanned.stripped.replace(/;\s*$/, '');
  if (withoutTrailingSemi.includes(';')) {
    return {
      allowed: false,
      reason: 'Stacked SQL statements (multiple semicolons) are forbidden by PM-3.',
      normalizedRoot: null,
      rejectedTokens: [';'],
    };
  }

  const upper = withoutTrailingSemi.trim().toUpperCase();
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
