#!/usr/bin/env bash
# Sync only C1-managed backups that remain inside the redaction-safe 90-day window.
# Legacy/handmade directories are intentionally left local for explicit operator review.
set -euo pipefail

: "${DR_BACKUP_ROOT:?missing backup root}"
: "${DR_BUCKET:?missing DR bucket}"
AWS_BIN="${DR_AWS_BIN:-/usr/local/bin/aws}"
now="$(date -u +%s)"
synced=0
shopt -s nullglob
for dir in "$DR_BACKUP_ROOT"/*; do
  [ -d "$dir" ] && [ ! -L "$dir" ] || continue
  name="${dir##*/}"
  manifest="$dir/backup-manifest.json"
  [ -f "$manifest" ] && [ ! -L "$manifest" ] || continue
  # The container writes the manifest last and atomically renames the completed directory.
  # Check both ages and the version marker; full hash/reference verification is the recovery gate.
  python3 - "$manifest" "$name" "$now" <<'PY' || continue
from datetime import datetime, timezone
import hashlib
import json
import os
import re
import sys
try:
    stamp = re.fullmatch(r"\d{8}-\d{6}", sys.argv[2])
    assert stamp is not None
    created = datetime.strptime(sys.argv[2], "%Y%m%d-%H%M%S").replace(tzinfo=timezone.utc)
    age = int(sys.argv[3]) - int(created.timestamp())
    assert 0 <= age < 90 * 24 * 60 * 60
    with open(sys.argv[1], encoding="utf-8") as handle:
        manifest = json.load(handle)
    assert manifest.get("schema_version") == 1
    assert manifest.get("status") in ("complete", "incomplete")
    assert isinstance(manifest.get("files"), list)
    manifest_created = datetime.fromisoformat(manifest["created_at"].replace("Z", "+00:00"))
    assert manifest_created.tzinfo is not None
    manifest_age = int(sys.argv[3]) - int(manifest_created.timestamp())
    assert 0 <= manifest_age < 90 * 24 * 60 * 60
    root = os.path.dirname(sys.argv[1])
    expected = {}
    for item in manifest["files"]:
        path = item["path"]
        assert isinstance(path, str) and path not in expected
        assert path != "backup-manifest.json"
        assert not path.startswith("/") and all(part not in ("", ".", "..") for part in path.split("/"))
        assert isinstance(item["size"], int) and item["size"] >= 0
        assert re.fullmatch(r"[0-9a-f]{64}", item["sha256"])
        expected[path] = item
    actual = set()
    for current, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            full = os.path.join(current, name)
            assert not os.path.islink(full)
            assert os.path.isdir(full) or os.path.isfile(full)
        for name in files:
            full = os.path.join(current, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            actual.add(rel)
            if rel == "backup-manifest.json":
                continue
            item = expected[rel]
            assert os.path.getsize(full) == item["size"]
            digest = hashlib.sha256()
            with open(full, "rb") as content:
                for chunk in iter(lambda: content.read(1024 * 1024), b""):
                    digest.update(chunk)
            assert digest.hexdigest() == item["sha256"]
    assert actual == set(expected) | {"backup-manifest.json"}
except (OSError, ValueError, TypeError, KeyError, AssertionError, OverflowError):
    sys.exit(1)
PY
  "$AWS_BIN" s3 sync "$dir/" "s3://${DR_BUCKET}/ec2/${name}/" --only-show-errors --no-progress
  synced=$((synced + 1))
done

if (( synced == 0 )); then
  echo "no_eligible_backup_for_dr_sync" >&2
  exit 2
fi
echo "dr_sync_snapshots=$synced"
