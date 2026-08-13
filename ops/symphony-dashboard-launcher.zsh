#!/bin/zsh
# Run as the dedicated `symphony` user via the dashboard LaunchAgent only.
set -euo pipefail
umask 077

export HOME=/Users/symphony
export PATH=/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin

# The dashboard never needs controller, GitHub, Git, AWS, database, or proxy
# credentials. Clear inherited values before Node starts.
unset SYMPHONY_GITHUB_TOKEN
unset AWS_PROFILE DATABASE_URL DB_PATH DISPATCH_WORKER_SECRET
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY no_proxy NO_PROXY

readonly DASHBOARD="$HOME/symphony-runtime/dashboard/symphony-dashboard.mjs"
readonly NODE=/opt/homebrew/bin/node

[[ -r "$DASHBOARD" ]] || {
  print -u2 -- "Dashboard source is missing: $DASHBOARD"
  exit 78
}
[[ -x "$NODE" ]] || {
  print -u2 -- "Node is missing: $NODE"
  exit 78
}

exec "$NODE" "$DASHBOARD"
