#!/usr/bin/env bash
# Pinned standalone CI tool; no application/package dependency is added.
set -euo pipefail
version=1.7.12
if command -v actionlint >/dev/null && [ "$(actionlint --version | head -1)" = "$version" ]; then
  binary=$(command -v actionlint)
else
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) target=linux_amd64; checksum=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 ;;
    Linux-aarch64|Linux-arm64) target=linux_arm64; checksum=325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6 ;;
    *) echo 'Install actionlint 1.7.12 on this platform first' >&2; exit 1 ;;
  esac
  temp_dir=$(mktemp -d)
  trap 'rm -rf "$temp_dir"' EXIT
  archive="actionlint_${version}_${target}.tar.gz"
  curl --fail --silent --show-error --location --retry 3 --max-time 120 \
    "https://github.com/rhysd/actionlint/releases/download/v${version}/${archive}" \
    -o "$temp_dir/$archive"
  printf '%s  %s\n' "$checksum" "$temp_dir/$archive" | sha256sum --check --status
  tar -xzf "$temp_dir/$archive" -C "$temp_dir" actionlint
  binary="$temp_dir/actionlint"
fi
# All workflows get Actions schema/expression validation; shell lint is scoped
# to this delivery lane because unrelated legacy workflows have existing warnings.
"$binary" -shellcheck=
"$binary" \
  .github/workflows/ci.yml \
  .github/workflows/infra-check.yml \
  .github/workflows/release.yml \
  .github/workflows/deploy-frontend.yml \
  .github/workflows/prepare-frontend-production.yml
