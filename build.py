#!/usr/bin/env python3
"""
Automated build script for TidyTitles

This script builds a standalone executable using PyInstaller and optionally
creates platform-specific installers.

Usage:
    python build.py                    # Build executable only
    python build.py --installer        # Build executable + installer
    python build.py --installer-only   # Create installer from existing build
    python build.py --clean            # Clean build artifacts first
    python build.py --help             # Show help
"""

import argparse
import platform
import shutil
import subprocess
import sys
from pathlib import Path

# Version - update this for releases
APP_VERSION = "0.1.0"


def get_platform_name() -> str:
    """Get a friendly platform name."""
    system = platform.system().lower()
    machine = platform.machine().lower()

    if system == 'windows':
        return 'windows'
    elif system == 'darwin':
        return 'macos'
    elif system == 'linux':
        return f'linux-{machine}'
    else:
        return f'{system}-{machine}'


def clean_build_artifacts():
    """Remove previous build artifacts."""
    print("🧹 Cleaning previous build artifacts...")

    dirs_to_remove = ['build', 'dist']
    files_to_remove = ['*.spec~']

    for dir_name in dirs_to_remove:
        dir_path = Path(dir_name)
        if dir_path.exists():
            print(f"   Removing {dir_path}/")
            shutil.rmtree(dir_path)

    print("✅ Clean complete\n")


def check_dependencies():
    """Verify all required dependencies are installed."""
    print("🔍 Checking dependencies...")

    try:
        import PyInstaller
        print(f"   ✅ PyInstaller {PyInstaller.__version__}")
    except ImportError:
        print("   ❌ PyInstaller not found")
        print("\n💡 Install build dependencies with:")
        print("   pip install -e \".[build,gui]\"")
        sys.exit(1)

    try:
        import PySide6
        print(f"   ✅ PySide6 {PySide6.__version__}")
    except ImportError:
        print("   ❌ PySide6 not found")
        print("\n💡 Install GUI dependencies with:")
        print("   pip install -e \".[gui]\"")
        sys.exit(1)

    # Check for the main package
    try:
        import file_renamer
        print(f"   ✅ file_renamer {file_renamer.__version__}")
    except ImportError:
        print("   ❌ file_renamer package not found")
        print("\n💡 Install the package first with:")
        print("   pip install -e .")
        sys.exit(1)

    print("✅ All dependencies satisfied\n")


def build_executable():
    """Run PyInstaller to build the executable."""
    print("🔨 Building executable with PyInstaller...")
    print(f"   Platform: {get_platform_name()}")
    print(f"   Python: {sys.version.split()[0]}")
    print()

    spec_file = Path('file-renamer.spec')
    if not spec_file.exists():
        print(f"❌ Error: {spec_file} not found!")
        sys.exit(1)

    # Run PyInstaller
    cmd = [sys.executable, '-m', 'PyInstaller', str(spec_file), '--clean']

    print(f"   Running: {' '.join(cmd)}")
    print()

    try:
        result = subprocess.run(cmd, check=True)
        return result.returncode == 0
    except subprocess.CalledProcessError as e:
        print(f"\n❌ Build failed with error code {e.returncode}")
        return False


def create_macos_dmg() -> bool:
    """Create a macOS DMG installer."""
    print("\n" + "=" * 60)
    print("📦 Creating macOS DMG Installer")
    print("=" * 60 + "\n")

    script_path = Path('installer/macos/create-dmg.sh')
    if not script_path.exists():
        print(f"❌ Error: {script_path} not found!")
        return False

    try:
        result = subprocess.run(
            ['bash', str(script_path), APP_VERSION],
            check=True
        )
        return result.returncode == 0
    except subprocess.CalledProcessError as e:
        print(f"\n❌ DMG creation failed with error code {e.returncode}")
        return False
    except FileNotFoundError:
        print("❌ Error: bash not found")
        return False


