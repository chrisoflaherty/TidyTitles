#!/bin/bash
#
# Create an AppImage for TidyTitles on Linux
#
# Usage:
#   ./create-appimage.sh [version]
#
# Example:
#   ./create-appimage.sh 1.0.0
#
# Requirements:
#   - TidyTitles executable must exist in dist/
#   - appimagetool (download from https://github.com/AppImage/AppImageKit/releases)
#   - Linux x86_64 system
#

set -e

# Configuration
APP_NAME="TidyTitles"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DIST_DIR="$PROJECT_ROOT/dist"
EXECUTABLE="$DIST_DIR/$APP_NAME"

# Get version from argument or default
VERSION="${1:-0.1.0}"
APPIMAGE_NAME="$APP_NAME-$VERSION-x86_64.AppImage"
APPIMAGE_PATH="$DIST_DIR/$APPIMAGE_NAME"

# AppDir structure
APPDIR="$DIST_DIR/$APP_NAME.AppDir"

echo "=============================================="
echo "  Creating AppImage for $APP_NAME"
echo "=============================================="
echo ""
echo "Version: $VERSION"
echo "Executable: $EXECUTABLE"
echo "Output: $APPIMAGE_PATH"
echo ""

# Check if executable exists
if [ ! -f "$EXECUTABLE" ]; then
    echo "Error: $EXECUTABLE not found!"
    echo ""
    echo "Build the executable first with:"
    echo "  python build.py"
    exit 1
fi

# Check for appimagetool
if ! command -v appimagetool &> /dev/null; then
    echo "Error: appimagetool not found!"
    echo ""
    echo "Download it from:"
    echo "  https://github.com/AppImage/AppImageKit/releases"
    echo ""
    echo "Then make it executable and add to PATH:"
    echo "  chmod +x appimagetool-x86_64.AppImage"
    echo "  sudo mv appimagetool-x86_64.AppImage /usr/local/bin/appimagetool"
    exit 1
fi

# Clean up previous AppDir
if [ -d "$APPDIR" ]; then
    echo "Removing previous AppDir..."
    rm -rf "$APPDIR"
fi

# Clean up previous AppImage
if [ -f "$APPIMAGE_PATH" ]; then
    echo "Removing previous AppImage..."
    rm "$APPIMAGE_PATH"
fi

echo "Creating AppDir structure..."
mkdir -p "$APPDIR/usr/bin"
mkdir -p "$APPDIR/usr/share/applications"
mkdir -p "$APPDIR/usr/share/icons/hicolor/256x256/apps"

echo "Copying executable..."
cp "$EXECUTABLE" "$APPDIR/usr/bin/"
chmod +x "$APPDIR/usr/bin/$APP_NAME"

# Also copy to root for AppRun
cp "$EXECUTABLE" "$APPDIR/"
chmod +x "$APPDIR/$APP_NAME"

echo "Copying desktop file..."
cp "$SCRIPT_DIR/TidyTitles.desktop" "$APPDIR/usr/share/applications/"
cp "$SCRIPT_DIR/TidyTitles.desktop" "$APPDIR/"

echo "Copying AppRun..."
cp "$SCRIPT_DIR/AppRun" "$APPDIR/"
chmod +x "$APPDIR/AppRun"

echo "Creating icon..."
# Create a simple SVG icon (placeholder - replace with real icon later)
cat > "$APPDIR/tidytitles.svg" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<svg width="256" height="256" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
  <rect width="256" height="256" rx="32" fill="#4A90D9"/>
  <text x="128" y="160" font-family="Arial, sans-serif" font-size="120" font-weight="bold"
        text-anchor="middle" fill="white">T</text>
</svg>
EOF

# Copy icon to standard locations
cp "$APPDIR/tidytitles.svg" "$APPDIR/usr/share/icons/hicolor/256x256/apps/"
cp "$APPDIR/tidytitles.svg" "$APPDIR/.DirIcon"

echo "Creating AppImage..."
ARCH=x86_64 appimagetool "$APPDIR" "$APPIMAGE_PATH"

echo "Cleaning up..."
rm -rf "$APPDIR"

# Get final size
APPIMAGE_SIZE_MB=$(du -m "$APPIMAGE_PATH" | cut -f1)

echo ""
echo "=============================================="
echo "  AppImage Created Successfully!"
echo "=============================================="
echo ""
echo "Output: $APPIMAGE_PATH"
echo "Size: ${APPIMAGE_SIZE_MB} MB"
echo ""
echo "To run:"
echo "  chmod +x \"$APPIMAGE_PATH\""
echo "  ./\"$APPIMAGE_PATH\""
echo ""
