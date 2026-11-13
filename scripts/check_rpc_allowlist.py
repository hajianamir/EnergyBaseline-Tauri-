#!/usr/bin/env python3
"""Fail when the Rust and Python sidecar method ACLs drift apart."""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PYTHON_PROTOCOL = ROOT / "sidecar" / "energybaseline" / "ipc" / "protocol.py"
RUST_BRIDGE = ROOT / "src-tauri" / "src" / "lib.rs"


def _validate_methods(methods: list[str], source: str) -> set[str]:
    if not methods:
        raise ValueError(f"No method names found in {source}.")
    duplicates = sorted({method for method in methods if methods.count(method) > 1})
    if duplicates:
        raise ValueError(f"Duplicate methods in {source}: {', '.join(duplicates)}")
    if any(not method or method.strip() != method for method in methods):
        raise ValueError(f"Empty or whitespace-padded method name in {source}.")
    return set(methods)


def extract_python_methods(path: Path = PYTHON_PROTOCOL) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    assignments = [
        statement
        for statement in tree.body
        if isinstance(statement, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == "ALLOWLISTED_METHODS" for target in statement.targets)
    ]
    if len(assignments) != 1:
        raise ValueError(f"Expected one top-level ALLOWLISTED_METHODS assignment in {path}.")
    value_node = assignments[0].value
    if not isinstance(value_node, (ast.Set, ast.List, ast.Tuple)):
        raise ValueError(f"ALLOWLISTED_METHODS in {path} must be a literal collection of strings.")
    methods = [ast.literal_eval(item) for item in value_node.elts]
    if not all(isinstance(item, str) for item in methods):
        raise ValueError(f"ALLOWLISTED_METHODS in {path} must contain only strings.")
    return _validate_methods(methods, str(path))


def extract_rust_methods(path: Path = RUST_BRIDGE) -> set[str]:
    source = path.read_text(encoding="utf-8")
    matches = re.findall(
        r"const\s+ALLOWLIST\s*:\s*&\[\s*&str\s*\]\s*=\s*&\[(.*?)\]\s*;",
        source,
        flags=re.DOTALL,
    )
    if len(matches) != 1:
        raise ValueError(f"Expected one Rust ALLOWLIST string slice in {path}; found {len(matches)}.")
    methods = re.findall(r'"([^"\\]*(?:\\.[^"\\]*)*)"', matches[0])
    if any("\\" in method for method in methods):
        raise ValueError(f"Escaped Rust strings are not supported in the method allowlist in {path}.")
    return _validate_methods(methods, str(path))


def main() -> int:
    try:
        python_methods = extract_python_methods()
        rust_methods = extract_rust_methods()
    except (OSError, SyntaxError, ValueError) as error:
        print(f"RPC allowlist check failed: {error}", file=sys.stderr)
        return 2

    if python_methods != rust_methods:
        print("RPC allowlists differ:", file=sys.stderr)
        for label, methods in (
            ("Python-only", sorted(python_methods - rust_methods)),
            ("Rust-only", sorted(rust_methods - python_methods)),
        ):
            if methods:
                print(f"  {label}: {', '.join(methods)}", file=sys.stderr)
        return 1

    print(f"RPC allowlists match ({len(python_methods)} methods).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
