# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller --onedir spec for EnergyBaseline Python sidecar (Windows)."""

from pathlib import Path

block_cipher = None
sbom_path = Path(SPECPATH).resolve().parent / 'dist' / 'sbom.cdx.json'
if not sbom_path.is_file():
    raise FileNotFoundError(f'CycloneDX SBOM is missing; run npm run build first: {sbom_path}')

a = Analysis(
    ['energybaseline/main.py'],
    pathex=['.'],
    binaries=[],
    datas=[(str(sbom_path), 'energybaseline/data')],
    hiddenimports=[
        'energybaseline.config.settings',
        'energybaseline.persistence',
        'energybaseline.sql.guard',
        'energybaseline.ipc.protocol',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='energybaseline_sidecar',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='energybaseline_sidecar',
)
