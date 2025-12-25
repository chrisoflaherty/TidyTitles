"""API response caching."""

import hashlib
import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Optional


class APICache:
    """Simple file-based cache for API responses."""

    def __init__(
        self,
        cache_dir: Path,
        default_ttl: timedelta = timedelta(hours=24),
    ) -> None:
        """Initialize the cache.

        Args:
            cache_dir: Directory to store cache files.
            default_ttl: Default time-to-live for cached responses.
        """
        self.cache_dir = cache_dir
        self.default_ttl = default_ttl
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def _get_cache_key(self, provider: str, endpoint: str, params: dict[str, Any]) -> str:
        """Generate a unique cache key."""
        content = f"{provider}:{endpoint}:{json.dumps(params, sort_keys=True)}"
        return hashlib.sha256(content.encode()).hexdigest()[:16]

    def _get_cache_path(self, key: str) -> Path:
        """Get the path to a cache file."""
        return self.cache_dir / f"{key}.json"

    def get(
        self,
        provider: str,
        endpoint: str,
        params: dict[str, Any],
    ) -> Optional[Any]:
        """Retrieve a cached response if valid.

        Args:
            provider: Name of the API provider.
            endpoint: API endpoint.
            params: Request parameters.

        Returns:
            Cached response data or None if not found/expired.
        """
        key = self._get_cache_key(provider, endpoint, params)
        cache_file = self._get_cache_path(key)

        if not cache_file.exists():
            return None

        try:
            data = json.loads(cache_file.read_text())
            expires_at = datetime.fromisoformat(data["expires_at"])

            if datetime.now() > expires_at:
                cache_file.unlink()
                return None

            return data["response"]
        except (json.JSONDecodeError, KeyError, ValueError):
            # Invalid cache file, remove it
            cache_file.unlink(missing_ok=True)
            return None

    def set(
        self,
        provider: str,
        endpoint: str,
        params: dict[str, Any],
        response: Any,
        ttl: Optional[timedelta] = None,
    ) -> None:
        """Store a response in the cache.

        Args:
            provider: Name of the API provider.
            endpoint: API endpoint.
            params: Request parameters.
            response: Response data to cache.
            ttl: Time-to-live override.
        """
        key = self._get_cache_key(provider, endpoint, params)
        cache_file = self._get_cache_path(key)

        expires_at = datetime.now() + (ttl or self.default_ttl)

        data = {
            "response": response,
            "expires_at": expires_at.isoformat(),
            "cached_at": datetime.now().isoformat(),
            "provider": provider,
            "endpoint": endpoint,
        }

        cache_file.write_text(json.dumps(data, indent=2))

    def clear(self, provider: Optional[str] = None) -> int:
        """Clear cached responses.

        Args:
            provider: If specified, only clear cache for this provider.

        Returns:
            Number of cache entries cleared.
        """
        count = 0
        for cache_file in self.cache_dir.glob("*.json"):
            try:
                if provider:
                    data = json.loads(cache_file.read_text())
                    if data.get("provider") != provider:
                        continue
                cache_file.unlink()
                count += 1
            except (json.JSONDecodeError, KeyError):
                cache_file.unlink()
                count += 1
        return count

    def clear_expired(self) -> int:
        """Clear all expired cache entries.

        Returns:
            Number of entries cleared.
        """
        count = 0
        now = datetime.now()
        for cache_file in self.cache_dir.glob("*.json"):
            try:
                data = json.loads(cache_file.read_text())
                expires_at = datetime.fromisoformat(data["expires_at"])
                if now > expires_at:
                    cache_file.unlink()
                    count += 1
            except (json.JSONDecodeError, KeyError, ValueError):
                cache_file.unlink()
                count += 1
        return count
