# Building TidyTitles for Distribution

This guide shows you how to build TidyTitles as a **standalone executable** and create **platform-specific installers** that can be shared with friends and family who don't have Python installed.

## Building from Scratch

Complete step-by-step instructions for each platform.

### Windows

**Prerequisites:**
```cmd
:: Install Python 3.11+ (from python.org or Microsoft Store)
winget install Python.Python.3.12

:: Install NSIS (for creating the installer)
winget install NSIS.NSIS

:: Install Git
winget install Git.Git
```

**Build Steps:**
```cmd
:: 1. Clone the repository
git clone https://github.com/chrisoflaherty/TidyTitles.git
cd TidyTitles

:: 2. Create virtual environment
python -m venv venv
venv\Scripts\activate

:: 3. Install dependencies
pip install -e ".[build,gui]"

:: 4. Build executable + installer
python build.py --installer

:: 5. Find your files in dist\
::    - TidyTitles.exe (standalone)
::    - TidyTitles-0.1.0-windows-setup.exe (installer)
```

### macOS

**Prerequisites:**
- Python 3.11+ (pre-installed or `brew install python`)
- Xcode Command Line Tools: `xcode-select --install`

**Build Steps:**
```bash
# 1. Clone the repository
git clone https://github.com/chrisoflaherty/TidyTitles.git
cd TidyTitles

# 2. Create virtual environment
python3 -m venv venv
source venv/bin/activate

# 3. Install dependencies
pip install -e ".[build,gui]"

# 4. Build executable + installer
python build.py --installer

# 5. Find your files in dist/
#    - TidyTitles.app (app bundle)
#    - TidyTitles-0.1.0-macos.dmg (installer)
```

### Linux

**Prerequisites:**
```bash
# Ubuntu/Debian
sudo apt update
sudo apt install python3 python3-venv python3-pip git

# For AppImage creation
wget https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage
chmod +x appimagetool-x86_64.AppImage
sudo mv appimagetool-x86_64.AppImage /usr/local/bin/appimagetool
```

**Build Steps:**
```bash
# 1. Clone the repository
git clone https://github.com/chrisoflaherty/TidyTitles.git
cd TidyTitles

# 2. Create virtual environment
python3 -m venv venv
source venv/bin/activate

# 3. Install dependencies
pip install -e ".[build,gui]"

# 4. Build executable + installer
python build.py --installer

# 5. Find your files in dist/
#    - TidyTitles (executable)
#    - TidyTitles-0.1.0-x86_64.AppImage (installer)
```

---

## Quick Reference

For developers who already have the prerequisites:

```bash
# Clone and setup
git clone https://github.com/chrisoflaherty/TidyTitles.git
cd TidyTitles
python3 -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -e ".[build,gui]"

# Build
python build.py --installer
```

## Output Files

After building with `--installer`, look in `dist/`:

| Platform | Executable | Installer |
|----------|------------|-----------|
| Windows | `TidyTitles.exe` | `TidyTitles-x.x.x-windows-setup.exe` |
| macOS | `TidyTitles.app` | `TidyTitles-x.x.x-macos.dmg` |
| Linux | `TidyTitles` | `TidyTitles-x.x.x-x86_64.AppImage` |

## Sharing With Others

### Windows

**Option A: With Installer (Recommended)**
1. Build with: `python build.py --installer`
2. Share `TidyTitles-x.x.x-windows-setup.exe`
3. Recipients: Run installer → Next → Install → Done!
4. Includes: Start Menu shortcut, Desktop shortcut, Uninstaller

**Option B: Portable Executable**
1. Share the `TidyTitles.exe` file directly
2. Recipients: Just double-click to run!

**No Python installation needed!**

### macOS

**Option A: With DMG Installer (Recommended)**
1. Build with: `python build.py --installer`
2. Share `TidyTitles-x.x.x-macos.dmg`
3. Recipients: Open DMG → Drag to Applications → Eject
4. Uninstall: Drag from Applications to Trash

**Option B: App Bundle**
1. Right-click `TidyTitles.app` → Compress
2. Share the resulting `.zip` file
3. Recipients: Unzip and drag to Applications folder

**Note**: First time running may show a security warning. Recipients should:
- Right-click the app → Open (instead of double-click)
- Click "Open" in the security dialog

### Linux

**Option A: With AppImage (Recommended)**
1. Build with: `python build.py --installer`
2. Share `TidyTitles-x.x.x-x86_64.AppImage`
3. Recipients:
   ```bash
   chmod +x TidyTitles-*.AppImage
   ./TidyTitles-*.AppImage
   ```
4. Uninstall: Just delete the file

**Option B: Raw Executable**
1. Share the `TidyTitles` executable
2. Create a tarball: `tar -czf TidyTitles.tar.gz -C dist TidyTitles`
3. Recipients:
   ```bash
   chmod +x TidyTitles
   ./TidyTitles
   ```

## Advanced Usage

### Clean Build

Remove previous build artifacts before building:

