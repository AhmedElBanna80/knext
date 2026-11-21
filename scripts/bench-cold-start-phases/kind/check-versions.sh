#!/usr/bin/env bash
# Compare the resolved next, react and react-dom versions across the build-tool arms.
#
#   check-versions.sh <out-dir>
#
# Reads every <out-dir>/evidence-*.json whose app is "scaffold" (the buildtool set; the spike-zone arms
# are a different app and are not compared). Each carries .versions.{next,react,react-dom}, resolved
# from the arm's node_modules after install.
#   - next must be identical on every scaffold arm, and every version must be present: exit 1 if not.
#   - react and react-dom must be identical among the arms of ONE build tool: exit 1 if not.
#   - react and react-dom may differ BETWEEN build tools, because the vinext scaffold pins a newer react
#     range than the turbopack scaffold. That is recorded, not failed: a NOTE line names both versions.
# Exit 0 when the comparison holds (or there are no scaffold arms), 1 on a violation, 2 on bad usage.
set -euo pipefail

dir="${1:?out dir}"
[ -d "$dir" ] || { echo "check-versions: '$dir' is not a directory" >&2; exit 2; }

files=()
for f in "$dir"/evidence-*.json; do
  [ -e "$f" ] || continue
  [ "$(jq -r '.app' "$f")" = scaffold ] && files+=("$f")
done
[ "${#files[@]}" -gt 0 ] || { echo "check-versions: no scaffold arms; nothing to compare"; exit 0; }

rows="$(jq -c '{arm, build: .build_target, next: (.versions.next // ""), react: (.versions.react // ""), reactdom: (.versions["react-dom"] // "")}' "${files[@]}")"

missing="$(printf '%s\n' "$rows" | jq -r 'select(.next == "" or .react == "" or .reactdom == "") | .arm')"
if [ -n "$missing" ]; then
  echo "check-versions: no resolved next/react/react-dom version recorded for: $(echo "$missing" | paste -sd, -)" >&2
  exit 1
fi

distinct() { printf '%s\n' "$rows" | jq -r "$1" | sort -u | paste -sd, -; }

nexts="$(distinct '.next')"
case "$nexts" in *,*) echo "check-versions: next differs across the buildtool arms: $nexts" >&2; exit 1 ;; esac

for b in $(printf '%s\n' "$rows" | jq -r '.build' | sort -u); do
  for field in react reactdom; do
    vs="$(printf '%s\n' "$rows" | jq -r "select(.build == \"$b\") | .$field" | sort -u | paste -sd, -)"
    case "$vs" in *,*) echo "check-versions: $field differs among the $b arms: $vs" >&2; exit 1 ;; esac
  done
done

echo "check-versions: next=$nexts on every scaffold arm"
for field in react reactdom; do
  all="$(distinct ".$field")"
  case "$all" in
    *,*) echo "NOTE: $field differs between build tools (recorded, not a failure): $(printf '%s\n' "$rows" | jq -r ".build + \"=\" + .$field" | sort -u | paste -sd' ' -)" ;;
    *) echo "check-versions: $field=$all on every scaffold arm" ;;
  esac
done
