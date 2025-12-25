"""GUI entry point."""

import sys


def main() -> None:
    """Launch the GUI application."""
    try:
        from PySide6.QtWidgets import QApplication
    except ImportError:
        print("Error: PySide6 is not installed.")
        print("Install it with: pip install file-renamer[gui]")
        sys.exit(1)

    from file_renamer.gui.app import FileRenamerApp

    app = QApplication(sys.argv)
    app.setApplicationName("File Renamer")
    app.setOrganizationName("FileRenamer")

    window = FileRenamerApp()
    window.show()

    sys.exit(app.exec())


if __name__ == "__main__":
    main()
