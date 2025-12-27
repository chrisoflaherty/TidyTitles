"""Main CLI entry point."""

import asyncio
from pathlib import Path
from typing import Optional

import click
from rich.console import Console
from rich.progress import (
    Progress,
    SpinnerColumn,
    TextColumn,
    BarColumn,
    TaskProgressColumn,
    TimeRemainingColumn,
    MofNCompleteColumn,
)
from rich.table import Table

from file_renamer.core.conflict_resolution import ConflictStrategy
from file_renamer.core.models import MediaType, RenameStatus
from file_renamer.core.parser import create_parser
from file_renamer.core.renamer import FileRenamer
from file_renamer.core.template import TemplateEngine
from file_renamer.providers.cache import APICache
from file_renamer.providers.tmdb import TMDBClient
from file_renamer.providers.tvdb import TVDBClient
from file_renamer.services.config_service import ConfigService
from file_renamer.services.rename_service import RenameService

console = Console()


def get_config_service() -> ConfigService:
    """Get the config service instance."""
    return ConfigService()


@click.group()
@click.version_option()
def cli() -> None:
    """File Renamer - Rename media files using TMDB/TVDB metadata."""
    pass


@cli.command()
@click.argument("path", type=click.Path(exists=True, path_type=Path))
@click.option(
    "--type",
    "-t",
    "media_type",
    type=click.Choice(["movie", "tv", "auto"]),
    default="auto",
    help="Media type (movie, tv, or auto-detect)",
)
@click.option(
    "--recursive",
    "-r",
    is_flag=True,
    help="Scan directories recursively",
)
@click.option(
    "--output",
    "-o",
    type=click.Path(path_type=Path),
    help="Output directory for renamed files",
)
@click.option(
    "--dry-run",
    "-n",
    is_flag=True,
    help="Preview changes without renaming",
)
@click.option(
    "--yes",
    "-y",
    is_flag=True,
    help="Skip confirmation prompt",
)
@click.option(
    "--auto-select",
    "-a",
    is_flag=True,
    help="Automatically select first match when multiple results found",
)
def rename(
    path: Path,
    media_type: str,
    recursive: bool,
    output: Optional[Path],
    dry_run: bool,
    yes: bool,
    auto_select: bool,
) -> None:
    """Rename media files in PATH.

    PATH can be a file or directory.
    """
    config = get_config_service()
    settings = config.load()

    # Check for API keys
    if not settings.api.tmdb_api_key and not settings.api.tvdb_api_key:
        console.print(
            "[red]Error:[/red] No API keys configured. "
            "Run 'file-renamer config set-key' to configure."
        )
        raise SystemExit(1)

    # Determine files to process
    if path.is_file():
        files = [path]
    else:
        with console.status("[cyan]Scanning for video files..."):
            parser = create_parser()
            files = []
            if recursive:
                for ext in [".mkv", ".mp4", ".avi", ".mov", ".m4v"]:
                    files.extend(path.rglob(f"*{ext}"))
            else:
                for ext in [".mkv", ".mp4", ".avi", ".mov", ".m4v"]:
                    files.extend(path.glob(f"*{ext}"))
            files = sorted(files)

    if not files:
        console.print("[yellow]No video files found.[/yellow]")
        return

    console.print(f"Found [cyan]{len(files)}[/cyan] file(s) to process.")

    # Determine force type
    force_type: Optional[MediaType] = None
    if media_type == "movie":
        force_type = MediaType.MOVIE
    elif media_type == "tv":
        force_type = MediaType.TV_EPISODE

    # Run async processing
    asyncio.run(_process_files(files, force_type, output, dry_run, yes, auto_select, config))


class DummyTVProvider:
    """Dummy TV provider when TVDB is not configured."""

    async def search_show(self, title: str, year: Optional[int] = None) -> list:
        return []

    async def get_show(self, show_id: int):
        return None

    async def get_episode(self, show_id: int, season: int, episode: int):
        return None