def create_windows_installer() -> bool:
    """Create a Windows NSIS installer."""
    print("\n" + "=" * 60)
    print("📦 Creating Windows NSIS Installer")
    print("=" * 60 + "\n")

    nsi_path = Path('installer/windows/tidytitles.nsi')
    if not nsi_path.exists():
        print(f"❌ Error: {nsi_path} not found!")
        return False

    # Check if makensis is available
    makensis_cmd = 'makensis'
    if platform.system() == 'Windows':
        # Try common NSIS install locations on Windows
        nsis_paths = [
            Path(r'C:\Program Files (x86)\NSIS\makensis.exe'),
            Path(r'C:\Program Files\NSIS\makensis.exe'),
        ]
        for nsis_path in nsis_paths:
            if nsis_path.exists():
                makensis_cmd = str(nsis_path)
                break

    try:
        # Update version in NSI file before building
        print(f"   Building installer for version {APP_VERSION}...")

        # Run from project root with absolute path to script
        result = subprocess.run(
            [makensis_cmd, f'-DAPP_VERSION={APP_VERSION}', str(nsi_path.resolve())],
            check=True
        )
        return result.returncode == 0
    except subprocess.CalledProcessError as e:
        print(f"\n❌ NSIS build failed with error code {e.returncode}")
        return False
    except FileNotFoundError:
        print("❌ Error: makensis not found!")
        print("\n💡 Install NSIS from: https://nsis.sourceforge.io/")
        if platform.system() == 'Darwin':
            print("   On macOS: brew install makensis")
        elif platform.system() == 'Linux':
            print("   On Linux: sudo apt install nsis")
        return False


def create_linux_appimage() -> bool:
    """Create a Linux AppImage."""
    print("\n" + "=" * 60)
    print("📦 Creating Linux AppImage")
    print("=" * 60 + "\n")

    script_path = Path('installer/linux/create-appimage.sh')
    if not script_path.exists():
        print(f"❌ Error: {script_path} not found!")
        return False

    try:
        result = subprocess.run(
            ['bash', str(script_path), APP_VERSION],
            check=True
        )
        return result.returncode == 0
    except subprocess.CalledProcessError as e:
        print(f"\n❌ AppImage creation failed with error code {e.returncode}")
        return False
    except FileNotFoundError:
        print("❌ Error: bash not found")
        return False


def create_installer() -> bool:
    """Create installer for the current platform."""
    system = platform.system()

    if system == 'Darwin':
        return create_macos_dmg()
    elif system == 'Windows':
        return create_windows_installer()
    elif system == 'Linux':
        return create_linux_appimage()
    else:
        print(f"❌ Unsupported platform for installer: {system}")
        return False


def show_results(include_installer: bool = False):
    """Display information about the built executable."""
    print("\n" + "=" * 60)
    print("🎉 Build Complete!")
    print("=" * 60)

    dist_dir = Path('dist')

    if platform.system() == 'Darwin':
        # macOS .app bundle
        app_bundle = dist_dir / 'TidyTitles.app'
        if app_bundle.exists():
            size_mb = sum(f.stat().st_size for f in app_bundle.rglob('*') if f.is_file()) / (1024 * 1024)
            print(f"\n📦 Application bundle: {app_bundle}")
            print(f"   Size: {size_mb:.1f} MB")

        # Check for DMG installer
        dmg_file = dist_dir / f'TidyTitles-{APP_VERSION}-macos.dmg'
        if include_installer and dmg_file.exists():
            dmg_size_mb = dmg_file.stat().st_size / (1024 * 1024)
            print(f"\n💿 DMG Installer: {dmg_file}")
            print(f"   Size: {dmg_size_mb:.1f} MB")
            print(f"\n📤 To distribute:")
            print(f"   Share the DMG file - users drag app to Applications")
        elif app_bundle.exists():
            print(f"\n🚀 To run:")
            print(f"   open {app_bundle}")
            print(f"\n📤 To share:")
            print(f"   1. Zip the .app bundle, or")
            print(f"   2. Run: python build.py --installer")

    elif platform.system() == 'Windows':
        # Windows .exe
        exe_file = dist_dir / 'TidyTitles.exe'
        if exe_file.exists():
            size_mb = exe_file.stat().st_size / (1024 * 1024)
            print(f"\n📦 Executable: {exe_file}")
            print(f"   Size: {size_mb:.1f} MB")

        # Check for NSIS installer
        installer_file = dist_dir / f'TidyTitles-{APP_VERSION}-windows-setup.exe'
        if include_installer and installer_file.exists():
            inst_size_mb = installer_file.stat().st_size / (1024 * 1024)
            print(f"\n💿 Windows Installer: {installer_file}")
            print(f"   Size: {inst_size_mb:.1f} MB")
            print(f"\n📤 To distribute:")
            print(f"   Share the installer - users get Start Menu & uninstaller")
        elif exe_file.exists():
            print(f"\n🚀 To run:")
            print(f"   Double-click: {exe_file}")
            print(f"\n📤 To share:")
            print(f"   1. Share the .exe file directly, or")
            print(f"   2. Run: python build.py --installer")

    else:
        # Linux executable
        exe_file = dist_dir / 'TidyTitles'
        if exe_file.exists():
            size_mb = exe_file.stat().st_size / (1024 * 1024)
            print(f"\n📦 Executable: {exe_file}")
            print(f"   Size: {size_mb:.1f} MB")

        # Check for AppImage
        appimage_file = dist_dir / f'TidyTitles-{APP_VERSION}-x86_64.AppImage'
        if include_installer and appimage_file.exists():
            ai_size_mb = appimage_file.stat().st_size / (1024 * 1024)
            print(f"\n💿 AppImage: {appimage_file}")
            print(f"   Size: {ai_size_mb:.1f} MB")
            print(f"\n📤 To distribute:")
            print(f"   Share the AppImage - users just chmod +x and run")
        elif exe_file.exists():
            print(f"\n🚀 To run:")
            print(f"   chmod +x {exe_file}")
            print(f"   ./{exe_file}")
            print(f"\n📤 To share:")
            print(f"   1. Share the executable directly, or")
            print(f"   2. Run: python build.py --installer")

    print("\n" + "=" * 60)


