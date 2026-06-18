#!/usr/bin/env bash
# eval 门禁核心判定（pre-push 与 CI 共用）。
# 用法: eval-gate-check.sh <rev-range...>     例: <base>..<head>  或  <head> --not --remotes
# 退出 0 = 放行（未触及 AI 质量面，或已带 Eval-Gate 盖章，或空区间）；1 = 阻断。
# 只查「有没有盖章」——盖章即"已在本地跑过 /eval-gate 对比基线"的承诺；不在此跑真模型 eval。
set -uo pipefail

SENSITIVE_RE='^(src/lib/agents/|src/lib/sources/|src/lib/runtime/llm\.ts|evals/dataset/)'
TEST_RE='\.test\.ts$'

rev="$*"
# fail-closed：区分「区间合法但为空」(放行) 与「区间解析失败/端点不可达」(阻断)。
if ! commits=$(git rev-list $rev 2>/dev/null); then
  echo "✗ eval 门禁：无法解析提交区间「$rev」——fail-closed 阻断（检查 base/head 是否可达）。" >&2
  exit 1
fi
[ -z "$commits" ] && exit 0

files=$(for c in $commits; do git show --name-only --format= "$c"; done 2>/dev/null | sort -u)
sensitive=$(printf '%s\n' "$files" | grep -E "$SENSITIVE_RE" | grep -vE "$TEST_RE" || true)
[ -z "$sensitive" ] && exit 0

if git log --format='%B' $rev 2>/dev/null | grep -qiE '^[[:space:]]*Eval-Gate:'; then
  exit 0
fi

echo "✗ 改了 AI 质量面但本批提交无 Eval-Gate 盖章：" >&2
printf '%s\n' "$sensitive" | sed 's/^/    /' >&2
exit 1
