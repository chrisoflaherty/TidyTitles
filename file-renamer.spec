# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec file for TidyTitles (File Renamer)

This file configures how PyInstaller bundles the application.
You typically won't need to edit this unless you add:
- New icon files -> add to datas
- New config templates -> add to datas
- Dynamic imports -> add to hiddenimports
"""

import sys
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

# Automatically collect all submodules from main package
hiddenimports = collect_submodules('file_renamer')

# Add known dependencies that might not be auto-detected
hiddenimports += [
    'PySide6.QtCore',
    'PySide6.QtGui',
    'PySide6.QtWidgets',
    'guessit',
    'httpx',
    'click',
    'rich',
    'pydantic',
    'pydantic_settings',
    'platformdirs',
]

# Collect data files (add icons, templates, etc. here if needed in the future)
datas = []
# Example for future: datas += [('src/file_renamer/icons', 'file_renamer/icons')]

block_cipher = None

a = Analysis(
    ['src/file_renamer/gui/main.py'],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Exclude unnecessary modules to reduce size
        'matplotlib',
        'numpy',
        'pandas',
        'PIL',
        'tkinter',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='TidyTitles',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,  # Set to False for GUI app (no console window)
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    # Icon configuration (uncomment and add icon path when you have one)
    # icon='assets/icon.ico',  # Windows
    # icon='assets/icon.icns',  # macOS
)

# macOS: Create .app bundle
if sys.platform == 'darwin':
    app = BUNDLE(
        exe,
        name='TidyTitles.app',
        icon=None,  # Add .icns file here when available
        bundle_identifier='com.filerenamer.tidytitles',
        info_plist={
            'NSPrincipalClass': 'NSApplication',
            'NSHighResolutionCapable': 'True',
            'CFBundleShortVersionString': '0.1.0',
        },
    )
