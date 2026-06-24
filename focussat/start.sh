#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"
exec deno run --allow-read --allow-write --allow-net --allow-env --allow-run main.ts "$@"