class DummyMovieProvider:
    """Dummy movie provider when TMDB is not configured."""

    async def search_movie(self, title: str, year: Optional[int] = None) -> list:
        return []

    async def get_movie(self, movie_id: int):
        return None


def _create_selection_callback(auto_select: bool):
    """Create a selection callback for choosing from multiple matches.

    Args:
        auto_select: If True, automatically select the first match.

    Returns:
        Selection callback function.
    """
    from file_renamer.core.models import Movie, TVShow

    def select_match(options: list, filename: str) -> Optional[int]:
        """Prompt user to select from multiple matches."""
        if auto_select:
            return 0  # Always select first

        console.print(f"\n[yellow]Multiple matches found for:[/yellow] {filename}")
        console.print()

        # Display options
        table = Table(title="Select Match", show_header=True)
        table.add_column("#", style="cyan", width=3)
        table.add_column("Title", style="green")
        table.add_column("Year", style="yellow")
        table.add_column("Type", style="blue")

        for i, option in enumerate(options, 1):
            if isinstance(option, Movie):
                table.add_row(
                    str(i),
                    option.title,
                    str(option.year),
                    "Movie"
                )
            elif isinstance(option, TVShow):
                table.add_row(
                    str(i),
                    option.title,
                    str(option.year),
                    "TV Show"
                )

        console.print(table)
        console.print()

        # Prompt for selection
        while True:
            choice = console.input(
                f"[cyan]Select match (1-{len(options)}) or 's' to skip:[/cyan] "
            ).strip().lower()

            if choice == "s":
                return None  # Skip this file

            try:
                selection = int(choice)
                if 1 <= selection <= len(options):
                    return selection - 1  # Convert to 0-indexed
                else:
                    console.print(f"[red]Invalid choice. Enter 1-{len(options)} or 's'[/red]")
            except ValueError:
                console.print(f"[red]Invalid input. Enter a number (1-{len(options)}) or 's'[/red]")

    return select_match