```bash
python build.py --clean
```

### Build Options

```bash
python build.py                    # Build executable only
python build.py --installer        # Build executable + installer
python build.py --installer-only   # Create installer from existing build
python build.py --clean            # Clean previous builds first
python build.py --clean --installer # Clean, build, and create installer
```

The build script automatically:
- ✅ Detects all Python dependencies from `pyproject.toml`
- ✅ Bundles PySide6 GUI framework
- ✅ Includes all your code from `src/file_renamer/`
- ✅ Creates a single-file executable (Windows/Linux) or .app bundle (macOS)
- ✅ Optimizes for size (excludes unnecessary libraries)

### Installer Requirements

**macOS DMG:**
- No extra tools needed (uses built-in `hdiutil`)

**Windows NSIS:**
- Install NSIS: https://nsis.sourceforge.io/
- Or on Windows: `winget install NSIS.NSIS`
- On macOS (for cross-compile): `brew install makensis`
- On Linux: `sudo apt install nsis`

**Linux AppImage:**
- Install appimagetool: https://github.com/AppImage/AppImageKit/releases
- Make executable: `chmod +x appimagetool-x86_64.AppImage`
- Add to PATH: `sudo mv appimagetool-x86_64.AppImage /usr/local/bin/appimagetool`

## When You Add Features

**Good news**: You rarely need to touch the build files!

### No Changes Needed:
- ✅ Adding new Python code
- ✅ Adding dependencies to `pyproject.toml`
- ✅ Bug fixes
- ✅ New CLI commands
- ✅ Most new features

Just run `python build.py` again!

### Might Need Updates:
- ⚠️ **Adding icon files**: Edit `file-renamer.spec`, uncomment the icon lines
- ⚠️ **Adding data files** (templates, configs): Add to `datas` list in `file-renamer.spec`
- ⚠️ **Dynamic imports**: Add module names to `hiddenimports` in `file-renamer.spec`

The spec file has comments showing exactly what to change.

## Troubleshooting

### Build fails with "PyInstaller not found"

```bash
pip install -e ".[build,gui]"
```

### Build fails with "file_renamer not found"

Install the package in development mode:

```bash
pip install -e .
```

### Executable is very large (>200 MB)

This is normal! The executable includes:
- Python interpreter (~15 MB)
- PySide6/Qt framework (~50-80 MB)
- All dependencies
- Your application code

You can reduce size by:
- Using UPX compression (already enabled)
- Excluding unused Qt modules (advanced)

### "Application damaged" error on macOS

Your app needs to be code-signed for distribution. Options:
1. **Simple**: Recipients right-click → Open (bypasses Gatekeeper)
2. **Advanced**: Get Apple Developer account and sign the app

### Antivirus flags the .exe (Windows)

This is common with PyInstaller apps. Solutions:
1. Add your build to antivirus exceptions
2. Submit the .exe to Microsoft for analysis (removes false positive)
3. Use a code signing certificate (costs money, but prevents warnings)

## File Size Comparison

Typical build sizes:
- **Windows**: 60-90 MB (.exe)
- **macOS**: 70-100 MB (.app bundle)
- **Linux**: 60-90 MB (executable)

This is normal and expected - it includes everything needed to run!

## Customization

### Change Application Name

Edit `file-renamer.spec`:
```python
name='YourAppName',  # Change this line
```

### Add an Icon

1. Get icon files:
   - Windows: `.ico` file (256x256 or multi-size)
   - macOS: `.icns` file
   - Linux: `.png` file (used by desktop entries)

2. Edit `file-renamer.spec`:
   ```python
   # For Windows/Linux
   icon='path/to/icon.ico',

   # For macOS app bundle
   app = BUNDLE(
       exe,
       icon='path/to/icon.icns',
       ...
   )
   ```

3. Rebuild: `python build.py --clean`

## Platform-Specific Notes

### Windows
- Single `.exe` file - easiest to distribute
- May need to disable antivirus temporarily during build
- First-time users may see SmartScreen warning (normal)

### macOS
- Creates `.app` bundle (folder that looks like an app)
- Gatekeeper may block unsigned apps
- Recipients should right-click → Open first time

### Linux
- Single executable file
- Recipient needs to `chmod +x` first
- May need to install system libraries (very rare with PyInstaller)

## Automated Builds (Optional)

You can set up GitHub Actions to automatically build for all platforms:

1. Push code to GitHub
2. GitHub Actions builds Windows, macOS, and Linux versions
3. Download all three from the "Releases" page

See `.github/workflows/build.yml` for setup (coming soon).

## Questions?

- **Build issues**: Check the error message and troubleshooting section above
- **App doesn't start**: Run from terminal to see error messages
- **Feature requests**: Open an issue on GitHub

## Summary

**Building**: `python build.py`
**Sharing**: Send the file from `dist/` folder
**Updating**: Just rebuild after making changes

**That's it!** Your friends and family can now use TidyTitles without installing Python or any dependencies.
