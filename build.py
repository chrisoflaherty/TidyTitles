#!/usr/bin/env python3
"""
Automated build script for TidyTitles

This script builds a standalone executable using PyInstaller.
No need to edit this file when adding features - it auto-detects everything!

Usage:
    python build.py              # Build for current platform
    python build.py --clean      # Clean build artifacts first
    python build.py --help       # Show help
"""

import argparse
import platform
import shutil
import subprocess
import sys
from pathlib import Path


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


def show_results():
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
            print(f"\n🚀 To run:")
            print(f"   open {app_bundle}")
            print(f"\n📤 To share:")
            print(f"   1. Zip the .app bundle")
            print(f"   2. Share the .zip file")
            print(f"   3. Recipients: Unzip and drag to Applications folder")

    elif platform.system() == 'Windows':
        # Windows .exe
        exe_file = dist_dir / 'TidyTitles.exe'
        if exe_file.exists():
            size_mb = exe_file.stat().st_size / (1024 * 1024)
            print(f"\n📦 Executable: {exe_file}")
            print(f"   Size: {size_mb:.1f} MB")
            print(f"\n🚀 To run:")
            print(f"   Double-click: {exe_file}")
            print(f"\n📤 To share:")
            print(f"   1. Share the .exe file directly, or")
            print(f"   2. Create a .zip for easier distribution")

    else:
        # Linux executable
        exe_file = dist_dir / 'TidyTitles'
        if exe_file.exists():
            size_mb = exe_file.stat().st_size / (1024 * 1024)
            print(f"\n📦 Executable: {exe_file}")
            print(f"   Size: {size_mb:.1f} MB")
            print(f"\n🚀 To run:")
            print(f"   chmod +x {exe_file}")
            print(f"   ./{exe_file}")
            print(f"\n📤 To share:")
            print(f"   1. Share the executable directly, or")
            print(f"   2. Create a .tar.gz archive")

    print("\n" + "=" * 60)


def main():
    """Main build orchestration."""
    parser = argparse.ArgumentParser(
        description='Build TidyTitles standalone executable',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python build.py              Build for current platform
  python build.py --clean      Clean previous builds first

After building, the executable will be in the dist/ directory.
        """
    )
    parser.add_argument(
        '--clean',
        action='store_true',
        help='Clean build artifacts before building'
    )

    args = parser.parse_args()

    print("=" * 60)
    print("TidyTitles - Standalone Executable Builder")
    print("=" * 60)
    print()

    # Clean if requested
    if args.clean:
        clean_build_artifacts()

    # Check all dependencies
    check_dependencies()

    # Build the executable
    success = build_executable()

    if success:
        show_results()
        return 0
    else:
        print("\n❌ Build failed. Check the error messages above.")
        return 1


if __name__ == '__main__':
    sys.exit(main())
