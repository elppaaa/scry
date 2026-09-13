#!/usr/bin/env python3
"""Gate the *applied* recording fixture: no English prose left on camera.

    tools/demo-i18n/check-applied.py <mirror.db> <locale> [--limit N]

check.py gates the translation FILE — every id in en.json has a rendering.
This gates the DATABASE a ko/ja take actually records over, and the two are
not the same claim. A file can be complete and gate-green while a column
nobody put in the extraction contract still holds English, because an id
that was never extracted cannot be reported missing.

That is not hypothetical. `issues_raw.reopen_reason` had no id family until
2026-09-13: titles, descriptions, comments, wiki pages and every catalog had
one, that column did not. The 0.22 release clip put ten English sentences in
the middle of a Korean retro — "Added a regression test so this cannot come
back silently." under a Korean title — and check.py was green the whole time
(GDK-1847).

A vision pass did not save it either, and could not have: the pre-release ko
take was recorded 2026-09-09 and judged, and on that day the surprises list
held one badge-only row, so there was no English on screen to see. The
fixture was regenerated on 09-11 (reopened 87 -> 95, reasons 42 -> 49), the
list filled up, and the clip was never re-shot. A review is pinned to the
frames it saw; nothing invalidated it when the screen changed underneath.
So the check has to be a gate that runs every time, not a person.

The census shape is the point. Every TEXT column of the user-visible tables
is checked unless it is named in WIRE below, so a column added next quarter
is checked by default and has to be argued out rather than remembered in.
That is the part that closes the class — the English sentence was only the
symptom.

Exit 0 when clean, 1 with the offending rows, 2 on usage.
"""
import importlib.util, json, re, sqlite3, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load_check():
    """Reuse check.py's detectors — one definition of "this is English"."""
    spec = importlib.util.spec_from_file_location("dcheck", Path(__file__).with_name("check.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


CHECK = load_check()

# Columns that are wire, not prose: ids, categories, enums, timestamps, JSON
# and ADF payloads (the ADF is checked through the plain-text column beside
# it, which is generated from the same tree). Anything not listed here is
# read as something a viewer can see.
WIRE = {
    "items": {"id", "key", "source_id", "kind", "created_at", "updated_at", "synced_at",
              "url", "icon_url", "raw", "author_id"},
    "issues_raw": {
        "item_id", "key", "source_id", "status_id", "status_category", "issue_type_id",
        "priority_id", "priority_rank", "assignee_id", "assignee_email", "reporter_id",
        "reporter_email", "epic_key", "parent_key", "resolution_id", "created_at",
        "updated_at", "resolved_at", "due_at", "status_changed_at", "reopened_at",
        "first_sprint_at", "sprint_state", "description_adf", "raw", "labels",
        "fix_version_ids", "custom", "blocked_since", "resolution_id",
        "assignee_changed_at", "started_at", "last_activity_at",
    },
    "comments": {"id", "item_id", "author_id", "author_email", "created_at", "updated_at", "body_adf"},
    # pages.status is the Confluence lifecycle enum ("current"/"draft"), not a
    # word the reader sees.
    "pages": {"item_id", "space_key", "labels", "body_adf", "created_at", "updated_at",
              "version_by_id", "status"},
    "sprints": {"id", "board_id", "source_id", "state", "start_at", "end_at",
                "complete_at", "activated_at"},
    "boards": {"id", "source_id", "type"},
    "versions": {"id", "project_key", "released", "archived", "release_date"},
}

# Author names and other people-shaped strings are Latin on purpose in every
# locale — a Korean team's tracker still says "Alex Kim".
PEOPLE_COLUMNS = {"author", "assignee", "reporter", "version_by", "created_by", "updated_by", "owner"}


def is_untranslated(value: str, locale: str) -> bool:
    """English prose with no letter of the target script anywhere in it."""
    if not isinstance(value, str) or not value.strip():
        return False
    if CHECK.SCRIPT[locale].search(value):
        return False  # mixed is fine: a Korean sentence may quote a flag
    return CHECK.needs_translation(value)


def columns_of(con, table: str) -> list[str]:
    return [r[1] for r in con.execute(f"PRAGMA table_info({table})")]


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) < 2:
        print(__doc__)
        return 2
    db, locale = Path(args[0]), args[1]
    limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else 25
    if locale not in CHECK.SCRIPT:
        print(f"unknown locale {locale}")
        return 2
    if not db.exists():
        print(f"mirror not found: {db}")
        return 2

    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    have = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    bad: list[tuple[str, str, str, str]] = []
    checked_cols = 0

    for table, wire in WIRE.items():
        if table not in have:
            continue
        cols = columns_of(con, table)
        unknown = [c for c in cols if c not in wire and c not in PEOPLE_COLUMNS]
        for col in unknown:
            checked_cols += 1
            # The row's key, when the table has one to name — a failure that
            # cannot be traced to an issue is a failure nobody fixes.
            keycol = "key" if "key" in cols else ("item_id" if "item_id" in cols else "rowid")
            try:
                rows = con.execute(
                    f'SELECT {keycol}, "{col}" FROM {table} WHERE "{col}" IS NOT NULL AND "{col}" != ""'
                ).fetchall()
            except sqlite3.OperationalError:
                continue
            for key, value in rows:
                if not isinstance(value, str):
                    continue
                # A JSON array column (components, labels) is a list of
                # display names; check the names, not the brackets.
                if value.startswith("[") and value.endswith("]"):
                    try:
                        for entry in json.loads(value):
                            if isinstance(entry, str) and is_untranslated(entry, locale):
                                bad.append((table, col, str(key), entry))
                        continue
                    except json.JSONDecodeError:
                        pass
                if is_untranslated(value, locale):
                    bad.append((table, col, str(key), value))

    for table, col, key, value in bad[:limit]:
        one = " ".join(value.split())
        print(f"FAIL {table}.{col} [{key}]: {one[:100]}")
    if len(bad) > limit:
        print(f"  … and {len(bad) - limit} more")
    print(f"{db.name}: {checked_cols} viewer-visible columns checked, {len(bad)} untranslated values")
    if bad:
        print()
        print(f"  These strings are on camera in a {locale} take and are English.")
        print("  If the column has no id family in tools/demo-i18n/extract.py, add one —")
        print("  a complete translation file cannot cover an id that is never extracted.")
        print("  If the column is wire and not prose, name it in WIRE here and say why.")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
