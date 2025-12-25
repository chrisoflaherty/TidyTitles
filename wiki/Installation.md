# Installation

## Requirements

- Python 3.11 or higher
- pip (Python package manager)

## Installation Methods

### From Source (Recommended)

```bash
# Clone the repository
git clone https://github.com/yourusername/file-renamer.git
cd file-renamer

# Install CLI only
pip install -e .

# Install with GUI support
pip install -e ".[gui]"

# Install with development tools
pip install -e ".[dev]"
```

### Dependencies

The following packages are installed automatically:

**Core Dependencies:**
| Package | Purpose |
|---------|---------|
| guessit | Filename parsing |
| httpx | Async HTTP client |
| click | CLI framework |
| rich | Terminal formatting |
| pydantic | Data validation |
| platformdirs | Cross-platform paths |

**GUI Dependencies (optional):**
| Package | Purpose |
|---------|---------|
| PySide6 | Qt6 GUI framework |

## Verifying Installation

After installation, verify everything works:

```bash
# Check CLI is available
file-renamer --version

# Check help
file-renamer --help

# Initialize configuration
file-renamer config init

# Show configuration
file-renamer config show
```

## Platform-Specific Notes

### macOS

No special requirements. Install using the standard method above.

### Windows

Ensure Python is added to your PATH during installation. You may need to use `py` instead of `python3`:

```bash
py -m pip install -e .
```

### Linux

You may need to install Python development headers:

```bash
# Debian/Ubuntu
sudo apt install python3-dev python3-pip

# Fedora
sudo dnf install python3-devel python3-pip

# Arch
sudo pacman -S python python-pip
```

For GUI support on Linux, you may need additional Qt dependencies:

```bash
# Debian/Ubuntu
sudo apt install libxcb-xinerama0

# Fedora
sudo dnf install qt6-qtbase
```

## Upgrading

To upgrade to the latest version:

```bash
cd file-renamer
git pull
pip install -e .
```

## Uninstalling

```bash
pip uninstall file-renamer
```

Configuration files are stored separately and won't be removed. To remove them manually:

- **macOS**: `rm -rf ~/Library/Application\ Support/file-renamer`
- **Windows**: Delete `%LOCALAPPDATA%\file-renamer`
- **Linux**: `rm -rf ~/.config/file-renamer`