async def _process_files(
    files: list[Path],
    force_type: Optional[MediaType],
    output: Optional[Path],
    dry_run: bool,
    yes: bool,
    auto_select: bool,
    config: ConfigService,
) -> None:
    """Process files asynchronously."""
    settings = config.settings

    # Set up components
    parser = create_parser()
    cache = APICache(config.cache_dir)
    template = TemplateEngine(
        movie_template=settings.templates.movie,
        tv_template=settings.templates.tv,
    )
    renamer = FileRenamer(dry_run=dry_run)

    # Create providers based on available API keys
    tmdb = None
    tvdb = None
    movie_provider = DummyMovieProvider()
    tv_provider = DummyTVProvider()

    if settings.api.tmdb_api_key:
        tmdb = TMDBClient(settings.api.tmdb_api_key, cache)
    if settings.api.tvdb_api_key:
        tvdb = TVDBClient(settings.api.tvdb_api_key, cache)

    try:
        # Enter async contexts for available providers
        if tmdb:
            await tmdb.__aenter__()
            movie_provider = tmdb
            # Also use TMDB for TV if TVDB not available
            if not tvdb:
                tv_provider = tmdb
        if tvdb:
            await tvdb.__aenter__()
            tv_provider = tvdb
            # Also use TVDB for movies if TMDB not available
            if not tmdb:
                movie_provider = tvdb

        # Parse conflict resolution strategy
        try:
            conflict_strategy = ConflictStrategy(settings.conflict_resolution)
        except ValueError:
            conflict_strategy = ConflictStrategy.SKIP

        # Create selection callback
        selection_callback = _create_selection_callback(auto_select)

        service = RenameService(
            parser=parser,
            movie_provider=movie_provider,
            tv_provider=tv_provider,
            template_engine=template,
            file_renamer=renamer,
            associated_files_settings=settings.associated_files,
            conflict_strategy=conflict_strategy,
            selection_callback=selection_callback,
        )

        # Process files with progress tracking
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TaskProgressColumn(),
            MofNCompleteColumn(),
            TimeRemainingColumn(),
            console=console,
        ) as progress:
            # Create progress tasks
            parse_task = progress.add_task("Parsing filenames...", total=len(files))
            fetch_task = progress.add_task("Fetching metadata...", total=len(files), visible=False)

            # Parse files
            media_files = service.parse_files(
                files,
                progress_callback=lambda current, total, msg: progress.update(
                    parse_task, completed=current, description=f"Parsing: {msg.split(': ')[-1]}"
                ),
            )

            # Show fetch task and hide parse task
            progress.update(parse_task, visible=False)
            progress.update(fetch_task, visible=True)

            # Fetch metadata
            media_files = await service.fetch_metadata(
                media_files,
                force_type,
                progress_callback=lambda current, total, msg: progress.update(
                    fetch_task, completed=current, description=f"Fetching: {msg.split(': ')[-1]}"
                ),
            )

            # Hide fetch task
            progress.update(fetch_task, visible=False)

            # Generate preview (no progress needed, it's fast)
            operations = service.generate_preview(media_files, output)

        if not operations:
            console.print("[yellow]No matches found.[/yellow]")
            return

        # Show preview
        _show_preview(operations)

        # Confirm and execute
        if dry_run:
            console.print("\n[yellow]Dry run - no files were renamed.[/yellow]")
            return

        if not yes:
            if not click.confirm("\nProceed with rename?"):
                console.print("[yellow]Cancelled.[/yellow]")
                return

        # Execute rename with progress tracking
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TaskProgressColumn(),
            MofNCompleteColumn(),
            TimeRemainingColumn(),
            console=console,
        ) as progress:
            rename_task = progress.add_task("Renaming files...", total=len(operations))

            service.execute_rename(
                operations,
                progress_callback=lambda current, total, msg: progress.update(
                    rename_task, completed=current, description=f"Renaming: {msg.split(': ')[-1]}"
                ),
            )

        # Show results
        _show_results(operations)

        # Save history for undo
        completed_ops = [op for op in operations if op.status == RenameStatus.COMPLETED]
        if completed_ops:
            history_data = []
            for op in completed_ops:
                entry = {
                    "source": str(op.source),
                    "destination": str(op.destination),
                    "associated_files": [
                        {"source": str(a.source), "destination": str(a.destination)}
                        for a in op.associated_files
                    ],
                }
                history_data.append(entry)
            config.save_history(history_data)
    finally:
        # Clean up providers
        if tmdb:
            await tmdb.__aexit__(None, None, None)
        if tvdb:
            await tvdb.__aexit__(None, None, None)


def _show_preview(operations: list) -> None:
    """Display rename preview table."""
    table = Table(title="Rename Preview")
    table.add_column("Type", style="cyan")
    table.add_column("Original", style="red")
    table.add_column("New Name", style="green")

    for op in operations:
        # Main video file
        table.add_row("Video", op.source.name, op.destination.name)

        # Associated files
        for assoc in op.associated_files:
            type_label = assoc.file_type.capitalize()
            table.add_row(
                f"  └─ {type_label}",
                assoc.source.name,
                assoc.destination.name,
            )

    console.print(table)

    # Show summary
    total_files = sum(op.total_files for op in operations)
    assoc_count = sum(len(op.associated_files) for op in operations)
    if assoc_count > 0:
        console.print(
            f"\n[dim]Total: {len(operations)} video file(s) + "
            f"{assoc_count} associated file(s) = {total_files} file(s)[/dim]"
        )


