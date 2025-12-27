#!/bin/bash
#
# Create a DMG installer for TidyTitles on macOS
#
# Usage:
#   ./create-dmg.sh [version]
#
# Example:
#   ./create-dmg.sh 1.0.0
#
# Requirements:
#   - TidyTitles.app must exist in dist/
#   - macOS with hdiutil (built-in)
#

set -e

# Configuration
APP_NAME="TidyTitles"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DIST_DIR="$PROJECT_ROOT/dist"
APP_BUNDLE="$DIST_DIR/$APP_NAME.app"

# Get version from argument or package
VERSION="${1:-0.1.0}"
DMG_NAME="$APP_NAME-$VERSION-macos.dmg"
DMG_PATH="$DIST_DIR/$DMG_NAME"

# Temporary directory for DMG contents
DMG_TEMP="$DIST_DIR/dmg-temp"
VOLUME_NAME="$APP_NAME $VERSION"

echo "=============================================="
echo "  Creating DMG Installer for $APP_NAME"
echo "=============================================="
echo ""
echo "Version: $VERSION"
echo "App Bundle: $APP_BUNDLE"
echo "Output: $DMG_PATH"
echo ""

# Check if app bundle exists
if [ ! -d "$APP_BUNDLE" ]; then
    echo "Error: $APP_BUNDLE not found!"
    echo ""
    echo "Build the app first with:"
    echo "  python build.py"
    exit 1
fi

# Clean up any previous DMG
if [ -f "$DMG_PATH" ]; then
    echo "Removing existing DMG..."
    rm "$DMG_PATH"
fi

# Clean up temp directory
if [ -d "$DMG_TEMP" ]; then
    rm -rf "$DMG_TEMP"
fi

echo "Creating temporary directory..."
mkdir -p "$DMG_TEMP"

echo "Copying app bundle..."
cp -R "$APP_BUNDLE" "$DMG_TEMP/"

echo "Creating Applications symlink..."
ln -s /Applications "$DMG_TEMP/Applications"

# Create a simple README
cat > "$DMG_TEMP/README.txt" << 'EOF'
TidyTitles - Media File Renamer

INSTALLATION:
  Drag TidyTitles.app to the Applications folder.

FIRST RUN:
  If macOS shows a security warning:
  1. Right-click (or Control+click) on TidyTitles
  2. Select "Open" from the menu
  3. Click "Open" in the dialog

UNINSTALL:
  Drag TidyTitles from Applications to Trash.

For more information, visit:
  https://github.com/chrisoflaherty/TidyTitles
EOF

echo "Creating DMG..."

# Calculate size needed (app size + 10MB buffer)
APP_SIZE=$(du -sm "$APP_BUNDLE" | cut -f1)
DMG_SIZE=$((APP_SIZE + 20))

# Create temporary DMG
TEMP_DMG="$DIST_DIR/temp.dmg"
hdiutil create -srcfolder "$DMG_TEMP" \
    -volname "$VOLUME_NAME" \
    -fs HFS+ \
    -fsargs "-c c=64,a=16,e=16" \
    -format UDRW \
    -size "${DMG_SIZE}m" \
    "$TEMP_DMG"

echo "Mounting DMG for customization..."
MOUNT_POINT="/Volumes/$VOLUME_NAME"

# Unmount if already mounted
if [ -d "$MOUNT_POINT" ]; then
    hdiutil detach "$MOUNT_POINT" -quiet || true
fi

hdiutil attach "$TEMP_DMG" -mountpoint "$MOUNT_POINT" -quiet

echo "Setting DMG window properties..."

# Use AppleScript to set window properties
osascript << EOF
tell application "Finder"
    tell disk "$VOLUME_NAME"
        open
        set current view of container window to icon view
        set toolbar visible of container window to false
        set statusbar visible of container window to false
        set the bounds of container window to {400, 100, 900, 450}
        set theViewOptions to the icon view options of container window
        set arrangement of theViewOptions to not arranged
        set icon size of theViewOptions to 80
        set position of item "$APP_NAME.app" of container window to {125, 170}
        set position of item "Applications" of container window to {375, 170}
        set position of item "README.txt" of container window to {250, 300}
        close
        open
        update without registering applications
        delay 2
    end tell
end tell
EOF

# Make sure changes are synced
sync

echo "Unmounting..."
hdiutil detach "$MOUNT_POINT" -quiet

echo "Converting to compressed DMG..."
hdiutil convert "$TEMP_DMG" \
    -format UDZO \
    -imagekey zlib-level=9 \
    -o "$DMG_PATH"

echo "Cleaning up..."
rm -f "$TEMP_DMG"
rm -rf "$DMG_TEMP"

# Get final size
DMG_SIZE_MB=$(du -m "$DMG_PATH" | cut -f1)

echo ""
echo "=============================================="
echo "  DMG Created Successfully!"
echo "=============================================="
echo ""
echo "Output: $DMG_PATH"
echo "Size: ${DMG_SIZE_MB} MB"
echo ""
echo "To test:"
echo "  open \"$DMG_PATH\""
echo ""
