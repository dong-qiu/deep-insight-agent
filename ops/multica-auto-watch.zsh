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

  local argument
  for argument in "${arguments[@]}"; do
    [[ "$argument" == "--no-start" ]] && return 1
  done

  local candidate
  for candidate in "${arguments[@]:2}"; do
    [[ "$candidate" == --* ]] && continue
    [[ "$candidate" == "assign" || "$candidate" == "rerun" || "$candidate" == "status" ]] && continue
    print -r -- "$candidate"
    return 0
  done
  return 1
}

multica() {
  command multica "$@"
  local command_status=$?
  ((command_status == 0)) || return "$command_status"

  local issue
  issue="$(_insight_multica_started_issue "$@")" || return "$command_status"
  [[ -t 1 ]] || return "$command_status"

  print -r -- "\nStarting foreground observation for $issue. Press Ctrl-C to stop observing."
  node "$_INSIGHT_MULTICA_WATCH_ROOT/ops/multica-task-watch.mjs" "$issue" || :
  return "$command_status"
}