def main():
    """Main build orchestration."""
    parser = argparse.ArgumentParser(
        description='Build TidyTitles standalone executable and installers',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python build.py                    Build executable only
  python build.py --installer        Build executable + installer
  python build.py --installer-only   Create installer from existing build
  python build.py --clean            Clean previous builds first

After building, files will be in the dist/ directory.

Installers created:
  macOS:   TidyTitles-x.x.x-macos.dmg
  Windows: TidyTitles-x.x.x-windows-setup.exe
  Linux:   TidyTitles-x.x.x-x86_64.AppImage
        """
    )
    parser.add_argument(
        '--clean',
        action='store_true',
        help='Clean build artifacts before building'
    )
    parser.add_argument(
        '--installer',
        action='store_true',
        help='Create platform-specific installer after building'
    )
    parser.add_argument(
        '--installer-only',
        action='store_true',
        help='Create installer from existing build (skip PyInstaller)'
    )

    args = parser.parse_args()

    print("=" * 60)
    print("TidyTitles - Standalone Executable Builder")
    print(f"Version: {APP_VERSION}")
    print("=" * 60)
    print()

    # Clean if requested
    if args.clean:
        clean_build_artifacts()

    # If installer-only, skip the build step
    if args.installer_only:
        print("🔍 Creating installer from existing build...")
        print()

        # Check if build exists
        dist_dir = Path('dist')
        if platform.system() == 'Darwin':
            if not (dist_dir / 'TidyTitles.app').exists():
                print("❌ Error: dist/TidyTitles.app not found!")
                print("   Run 'python build.py' first to build the executable.")
                return 1
        elif platform.system() == 'Windows':
            if not (dist_dir / 'TidyTitles.exe').exists():
                print("❌ Error: dist/TidyTitles.exe not found!")
                print("   Run 'python build.py' first to build the executable.")
                return 1
        else:
            if not (dist_dir / 'TidyTitles').exists():
                print("❌ Error: dist/TidyTitles not found!")
                print("   Run 'python build.py' first to build the executable.")
                return 1

        if create_installer():
            show_results(include_installer=True)
            return 0
        else:
            print("\n❌ Installer creation failed.")
            return 1

    # Check all dependencies
    check_dependencies()

    # Build the executable
    success = build_executable()

    if not success:
        print("\n❌ Build failed. Check the error messages above.")
        return 1

    # Create installer if requested
    if args.installer:
        installer_success = create_installer()
        show_results(include_installer=installer_success)
        if not installer_success:
            print("\n⚠️  Executable built, but installer creation failed.")
            return 1
    else:
        show_results(include_installer=False)

    return 0


if __name__ == '__main__':
    sys.exit(main())
