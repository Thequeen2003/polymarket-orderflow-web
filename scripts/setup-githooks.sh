#!/bin/sh
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

git config core.hooksPath .githooks
chmod +x .githooks/post-commit

echo "Git hooks enabled: commits will auto-push to origin."
echo "Hook path: $root/.githooks"
