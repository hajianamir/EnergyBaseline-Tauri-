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
    "INTO OUTFILE",
    "INTO DUMPFILE",
    "PG_SLEEP",
    "DBLINK",
)


@dataclass
class SqlGuardDecision:
    allowed: bool
    reason: str
    root_type: Optional[str]
    rejected_tokens: List[str]


def _strip_comments_and_strings(sql: str) -> str:
    out: List[str] = []
    i = 0
    in_single = False
    in_double = False
    n = len(sql)
    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        if not in_single and not in_double and ch == "-" and nxt == "-":
            while i < n and sql[i] != "\n":
                i += 1
            out.append(" ")
            continue
        if not in_single and not in_double and ch == "/" and nxt == "*":
            i += 2
            while i < n and not (sql[i] == "*" and (i + 1 < n and sql[i + 1] == "/")):
                i += 1
            i += 2
            out.append(" ")
            continue
        if ch == "'" and not in_double:
            in_single = not in_single
            out.append(" ")
            i += 1
            continue
        if ch == '"' and not in_single:
            in_double = not in_double
            out.append(ch)
            i += 1
            continue
        out.append(" " if in_single else ch)
        i += 1
    return "".join(out).strip()


def validate_readonly_sql(raw_sql: str) -> SqlGuardDecision:
    if not raw_sql or not raw_sql.strip():
        return SqlGuardDecision(False, "Empty SQL query.", None, [])

    stripped = _strip_comments_and_strings(raw_sql)
    no_trailing_semi = re.sub(r";\s*$", "", stripped)
    if ";" in no_trailing_semi:
        return SqlGuardDecision(False, "Stacked SQL queries are forbidden.", None, [";"])

    upper = no_trailing_semi.upper()
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
