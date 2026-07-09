#!/usr/bin/env bash
set -euo pipefail

# Publish the built action as orphan release tags.
#
# Adapted for a ROOT-level action from the org's shared script
# (wow-look-at-my/actions@orphan-release, orphan-release.sh): the whole
# repository is the source directory, and the tags follow the conventional
# root-action scheme -- immutable "v<version>" plus a moving "latest" --
# instead of the monorepo's "<dir>#<version>" scheme.
#
# Usage: orphan-release.sh --version <version> [--exclude <patterns>] [--message <msg>]

version=""
exclude=""
message=""

while [[ $# -gt 0 ]]; do
	case $1 in
		--version) version="$2"; shift 2 ;;
		--exclude) exclude="$2"; shift 2 ;;
		--message) message="$2"; shift 2 ;;
		*) echo "Unknown option: $1" >&2; exit 1 ;;
	esac
done

if [ -z "$version" ]; then
	echo "Error: --version is required" >&2
	exit 1
fi

tags=("v$version" "latest")
first_tag="${tags[0]}"
[ -z "$message" ] && message="Release $first_tag"

echo "::group::[$first_tag] Prepare content"
tmpdir=$(mktemp -d)
cp -r ./. "$tmpdir/"
# The root source necessarily includes the repo's own .git; drop it so the
# orphan init below starts from scratch.
rm -rf "$tmpdir/.git"

for pattern in $exclude; do
	rm -rf "$tmpdir"/$pattern 2>/dev/null || true
done
echo "::endgroup::"

echo "::group::[$first_tag] Create orphan commit"
cd "$tmpdir"
git init -b master
git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"
git add -A
git commit -m "$message"
echo "::endgroup::"

echo "::group::[$first_tag] Push tags"
if [ -n "${GITHUB_REPOSITORY:-}" ]; then
	git remote add origin "https://x-access-token:${GITHUB_TOKEN}@github.com/$GITHUB_REPOSITORY"
fi

refs=""
for tag in "${tags[@]}"; do
	git tag "$tag"
	refs="$refs refs/tags/$tag"
	echo "Created tag: $tag"
done

git push --force origin $refs
echo "::endgroup::"