def _show_results(operations: list) -> None:
    """Display rename results."""
    completed = sum(1 for op in operations if op.status == RenameStatus.COMPLETED)
    failed = sum(1 for op in operations if op.status == RenameStatus.FAILED)
    skipped = sum(1 for op in operations if op.status == RenameStatus.SKIPPED)

    console.print()
    console.print(f"[green]Completed:[/green] {completed}")
    if failed:
        console.print(f"[red]Failed:[/red] {failed}")
    if skipped:
        console.print(f"[yellow]Skipped:[/yellow] {skipped}")

    # Show errors
    for op in operations:
        if op.status == RenameStatus.FAILED:
            console.print(f"  [red]Error:[/red] {op.source.name}: {op.error_message}")


@cli.command()
@click.argument("path", type=click.Path(exists=True, path_type=Path))
@click.option(
    "--recursive",
    "-r",
    is_flag=True,
    help="Scan directories recursively",
)
def preview(path: Path, recursive: bool) -> None:
    """Preview what files would be renamed without making changes.

    PATH can be a file or directory.
    """
    # Determine files to process
    if path.is_file():
        files = [path]
    else:
        files = []
        if recursive:
            for ext in [".mkv", ".mp4", ".avi", ".mov", ".m4v"]:
                files.extend(path.rglob(f"*{ext}"))
        else:
            for ext in [".mkv", ".mp4", ".avi", ".mov", ".m4v"]:
                files.extend(path.glob(f"*{ext}"))
        files = sorted(files)

    if not files:
        console.print("[yellow]No video files found.[/yellow]")
        return

    # Parse filenames and show info
    parser = create_parser()
    table = Table(title="Parsed File Information")
    table.add_column("Filename")
    table.add_column("Type")
    table.add_column("Title")
    table.add_column("Year")
    table.add_column("Season")
    table.add_column("Episode")

    for f in files:
        parsed = parser.parse(f.name)
        type_str = parsed.media_type.name.lower()
        table.add_row(
            f.name,
            type_str,
            parsed.title,
            str(parsed.year) if parsed.year else "-",
            str(parsed.season) if parsed.season else "-",
            str(parsed.episode) if parsed.episode else "-",
        )

    console.print(table)


@cli.command()
@click.option(
    "--yes",
    "-y",
    is_flag=True,
    help="Skip confirmation prompt",
)
def undo(yes: bool) -> None:
    """Undo the last rename operation.

    Reverts files to their original names using saved history.
    """
    config = get_config_service()
    config.load()

    operations = config.get_last_operations()
    if not operations:
        console.print("[yellow]No rename history found.[/yellow]")
        return

    # Show what will be undone
    console.print(f"[bold]Found {len(operations)} file(s) to undo:[/bold]")
    for op in operations:
        dest = Path(op["destination"])
        source = Path(op["source"])
        console.print(f"  {dest.name} → {source.name}")

    if not yes:
        if not click.confirm("\nProceed with undo?"):
            console.print("[yellow]Aborted.[/yellow]")
            return

    # Perform undo
    from file_renamer.core.renamer import FileRenamer

    renamer = FileRenamer()
    success_count = 0
    fail_count = 0

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        MofNCompleteColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("Undoing renames...", total=len(operations))

        for op in operations:
            dest = Path(op["destination"])
            source = Path(op["source"])

            try:
                # Undo main file
                if dest.exists():
                    renamer.rename(dest, source)

                # Undo associated files
                for assoc in op.get("associated_files", []):
                    assoc_dest = Path(assoc["destination"])
                    assoc_source = Path(assoc["source"])
                    if assoc_dest.exists():
                        renamer.rename(assoc_dest, assoc_source)

                success_count += 1
            except Exception as e:
                console.print(f"[red]Failed to undo {dest.name}: {e}[/red]")
                fail_count += 1

            progress.advance(task)

    # Clear history entry after successful undo
    if success_count > 0:
        config.clear_last_history()

    console.print()
    console.print(f"[green]Undone:[/green] {success_count}")
    if fail_count:
        console.print(f"[red]Failed:[/red] {fail_count}")


@cli.group()
def config() -> None:
    """Manage configuration settings."""
    pass


