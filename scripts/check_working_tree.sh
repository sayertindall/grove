#!/usr/bin/env bash
#
# Grove's smoke fixture: a temp parent holding three repositories, then the cargo
# tests that assert Grove reads them the way the sidebar contract says.
#
# Set GROVE_FIXTURE_KEEP=1 to leave the fixture in place, so the app can be pointed
# at it by hand.

set -euo pipefail

fixture="$(mktemp -d "${TMPDIR:-/tmp}/grove-fixture.XXXXXX")"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

new_repository() {
  local name="$1"
  mkdir -p "$fixture/$name"
  git -C "$fixture/$name" init --quiet
  git -C "$fixture/$name" config user.email "grove@example.com"
  git -C "$fixture/$name" config user.name "Grove fixture"
}

commit_all() {
  local name="$1" message="$2"
  git -C "$fixture/$name" add --all
  git -C "$fixture/$name" commit --quiet --message "$message"
}

# clean: committed, untouched.
new_repository clean
printf 'clean\n' >"$fixture/clean/README.md"
commit_all clean "initial"

# dirty: one modified tracked file, one untracked file.
new_repository dirty
printf 'one\n' >"$fixture/dirty/tracked.txt"
commit_all dirty "initial"
printf 'one\ntwo\n' >"$fixture/dirty/tracked.txt"
printf 'x\n' >"$fixture/dirty/extra.txt"

# renamed: a staged rename.
new_repository renamed
printf 'same\n' >"$fixture/renamed/old.txt"
commit_all renamed "initial"
git -C "$fixture/renamed" mv old.txt new.txt

echo "fixture: $fixture"
echo "  clean/    Clean, zero counts"
echo "  dirty/    1 unstaged, 1 untracked, +2 -0"
echo "  renamed/  1 staged rename old.txt -> new.txt"
echo

cargo test --manifest-path "$root/src-tauri/Cargo.toml"

if [ "${GROVE_FIXTURE_KEEP:-0}" = "1" ]; then
  echo
  echo "kept: $fixture"
else
  rm -rf "$fixture"
fi
