#!/usr/bin/env python3
"""Generate a CycloneDX 1.5 SBOM from the repository's committed lockfiles."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import tomllib
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
MAX_SBOM_BYTES = 900 * 1024  # Leave room for the JSON-RPC envelope under IPC-1's 1 MiB cap.


def _purl_component_name(value: str, *, safe: str = "") -> str:
    return quote(value, safe=safe)


def _component(
    *,
    name: str,
    version: str,
    purl: str,
    source_lock: str,
    hashes: list[dict[str, str]] | None = None,
    properties: list[dict[str, str]] | None = None,
) -> dict[str, object]:
    result: dict[str, object] = {
        "type": "library",
        "bom-ref": purl,
        "name": name,
        "version": version,
        "purl": purl,
        "properties": [{"name": "energybaseline:source-lockfile", "value": source_lock}],
    }
    if hashes:
        result["hashes"] = hashes
    if properties:
        result["properties"].extend(properties)  # type: ignore[union-attr]
    return result


def _add_component(components: dict[str, dict[str, object]], component: dict[str, object]) -> None:
    ref = str(component["bom-ref"])
    existing = components.get(ref)
    if existing is None:
        components[ref] = component
        return

    existing_properties = existing.setdefault("properties", [])
    seen = {(prop["name"], prop["value"]) for prop in existing_properties}  # type: ignore[union-attr]
    for prop in component.get("properties", []):  # type: ignore[union-attr]
        key = (prop["name"], prop["value"])
        if key not in seen:
            existing_properties.append(prop)  # type: ignore[union-attr]
            seen.add(key)


def _npm_components(components: dict[str, dict[str, object]]) -> None:
    lock_path = ROOT / "package-lock.json"
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    packages = lock.get("packages")
    if not isinstance(packages, dict) or "" not in packages:
        raise ValueError("package-lock.json must use the npm v7+ packages map")

    for lock_entry, record in packages.items():
        if not lock_entry or not isinstance(record, dict):
            continue
        version = record.get("version")
        if not isinstance(version, str) or not version:
            continue
        name = record.get("name")
        if not isinstance(name, str) or not name:
            name = lock_entry.rsplit("node_modules/", 1)[-1]
        purl_name = _purl_component_name(name, safe="/._-~")
        purl_version = _purl_component_name(version, safe=".-_~")
        purl = f"pkg:npm/{purl_name}@{purl_version}"

        hashes: list[dict[str, str]] = []
        integrity = record.get("integrity")
        if isinstance(integrity, str):
            for digest in integrity.split():
                algorithm, separator, encoded = digest.partition("-")
                if separator and algorithm.lower() in {"sha256", "sha384", "sha512"}:
                    try:
                        content = base64.b64decode(encoded, validate=True).hex()
                    except ValueError:
                        continue
                    hashes.append({"alg": algorithm.upper().replace("SHA", "SHA-"), "content": content})

        properties = [{"name": "energybaseline:lock-entry", "value": lock_entry}]
        if record.get("dev") is True:
            properties.append({"name": "energybaseline:build-dependency", "value": "true"})
        if record.get("optional") is True:
            properties.append({"name": "energybaseline:optional-dependency", "value": "true"})
        _add_component(
            components,
            _component(
                name=name,
                version=version,
                purl=purl,
                source_lock="package-lock.json",
                hashes=hashes,
                properties=properties,
            ),
        )


def _python_components(components: dict[str, dict[str, object]]) -> None:
    lock_path = ROOT / "sidecar" / "requirements-lock.txt"
    requirement_pattern = re.compile(
        r"^(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]+\])?==(?P<version>[A-Za-z0-9][A-Za-z0-9.!+_-]*)$"
    )
    for line_number, raw_line in enumerate(lock_path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw_line.split("#", 1)[0].strip()
        if not line:
            continue
        match = requirement_pattern.fullmatch(line)
        if not match:
            raise ValueError(f"Unsupported pinned requirement at {lock_path}:{line_number}: {raw_line!r}")
        name = match.group("name")
        version = match.group("version")
        normalized_name = re.sub(r"[-_.]+", "-", name).lower()
        purl = f"pkg:pypi/{_purl_component_name(normalized_name, safe='.-_~')}@{_purl_component_name(version, safe='.-_~')}"
        properties = []
        if normalized_name == "pyinstaller":
            properties.append({"name": "energybaseline:build-dependency", "value": "true"})
        _add_component(
            components,
            _component(
                name=name,
                version=version,
                purl=purl,
                source_lock="sidecar/requirements-lock.txt",
                properties=properties,
            ),
        )


def _cargo_components(components: dict[str, dict[str, object]]) -> None:
    lock_path = ROOT / "src-tauri" / "Cargo.lock"
    lock = tomllib.loads(lock_path.read_text(encoding="utf-8"))
    for record in lock.get("package", []):
        name = record.get("name")
        version = record.get("version")
        if not isinstance(name, str) or not isinstance(version, str):
            raise ValueError("Cargo.lock contains a package without a name or version")
        purl = f"pkg:cargo/{_purl_component_name(name.lower(), safe='.-_~')}@{_purl_component_name(version, safe='.-_~')}"
        source = record.get("source")
        if isinstance(source, str) and source.startswith("git+"):
            purl += f"?vcs_url={_purl_component_name(source)}"
        checksum = record.get("checksum")
        hashes = [{"alg": "SHA-256", "content": checksum}] if isinstance(checksum, str) and re.fullmatch(r"[0-9a-fA-F]{64}", checksum) else []
        _add_component(
            components,
            _component(
                name=name,
                version=version,
                purl=purl,
                source_lock="src-tauri/Cargo.lock",
                hashes=hashes,
            ),
        )


def generate_bom() -> dict[str, object]:
    components: dict[str, dict[str, object]] = {}
    _npm_components(components)
    _python_components(components)
    _cargo_components(components)

    lock_paths = [ROOT / "package-lock.json", ROOT / "sidecar" / "requirements-lock.txt", ROOT / "src-tauri" / "Cargo.lock"]
    lock_digest = hashlib.sha256()
    for path in lock_paths:
        lock_digest.update(path.relative_to(ROOT).as_posix().encode("utf-8"))
        lock_digest.update(b"\0")
        lock_digest.update(path.read_bytes())
        lock_digest.update(b"\0")
    serial = uuid.uuid5(uuid.NAMESPACE_URL, f"urn:energybaseline:lockfiles:{lock_digest.hexdigest()}")

    application_ref = f"pkg:generic/energybaseline@{json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']}"
    source_date_epoch = os.environ.get("SOURCE_DATE_EPOCH")
    generated_at = (
        datetime.fromtimestamp(int(source_date_epoch), tz=timezone.utc)
        if source_date_epoch is not None
        else datetime.now(timezone.utc)
    )
    timestamp = generated_at.isoformat(timespec="seconds").replace("+00:00", "Z")
    ordered_components = sorted(components.values(), key=lambda item: (str(item["name"]).casefold(), str(item["version"]), str(item["purl"])))
    return {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "serialNumber": f"urn:uuid:{serial}",
        "version": 1,
        "metadata": {
            "timestamp": timestamp,
            "component": {
                "type": "application",
                "bom-ref": application_ref,
                "name": "EnergyBaseline",
                "version": json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"],
                "purl": application_ref,
            },
            "properties": [
                {"name": "energybaseline:source-lockfile", "value": path.relative_to(ROOT).as_posix()}
                for path in lock_paths
            ],
        },
        "components": ordered_components,
    }


def main() -> int:
    bom = generate_bom()
    output = ROOT / "dist" / "sbom.cdx.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(bom, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    encoded = serialized.encode("utf-8")
    if len(encoded) > MAX_SBOM_BYTES:
        raise ValueError(f"Generated SBOM is {len(encoded)} bytes; limit is {MAX_SBOM_BYTES} bytes")
    temporary = output.with_name(output.name + ".tmp")
    temporary.write_bytes(encoded)
    temporary.replace(output)
    print(f"Generated {output.relative_to(ROOT)} ({len(bom['components'])} components, {len(encoded)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
