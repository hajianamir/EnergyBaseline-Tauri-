"""
Strict read-only SQL guard (PM-3).
Uses sqlglot.parse when installed, plus deterministic lexical/structural validator.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List, Optional

FORBIDDEN_KEYWORDS = {
    "INSERT",
    "UPDATE",
    "DELETE",
    "DROP",
    "ALTER",
    "CREATE",
    "TRUNCATE",
    "MERGE",
    "GRANT",
    "REVOKE",
    "REPLACE",
    "UPSERT",
    "ATTACH",
    "DETACH",
    "PRAGMA",
    "VACUUM",
    "REINDEX",
    "COPY",
    "CALL",
    "EXEC",
    "EXECUTE",
}

FORBIDDEN_CLAUSES = (
    "XP_CMDSHELL",
    "OPENROWSET",
    "OPENDATASOURCE",
    "LOAD_FILE",
    "LOAD_EXTENSION",
    "READFILE",
    "WRITEFILE",
    "PG_READ_FILE",
    "PG_READ_BINARY_FILE",
    "PG_LS_DIR",
    "INTO OUTFILE",
    "INTO DUMPFILE",
    "PG_SLEEP",
    "SLEEP",
    "BENCHMARK",
    "DBLINK",
    "DBLINK_EXEC",
    "LO_IMPORT",
    "LO_EXPORT",
)

MAX_SQL_LENGTH = 64 * 1024


@dataclass
class SqlGuardDecision:
    allowed: bool
    reason: str
    root_type: Optional[str]
    rejected_tokens: List[str]


def _strip_comments_and_strings(sql: str) -> tuple[str, Optional[str]]:
    """Strip SQL comments/string data, preserving separators and quoted identifiers."""
    out: List[str] = []
    i = 0
    n = len(sql)
    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""

        if (ch == "-" and nxt == "-") or ch == "#":
            while i < n and sql[i] not in "\r\n":
                i += 1
            out.append(" ")
            continue

        if ch == "/" and nxt == "*":
            i += 2
            depth = 1
            while i < n and depth > 0:
                if sql[i : i + 2] == "/*":
                    depth += 1
                    i += 2
                elif sql[i : i + 2] == "*/":
                    depth -= 1
                    i += 2
                else:
                    i += 1
            if depth:
                return "".join(out), "Unterminated block comment."
            out.append(" ")
            continue

        if ch == "'":
            i += 1
            terminated = False
            while i < n:
                if sql[i : i + 2] == "''":
                    i += 2
                elif sql[i] == "'":
                    i += 1
                    terminated = True
                    break
                else:
                    i += 1
            if not terminated:
                return "".join(out), "Unterminated string literal."
            out.append(" ")
            continue

        if ch == "$":
            match = re.match(r"\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$", sql[i:])
            if match:
                delimiter = match.group(0)
                end = sql.find(delimiter, i + len(delimiter))
                if end < 0:
                    return "".join(out), "Unterminated dollar-quoted string literal."
                i = end + len(delimiter)
                out.append(" ")
                continue

        if ch in {'"', "`", "["}:
            start = i
            close = "]" if ch == "[" else ch
            i += 1
            terminated = False
            while i < n:
                if sql[i] == close and i + 1 < n and sql[i + 1] == close:
                    i += 2
                elif sql[i] == close:
                    i += 1
                    terminated = True
                    break
                else:
                    i += 1
            if not terminated:
                return "".join(out), "Unterminated quoted identifier."
            out.append(sql[start:i])
            continue

        out.append(ch)
        i += 1
    return "".join(out).strip(), None


def validate_readonly_sql(raw_sql: str) -> SqlGuardDecision:
    if not raw_sql or not raw_sql.strip():
        return SqlGuardDecision(False, "Empty SQL query.", None, [])

    if len(raw_sql) > MAX_SQL_LENGTH:
        return SqlGuardDecision(False, f"SQL exceeds the {MAX_SQL_LENGTH}-character safety limit.", None, ["SQL_TOO_LARGE"])
    if "\x00" in raw_sql:
        return SqlGuardDecision(False, "SQL containing NUL characters is rejected.", None, ["NUL"])

    stripped, lexical_error = _strip_comments_and_strings(raw_sql)
    if lexical_error:
        return SqlGuardDecision(False, f"Malformed SQL lexical structure: {lexical_error}", None, ["LEXICAL_ERROR"])
    no_trailing_semi = re.sub(r";\s*$", "", stripped)
    if ";" in no_trailing_semi:
        return SqlGuardDecision(False, "Stacked SQL queries are forbidden.", None, [";"])

    upper = no_trailing_semi.strip().upper()
    rejected: List[str] = []

    for clause in FORBIDDEN_CLAUSES:
        clause_pat = r"\s+".join(re.escape(part) for part in clause.split())
        if re.search(rf"\b{clause_pat}\b", upper):
            rejected.append(clause)

    if re.search(r"\bSELECT\b[\s\S]*\bINTO\b\s+[A-Z0-9_.\"`]+", upper):
        rejected.append("SELECT INTO")

    tokens = [t for t in re.split(r"[^A-Z0-9_]+", upper) if t]
    for tok in tokens:
        if tok in FORBIDDEN_KEYWORDS:
            rejected.append(tok)

    if rejected:
        uniq = sorted(set(rejected))
        return SqlGuardDecision(False, f"Forbidden SQL operation(s): {', '.join(uniq)}", tokens[0] if tokens else None, uniq)

    first = tokens[0] if tokens else ""
    if first not in {"SELECT", "WITH", "UNION", "INTERSECT", "EXCEPT"}:
        return SqlGuardDecision(False, f"Root statement '{first}' is not read-only SELECT.", first or None, [first])

    if first == "WITH" and "SELECT" not in tokens:
        return SqlGuardDecision(False, "CTE must resolve to SELECT.", "WITH", ["WITH_NO_SELECT"])

    # Optional sqlglot AST double-check if installed
    try:
        import sqlglot
        from sqlglot import exp

        parsed = sqlglot.parse(raw_sql)
        if len(parsed) != 1 or parsed[0] is None:
            return SqlGuardDecision(False, "sqlglot rejected multi-statement or empty AST.", None, ["MULTI_AST"])
        root = parsed[0]
        if not isinstance(root, (exp.Select, exp.Union, exp.Intersect, exp.Except)):
            return SqlGuardDecision(False, f"sqlglot root {type(root).__name__} is not allowed.", type(root).__name__, [type(root).__name__])
        forbidden_nodes = (exp.Insert, exp.Update, exp.Delete, exp.Drop, exp.Alter, exp.Create, exp.Command)
        for node in root.walk():
            if isinstance(node, forbidden_nodes):
                return SqlGuardDecision(False, f"sqlglot AST contains forbidden node {type(node).__name__}.", first, [type(node).__name__])
    except ImportError:
        pass

    return SqlGuardDecision(True, "Read-only SQL verified.", first, [])
