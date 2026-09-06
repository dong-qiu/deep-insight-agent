# Opt-in zsh integration for foreground Multica task observation.
# Load once in an interactive terminal with: source ops/multica-auto-watch.zsh

typeset -g _INSIGHT_MULTICA_WATCH_ROOT="${${(%):-%N}:A:h:h}"

_insight_multica_started_issue() {
  local -a arguments
  arguments=("$@")

  [[ "${arguments[1]}" == "issue" ]] || return 1
  case "${arguments[2]}" in
    assign|rerun|status) ;;
    *) return 1 ;;
  esac

  local index=3
  while (( index <= ${#arguments} )); do
    local candidate="${arguments[index]}"
    case "$candidate" in
      --no-start)
        return 1
        ;;
      --to|--to-id|--output)
        (( index += 2 ))
        continue
        ;;
      --to=*|--to-id=*|--output=*|--unassign|-*)
        (( index += 1 ))
        continue
        ;;
    esac

    # Multica identifiers are workspace-prefix plus a numeric issue number
    # (for example, INSI-91 or GH-242). This prevents an option value such as
    # `--to researcher` from being mistaken for the issue ID.
    if [[ "$candidate" =~ '^[[:alpha:]][[:alnum:]_]*-[0-9]+$' ]]; then
      print -r -- "$candidate"
      return 0
    fi
    (( index += 1 ))
  done
  return 1
}

multica() {
  command multica "$@"
  local command_status=$?
  ((command_status == 0)) || return "$command_status"

  local issue
  issue="$(_insight_multica_started_issue "$@")" || return 0
  [[ -t 1 ]] || return 0

  print -r -- "\nStarting foreground observation for $issue. Press Ctrl-C to stop observing."
  node "$_INSIGHT_MULTICA_WATCH_ROOT/ops/multica-task-watch.mjs" "$issue"
}