@config.command("show")
def config_show() -> None:
    """Show current configuration."""
    config = get_config_service()
    settings = config.load()

    console.print("[bold]Current Configuration[/bold]\n")
    console.print(f"Config file: {config.config_file}")
    console.print(f"Cache dir: {config.cache_dir}\n")

    console.print("[bold]Templates:[/bold]")
    console.print(f"  Movie: {settings.templates.movie}")
    console.print(f"  TV:    {settings.templates.tv}\n")

    console.print("[bold]API Keys:[/bold]")
    tmdb_status = "[green]configured[/green]" if settings.api.tmdb_api_key else "[red]not set[/red]"
    tvdb_status = "[green]configured[/green]" if settings.api.tvdb_api_key else "[red]not set[/red]"
    console.print(f"  TMDB: {tmdb_status}")
    console.print(f"  TVDB: {tvdb_status}\n")

    console.print("[bold]Associated Files:[/bold]")
    enabled_status = "[green]enabled[/green]" if settings.associated_files.enabled else "[red]disabled[/red]"
    console.print(f"  Enabled:   {enabled_status}")
    if settings.associated_files.enabled:
        sub_status = "✓" if settings.associated_files.subtitles else "✗"
        nfo_status = "✓" if settings.associated_files.nfo else "✗"
        img_status = "✓" if settings.associated_files.images else "✗"
        console.print(f"  Subtitles: {sub_status}")
        console.print(f"  NFO files: {nfo_status}")
        console.print(f"  Images:    {img_status}\n")

    console.print("[bold]Behavior:[/bold]")
    console.print(f"  Conflict resolution: {settings.conflict_resolution}")
    console.print(f"  Preview before rename: {settings.preview_before_rename}")


@config.command("set-key")
@click.argument("provider", type=click.Choice(["tmdb", "tvdb"]))
@click.argument("key")
def config_set_key(provider: str, key: str) -> None:
    """Set an API key for a provider.

    PROVIDER is either 'tmdb' or 'tvdb'.
    """
    config = get_config_service()
    config.load()  # Ensure settings are loaded
    config.set_api_key(provider, key)
    console.print(f"[green]API key for {provider.upper()} saved.[/green]")


@config.command("set-template")
@click.argument("type_", metavar="TYPE", type=click.Choice(["movie", "tv"]))
@click.argument("template")
def config_set_template(type_: str, template: str) -> None:
    """Set a naming template.

    TYPE is either 'movie' or 'tv'.

    Example templates:
      movie: "{title} ({year})"
      tv: "{title} - S{season2}E{episode2} - {episode_title}"
    """
    config = get_config_service()
    settings = config.load()

    # Validate template
    engine = TemplateEngine()
    is_valid, errors = engine.validate_template(template)

    if not is_valid:
        console.print("[red]Invalid template:[/red]")
        for error in errors:
            console.print(f"  - {error}")
        raise SystemExit(1)

    if type_ == "movie":
        settings.templates.movie = template
    else:
        settings.templates.tv = template

    config.save(settings)
    console.print(f"[green]Template for {type_} saved.[/green]")


@config.command("init")
def config_init() -> None:
    """Initialize configuration file with defaults."""
    config = get_config_service()
    config._ensure_dirs()

    if config.config_file.exists():
        if not click.confirm("Config file exists. Overwrite?"):
            return

    config.save()
    console.print(f"[green]Config file created at:[/green] {config.config_file}")
    console.print("\nNext steps:")
    console.print("  1. Get a TMDB API key from https://www.themoviedb.org/settings/api")
    console.print("  2. Run: file-renamer config set-key tmdb YOUR_API_KEY")
    console.print("  3. (Optional) Get a TVDB API key from https://thetvdb.com/api-information")
    console.print("  4. Run: file-renamer config set-key tvdb YOUR_API_KEY")


if __name__ == "__main__":
    cli()
