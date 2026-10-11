#!/usr/bin/env bash
# Merges a-bonus/google-docs-mcp main into the current branch and keeps what
# makes this fork gworkmcp: the package name, the gworkmcp command, and my
# README. A conflict anywhere else, or a failed check, stops before the merge
# is committed. Run by .github/workflows/sync-upstream.yml, and by hand when
# that job fails. Pushing is left to the caller.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

git remote get-url upstream >/dev/null 2>&1 ||
  git remote add upstream https://github.com/a-bonus/google-docs-mcp.git
git fetch --no-tags upstream main

target=$(git rev-parse --short upstream/main)
if git merge-base --is-ancestor upstream/main HEAD; then
  echo "Already up to date with upstream/main ($target)."
  exit 0
fi
base=$(git merge-base HEAD upstream/main)

# Conflicts are expected here and sorted out below; a merge that never started
# (dirty tree, untracked file in the way) is caught by the MERGE_HEAD check.
git merge --no-ff --no-commit upstream/main || true
git rev-parse -q --verify MERGE_HEAD >/dev/null || {
  echo "The merge did not start. Commit or stash local changes and run again." >&2
  exit 1
}
trap 'echo "Stopped with the merge uncommitted. Fix it and git commit, or git merge --abort and npm run build." >&2' ERR

git checkout HEAD -- README.md
if ! git diff --quiet "$base" upstream/main -- README.md; then
  echo "Kept my README.md. Upstream changed theirs: git diff $base $target -- README.md"
fi

# name and the gworkmcp bin are the fork's only changes to these two files. If
# that stops being true, this drops the rest, so extend it.
if ! git diff --quiet "$base" upstream/main -- package.json package-lock.json; then
  git checkout upstream/main -- package.json package-lock.json
  node -e '
    const fs = require("fs");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const entry = pkg.bin?.["google-docs-mcp"];
    if (!entry) throw new Error("upstream has no google-docs-mcp bin any more; set name and bin by hand");
    pkg.name = "@ashuwhy/gworkmcp";
    pkg.bin = { gworkmcp: entry, ...pkg.bin };
    fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
  '
  npm install --package-lock-only --ignore-scripts --no-audit --no-fund
  git add package.json package-lock.json
fi

unresolved=$(git diff --name-only --diff-filter=U)
if [ -n "$unresolved" ]; then
  echo "Upstream conflicts with my changes in:" >&2
  echo "$unresolved" >&2
  false
fi

npm ci --no-audit --no-fund
# Tracked files only, so local untracked files don't fail a check CI never runs.
git ls-files -z | xargs -0 npx prettier --check --ignore-unknown
# Building, not just tsc --noEmit, lets startupHandshake.test.ts boot dist/.
npm run build
npm test

git commit --quiet -m "Merge upstream/main ($target) from a-bonus/google-docs-mcp"
echo "Merged upstream/main ($target)."
