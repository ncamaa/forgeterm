#!/bin/bash
# ForgeTerm CLI - command-line interface for ForgeTerm
# Installed to /usr/local/bin/forgeterm (alias: ft)

FORGETERM_VERSION="CLI 2.0"

# Determine socket path. The directory is Electron's userData dir, which is named
# after the package name - lowercase, and case-sensitive outside macOS.
if [ -n "$FORGETERM_SOCKET" ]; then
  SOCKET_PATH="$FORGETERM_SOCKET"
elif [ "$(uname)" = "Darwin" ]; then
  SOCKET_PATH="$HOME/Library/Application Support/forgeterm/forgeterm.sock"
else
  SOCKET_PATH="$HOME/.config/forgeterm/forgeterm.sock"
fi

# ========== Helpers ==========

json_string() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\t'/\\t}"
  echo "\"$s\""
}

send_to_socket() {
  local json="$1"

  if [ ! -S "$SOCKET_PATH" ]; then
    if pgrep -i forgeterm >/dev/null 2>&1; then
      echo "ForgeTerm is running but is not serving $SOCKET_PATH." >&2
      echo "It re-binds the socket every few seconds; if this persists, restart ForgeTerm." >&2
    else
      echo "Could not connect to ForgeTerm. Is it running?" >&2
    fi
    return 1
  fi

  local response
  if command -v nc &>/dev/null; then
    response=$(echo "$json" | nc -U -w 5 "$SOCKET_PATH" 2>/dev/null)
  elif command -v socat &>/dev/null; then
    response=$(echo "$json" | socat - UNIX-CONNECT:"$SOCKET_PATH" 2>/dev/null)
  else
    if command -v python3 &>/dev/null; then
      response=$(python3 -c "
import socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(5)
s.connect('$SOCKET_PATH')
s.sendall(b'$json\n')
data = s.recv(65536)
s.close()
print(data.decode())
" 2>/dev/null)
    else
      echo "No suitable socket client found (need nc, socat, or python3)" >&2
      return 1
    fi
  fi

  if [ -z "$response" ]; then
    echo "No response from ForgeTerm (timed out)" >&2
    return 1
  fi

  echo "$response"
}

check_response() {
  local response="$1"
  local quiet="${2:-false}"

  if echo "$response" | grep -q '"ok":true'; then
    if [ "$quiet" = "true" ]; then
      return 0
    fi
    # Print data if present
    if echo "$response" | grep -q '"data"'; then
      if command -v python3 &>/dev/null; then
        echo "$response" | python3 -c "
import sys, json
data = json.load(sys.stdin)
d = data.get('data', data)
if isinstance(d, (dict, list)):
    print(json.dumps(d, indent=2))
else:
    print(d)
"
      else
        echo "$response"
      fi
    fi
    return 0
  else
    if command -v python3 &>/dev/null; then
      local error
      error=$(echo "$response" | python3 -c "import sys,json;print(json.load(sys.stdin).get('error','Unknown error'))" 2>/dev/null)
      echo "Error: $error" >&2
    else
      echo "Error: $response" >&2
    fi
    return 1
  fi
}

resolve_project_path() {
  local input="${1:-$FORGETERM_PROJECT_PATH}"
  if [ -z "$input" ]; then
    echo "No project path. Use --project <path> or run inside ForgeTerm." >&2
    return 1
  fi
  local abs_path
  abs_path=$(cd "$input" 2>/dev/null && pwd)
  if [ -z "$abs_path" ]; then
    echo "$input"
  else
    echo "$abs_path"
  fi
}

require_session() {
  if [ -z "$FORGETERM_SESSION_ID" ] || [ -z "$FORGETERM_PROJECT_PATH" ]; then
    echo "Not running inside a ForgeTerm session" >&2
    exit 1
  fi
}

# ========== Direct commands (backward-compatible) ==========

cmd_notify() {
  local message=""
  local title=""
  local sound="true"

  while [ $# -gt 0 ]; do
    case "$1" in
      --title) shift; title="$1" ;;
      --no-sound) sound="false" ;;
      -h|--help)
        cat <<'USAGE'
Usage: ft notify "message" [--title "title"] [--no-sound]

Send a macOS notification through ForgeTerm.
When run inside a ForgeTerm session, clicking the notification focuses that window.

Examples:
  ft notify "Build complete"
  ft notify "Tests passed" --title "CI"
  pnpm build && ft notify "Done" || ft notify "Failed"
USAGE
        exit 0
        ;;
      -*) echo "Unknown option: $1" >&2; exit 1 ;;
      *) message="$1" ;;
    esac
    shift
  done

  if [ -z "$message" ]; then
    echo "Usage: ft notify \"message\" [--title \"title\"]" >&2
    exit 1
  fi

  local json="{"
  json+="\"command\":\"notify\""
  json+=",\"message\":$(json_string "$message")"
  [ -n "$title" ] && json+=",\"title\":$(json_string "$title")"
  [ "$sound" = "false" ] && json+=",\"sound\":false"
  [ -n "$FORGETERM_PROJECT_PATH" ] && json+=",\"projectPath\":$(json_string "$FORGETERM_PROJECT_PATH")"
  [ -n "$FORGETERM_SESSION_ID" ] && json+=",\"sessionId\":$(json_string "$FORGETERM_SESSION_ID")"
  [ -n "$FORGETERM_SESSION_NAME" ] && json+=",\"sessionName\":$(json_string "$FORGETERM_SESSION_NAME")"
  json+="}"

  local response
  response=$(send_to_socket "$json") || exit 1
  check_response "$response" true || exit 1
}

cmd_rename() {
  if [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
    echo "Usage: ft rename \"new name\" - Rename the current terminal session"
    exit 0
  fi
  local name="$1"
  if [ -z "$name" ]; then echo "Usage: ft rename \"new name\"" >&2; exit 1; fi
  require_session

  local json="{\"command\":\"rename\",\"name\":$(json_string "$name"),\"projectPath\":$(json_string "$FORGETERM_PROJECT_PATH"),\"sessionId\":$(json_string "$FORGETERM_SESSION_ID")}"
  local response
  response=$(send_to_socket "$json") || exit 1
  check_response "$response" true || exit 1
}

cmd_close() {
  if [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
    echo "Usage: ft close - Close (delete) the current terminal session, like Cmd+W"
    exit 0
  fi
  require_session

  local json="{\"command\":\"close\",\"projectPath\":$(json_string "$FORGETERM_PROJECT_PATH"),\"sessionId\":$(json_string "$FORGETERM_SESSION_ID")}"
  local response
  response=$(send_to_socket "$json") || exit 1
  check_response "$response" true || exit 1
}

cmd_info() {
  if [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
    echo 'Usage: ft info --title "..." --summary "..." --last "..." [--action "..."]'
    exit 0
  fi

  local title="" summary="" last_action="" action_item=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --title) shift; title="$1" ;;
      --summary) shift; summary="$1" ;;
      --last) shift; last_action="$1" ;;
      --action) shift; action_item="$1" ;;
      -*) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
    shift
  done

  if [ -z "$title" ] || [ -z "$summary" ] || [ -z "$last_action" ]; then
    echo "Required: --title, --summary, --last" >&2; exit 1
  fi
  require_session

  local json="{\"command\":\"info\",\"title\":$(json_string "$title"),\"summary\":$(json_string "$summary"),\"lastAction\":$(json_string "$last_action")"
  [ -n "$action_item" ] && json+=",\"actionItem\":$(json_string "$action_item")"
  json+=",\"projectPath\":$(json_string "$FORGETERM_PROJECT_PATH"),\"sessionId\":$(json_string "$FORGETERM_SESSION_ID")}"

  local response
  response=$(send_to_socket "$json") || exit 1
  check_response "$response" true || exit 1
}

cmd_context() {
  if [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
    cat <<'USAGE'
Usage: ft context <0-100>

Report Claude Code context window usage percentage to ForgeTerm.
The session indicator in the sidebar will show a ring reflecting usage.

Examples:
  ft context 42    # 42% of context used
  ft context 85    # 85% of context used
USAGE
    exit 0
  fi
  local percent="$1"
  if [ -z "$percent" ]; then echo "Usage: ft context <0-100>" >&2; exit 1; fi
  require_session

  local json="{\"command\":\"context\",\"percent\":$percent,\"projectPath\":$(json_string "$FORGETERM_PROJECT_PATH"),\"sessionId\":$(json_string "$FORGETERM_SESSION_ID")}"
  local response
  response=$(send_to_socket "$json") || exit 1
  check_response "$response" true || exit 1
}

cmd_conversation() {
  if [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
    cat <<'USAGE'
Usage: ft conversation <id>

Associate the current session with a Claude conversation (session) ID so
ForgeTerm can persist it and offer a one-click "Resume in Claude" button in
the session info panel. Usually called automatically by a Claude SessionStart
hook, but you can also set it manually.

Examples:
  ft conversation c490f302-9351-4219-a9c0-4b104bce79d4
USAGE
    exit 0
  fi
  local conversation_id="$1"
  if [ -z "$conversation_id" ]; then echo "Usage: ft conversation <id>" >&2; exit 1; fi
  require_session

  local json="{\"command\":\"conversation\",\"conversationId\":$(json_string "$conversation_id"),\"projectPath\":$(json_string "$FORGETERM_PROJECT_PATH"),\"sessionId\":$(json_string "$FORGETERM_SESSION_ID")}"
  local response
  response=$(send_to_socket "$json") || exit 1
  check_response "$response" true || exit 1
}

cmd_activity() {
  if [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
    cat <<'USAGE'
Usage: ft activity <working|done|attention|idle>

Report Claude's working state for the current session. ForgeTerm shows a
loading indicator while a session is working and a glowing notification dot
when Claude finishes (cleared once you visit the session).

Usually called automatically by Claude Code hooks:
  UserPromptSubmit -> working   Stop -> done   Notification -> attention

Examples:
  ft activity working
  ft activity done
USAGE
    exit 0
  fi
  local status="$1"
  case "$status" in
    working|done|attention|idle) ;;
    "") echo "Usage: ft activity <working|done|attention|idle>" >&2; exit 1 ;;
    *) echo "Invalid status: $status (use working|done|attention|idle)" >&2; exit 1 ;;
  esac
  require_session

  local json="{\"command\":\"activity\",\"status\":$(json_string "$status"),\"projectPath\":$(json_string "$FORGETERM_PROJECT_PATH"),\"sessionId\":$(json_string "$FORGETERM_SESSION_ID")}"
  local response
  response=$(send_to_socket "$json") || exit 1
  check_response "$response" true || exit 1
}

cmd_open() {
  if [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
    echo "Usage: ft open <path> - Open a project in ForgeTerm"
    exit 0
  fi
  local target="${1:-.}"
  local abs_path
  abs_path=$(cd "$target" 2>/dev/null && pwd)
  if [ -z "$abs_path" ]; then echo "Not a directory: $target" >&2; exit 1; fi

  local json="{\"command\":\"open\",\"path\":$(json_string "$abs_path")}"
  local response
  response=$(send_to_socket "$json") || exit 1
  check_response "$response" true && echo "Opened $abs_path" || exit 1
}

cmd_open_workspace() {
  if [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
    echo "Usage: ft open-workspace <path> - Open folder children as a workspace"
    exit 0
  fi
  local target="${1:-.}"
  local abs_path
  abs_path=$(cd "$target" 2>/dev/null && pwd)
  if [ -z "$abs_path" ]; then echo "Not a directory: $target" >&2; exit 1; fi

  local json="{\"command\":\"open-workspace\",\"path\":$(json_string "$abs_path")}"
  local response
  response=$(send_to_socket "$json") || exit 1
  check_response "$response" true && echo "Opened workspace from $abs_path" || exit 1
}

cmd_start() {
  local name="" command="" prompt="" project_path="" use_claude=false idle=false
  while [ $# -gt 0 ]; do
    case "$1" in
      -c|--command) shift; command="$1" ;;
      --claude) use_claude=true ;;
      -p|--prompt) shift; prompt="$1"; use_claude=true ;;
      --project) shift; project_path="$1" ;;
      --idle) idle=true ;;
      -h|--help)
        cat <<'USAGE'
Usage: ft start [name] [options]

Start a new live session in a project, opening its window if needed.

Options:
  -c, --command "cmd"   Run this command in the new session
      --claude          Launch Claude in the new session
  -p, --prompt "text"   Launch Claude with an initial prompt (implies --claude)
      --project <path>  Project to start in (default: current session or cwd)
      --idle            Create the session stopped (don't run the command yet)

Examples:
  ft start                                   New shell session
  ft start "dev" --command "npm run dev"     Named session running a command
  ft start --claude                          New Claude session
  ft start "fix login" -p "Fix the login bug in auth.ts"
  ft start review -p "Review the diff" --project ~/code/app
USAGE
        exit 0 ;;
      -*) echo "Unknown option: $1" >&2; exit 1 ;;
      *) name="$1" ;;
    esac
    shift
  done

  # Inside a ForgeTerm session, default to its project; otherwise the cwd.
  [ -z "$project_path" ] && project_path="${FORGETERM_PROJECT_PATH:-$PWD}"
  project_path=$(resolve_project_path "$project_path") || exit 1

  local json="{\"command\":\"start-session\",\"projectPath\":$(json_string "$project_path")"
  [ -n "$name" ] && json+=",\"name\":$(json_string "$name")"
  [ -n "$command" ] && json+=",\"runCommand\":$(json_string "$command")"
  [ "$use_claude" = true ] && json+=",\"claude\":true"
  [ -n "$prompt" ] && json+=",\"prompt\":$(json_string "$prompt")"
  [ "$idle" = true ] && json+=",\"idle\":true"
  json+="}"

  local response
  response=$(send_to_socket "$json") || exit 1
  check_response "$response" true && echo "Started session in $project_path" || exit 1
}

cmd_list() {
  local json_output=false
  while [ $# -gt 0 ]; do
    case "$1" in
      --json) json_output=true ;;
      -h|--help) echo "Usage: ft list [--json] - List recent projects"; exit 0 ;;
    esac
    shift
  done

  local json='{"command":"list"}'
  local response
  response=$(send_to_socket "$json") || exit 1

  if ! echo "$response" | grep -q '"ok":true'; then
    echo "Failed: $response" >&2; exit 1
  fi

  if [ "$json_output" = true ]; then
    if command -v python3 &>/dev/null; then
      echo "$response" | python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin).get('data',[]),indent=2))"
    else
      echo "$response"
    fi
  else
    if command -v python3 &>/dev/null; then
      echo "$response" | python3 -c "
import sys, json
data = json.load(sys.stdin)
projects = data.get('data', [])
if not projects:
    print('No recent projects.')
else:
    for p in projects:
        ws = f' [{p[\"workspace\"]}]' if p.get('workspace') else ''
        print(f'  {p[\"name\"]}{ws}')
        print(f'    {p[\"path\"]}')
"
    else
      echo "$response"
    fi
  fi
}

# ========== Project commands ==========

cmd_project() {
  case "${1:-}" in
    list) shift; cmd_list "$@" ;;
    open) shift; cmd_open "$@" ;;
    remove)
      shift
      if [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
        echo "Usage: ft project remove <path> - Remove project from recent list"
        exit 0
      fi
      local target="$1"
      if [ -z "$target" ]; then echo "Usage: ft project remove <path>" >&2; exit 1; fi
      local abs_path
      abs_path=$(cd "$target" 2>/dev/null && pwd) || abs_path="$target"
      local json="{\"command\":\"project-remove\",\"path\":$(json_string "$abs_path")}"
      local response
      response=$(send_to_socket "$json") || exit 1
      check_response "$response" true && echo "Removed $abs_path" || exit 1
      ;;
    -h|--help|help|"")
      cat <<'USAGE'
Usage: ft project <command>

Commands:
  list              List recent projects
  open <path>       Open a project
  remove <path>     Remove from recent list
USAGE
      ;;
    *) echo "Unknown project command: $1" >&2; exit 1 ;;
  esac
}

# ========== Session commands ==========

cmd_session() {
  case "${1:-}" in
    list)
      shift
      local project_path=""
      while [ $# -gt 0 ]; do
        case "$1" in
          --project) shift; project_path="$1" ;;
          -h|--help) echo "Usage: ft session list [--project <path>]"; exit 0 ;;
        esac
        shift
      done
      project_path=$(resolve_project_path "$project_path") || exit 1
      local json="{\"command\":\"session-list\",\"projectPath\":$(json_string "$project_path")}"
      local response
      response=$(send_to_socket "$json") || exit 1
      check_response "$response" || exit 1
      ;;
    add)
      shift
      local name="" command="" project_path="" auto_start=""
      while [ $# -gt 0 ]; do
        case "$1" in
          --command) shift; command="$1" ;;
          --project) shift; project_path="$1" ;;
          --auto-start) auto_start="true" ;;
          --no-auto-start) auto_start="false" ;;
          -h|--help) echo 'Usage: ft session add <name> [--command "cmd"] [--project <path>] [--auto-start|--no-auto-start]'; exit 0 ;;
          -*) echo "Unknown option: $1" >&2; exit 1 ;;
          *) name="$1" ;;
        esac
        shift
      done
      if [ -z "$name" ]; then echo "Usage: ft session add <name>" >&2; exit 1; fi
      project_path=$(resolve_project_path "$project_path") || exit 1
      local json="{\"command\":\"session-add\",\"name\":$(json_string "$name"),\"projectPath\":$(json_string "$project_path")"
      [ -n "$command" ] && json+=",\"runCommand\":$(json_string "$command")"
      [ "$auto_start" = "true" ] && json+=",\"autoStart\":true"
      [ "$auto_start" = "false" ] && json+=",\"autoStart\":false"
      json+="}"
      local response
      response=$(send_to_socket "$json") || exit 1
      check_response "$response" true && echo "Added session '$name'" || exit 1
      ;;
    remove)
      shift
      local name="" project_path=""
      while [ $# -gt 0 ]; do
        case "$1" in
          --project) shift; project_path="$1" ;;
          -h|--help) echo "Usage: ft session remove <name> [--project <path>]"; exit 0 ;;
          -*) echo "Unknown option: $1" >&2; exit 1 ;;
          *) name="$1" ;;
        esac
        shift
      done
      if [ -z "$name" ]; then echo "Usage: ft session remove <name>" >&2; exit 1; fi
      project_path=$(resolve_project_path "$project_path") || exit 1
      local json="{\"command\":\"session-remove\",\"name\":$(json_string "$name"),\"projectPath\":$(json_string "$project_path")}"
      local response
      response=$(send_to_socket "$json") || exit 1
      check_response "$response" true && echo "Removed session '$name'" || exit 1
      ;;
    -h|--help|help|"")
      cat <<'USAGE'
Usage: ft session <command>

Commands:
  list                          List sessions (live or config)
  add <name> [--command "cmd"]  Add session to project config
  remove <name>                 Remove session from project config

Options (all commands):
  --project <path>    Target project (defaults to current ForgeTerm session)
USAGE
      ;;
    *) echo "Unknown session command: $1" >&2; exit 1 ;;
  esac
}

# ========== Workspace commands ==========

cmd_workspace() {
  case "${1:-}" in
    list)
      shift
      local json='{"command":"workspace-list"}'
      local response
      response=$(send_to_socket "$json") || exit 1
      if echo "$response" | grep -q '"ok":true' && command -v python3 &>/dev/null; then
        echo "$response" | python3 -c "
import sys, json
data = json.load(sys.stdin).get('data', [])
if not data:
    print('No workspaces.')
else:
    for w in data:
        emoji = f'{w[\"emoji\"]} ' if w.get('emoji') else ''
        print(f'  {emoji}{w[\"name\"]} ({len(w[\"projects\"])} projects)')
        for p in w['projects']:
            print(f'    {p}')
"
      else
        check_response "$response" || exit 1
      fi
      ;;
    create)
      shift
      local name="$1"
      if [ -z "$name" ]; then echo "Usage: ft workspace create <name>" >&2; exit 1; fi
      local json="{\"command\":\"workspace-create\",\"name\":$(json_string "$name")}"
      local response
      response=$(send_to_socket "$json") || exit 1
      check_response "$response" true && echo "Created workspace '$name'" || exit 1
      ;;
    delete)
      shift
      local name="$1"
      if [ -z "$name" ]; then echo "Usage: ft workspace delete <name>" >&2; exit 1; fi
      local json="{\"command\":\"workspace-delete\",\"name\":$(json_string "$name")}"
      local response
      response=$(send_to_socket "$json") || exit 1
      check_response "$response" true && echo "Deleted workspace '$name'" || exit 1
      ;;
    rename)
      shift
      local old_name="$1" new_name="$2"
      if [ -z "$old_name" ] || [ -z "$new_name" ]; then echo "Usage: ft workspace rename <old> <new>" >&2; exit 1; fi
      local json="{\"command\":\"workspace-rename\",\"oldName\":$(json_string "$old_name"),\"newName\":$(json_string "$new_name")}"
      local response
      response=$(send_to_socket "$json") || exit 1
      check_response "$response" true && echo "Renamed '$old_name' to '$new_name'" || exit 1
      ;;
    add-project)
      shift
      local ws_name="$1" project="$2"
      if [ -z "$ws_name" ] || [ -z "$project" ]; then echo "Usage: ft workspace add-project <workspace> <path>" >&2; exit 1; fi
      local abs_path
      abs_path=$(cd "$project" 2>/dev/null && pwd) || abs_path="$project"
      local json="{\"command\":\"workspace-add-project\",\"name\":$(json_string "$ws_name"),\"projectPath\":$(json_string "$abs_path")}"
      local response
      response=$(send_to_socket "$json") || exit 1
      check_response "$response" true && echo "Added $abs_path to '$ws_name'" || exit 1
      ;;
    remove-project)
      shift
      local ws_name="$1" project="$2"
      if [ -z "$ws_name" ] || [ -z "$project" ]; then echo "Usage: ft workspace remove-project <workspace> <path>" >&2; exit 1; fi
      local abs_path
      abs_path=$(cd "$project" 2>/dev/null && pwd) || abs_path="$project"
      local json="{\"command\":\"workspace-remove-project\",\"name\":$(json_string "$ws_name"),\"projectPath\":$(json_string "$abs_path")}"
      local response
      response=$(send_to_socket "$json") || exit 1
      check_response "$response" true && echo "Removed $abs_path from '$ws_name'" || exit 1
      ;;
    open)
      shift
      local name="$1"
      if [ -z "$name" ]; then echo "Usage: ft workspace open <name>" >&2; exit 1; fi
      local json="{\"command\":\"workspace-open\",\"name\":$(json_string "$name")}"
      local response
      response=$(send_to_socket "$json") || exit 1
      check_response "$response" true && echo "Opened workspace '$name'" || exit 1
      ;;
    update)
      shift
      local name="$1"
      if [ -z "$name" ]; then echo "Usage: ft workspace update <name> [--emoji ..] [--description ..] [--color ..] [--command ..]" >&2; exit 1; fi
      shift
      local json="{\"command\":\"workspace-update\",\"name\":$(json_string "$name")"
      while [ $# -gt 0 ]; do
        case "$1" in
          --emoji) shift; json+=",\"emoji\":$(json_string "$1")" ;;
          --description) shift; json+=",\"description\":$(json_string "$1")" ;;
          --color) shift; json+=",\"accentColor\":$(json_string "$1")" ;;
          --command) shift; json+=",\"defaultCommand\":$(json_string "$1")" ;;
          --claude-cli) shift; json+=",\"claudeCliName\":$(json_string "$1")" ;;
          --skip-permissions) json+=",\"dangerouslySkipPermissions\":true" ;;
          --no-skip-permissions) json+=",\"dangerouslySkipPermissions\":false" ;;
          *) echo "Unknown option: $1" >&2; exit 1 ;;
        esac
        shift
      done
      json+="}"
      local response
      response=$(send_to_socket "$json") || exit 1
      check_response "$response" true && echo "Updated workspace '$name'" || exit 1
      ;;
    -h|--help|help|"")
      cat <<'USAGE'
Usage: ft workspace <command>

Commands:
  list                                 List workspaces
  create <name>                        Create workspace
  delete <name>                        Delete workspace
  rename <old> <new>                   Rename workspace
  add-project <workspace> <path>       Add project to workspace
  remove-project <workspace> <path>    Remove project from workspace
  open <name>                          Open all workspace projects
  update <name> [options]              Update workspace metadata
    --emoji "emoji"
    --description "text"
    --color "#hex"
    --command "default cmd"
    --claude-cli "claude-hsp"          Claude CLI name for this workspace
    --skip-permissions | --no-skip-permissions
USAGE
      ;;
    *) echo "Unknown workspace command: $1" >&2; exit 1 ;;
  esac
}

# ========== Config commands ==========

cmd_config() {
  case "${1:-}" in
    get)
      shift
      local project_path="" key=""
      while [ $# -gt 0 ]; do
        case "$1" in
          --project) shift; project_path="$1" ;;
          -h|--help) echo "Usage: ft config get [key] [--project <path>]"; exit 0 ;;
          -*) echo "Unknown option: $1" >&2; exit 1 ;;
          *) key="$1" ;;
        esac
        shift
      done
      project_path=$(resolve_project_path "$project_path") || exit 1
      local json="{\"command\":\"config-get\",\"projectPath\":$(json_string "$project_path")"
      [ -n "$key" ] && json+=",\"key\":$(json_string "$key")"
      json+="}"
      local response
      response=$(send_to_socket "$json") || exit 1
      check_response "$response" || exit 1
      ;;
    set)
      shift
      local project_path="" key="" value=""
      # Parse --project first
      local args=()
      while [ $# -gt 0 ]; do
        case "$1" in
          --project) shift; project_path="$1" ;;
          -h|--help) echo "Usage: ft config set <key> <value> [--project <path>]"; exit 0 ;;
          *) args+=("$1") ;;
        esac
        shift
      done
      key="${args[0]}"
      value="${args[1]}"
      if [ -z "$key" ] || [ -z "$value" ]; then echo "Usage: ft config set <key> <value>" >&2; exit 1; fi
      project_path=$(resolve_project_path "$project_path") || exit 1
      local json="{\"command\":\"config-set\",\"projectPath\":$(json_string "$project_path"),\"key\":$(json_string "$key"),\"value\":$(json_string "$value")}"
      local response
      response=$(send_to_socket "$json") || exit 1
      check_response "$response" true && echo "Set $key" || exit 1
      ;;
    -h|--help|help|"")
      cat <<'USAGE'
Usage: ft config <command>

Commands:
  get [key] [--project <path>]           Read config (full or specific key)
  set <key> <value> [--project <path>]   Set config value

Keys use dot-notation: window.emoji, font.size, projectName, etc.

Examples:
  ft config get                          # Full config of current project
  ft config get window.emoji             # Specific key
  ft config set window.emoji "rocket"     # Set emoji
  ft config set projectName "My App" --project ~/projects/app
  ft config set claudeResumeArgs '["--dangerously-skip-permissions"]'
USAGE
      ;;
    *) echo "Unknown config command: $1" >&2; exit 1 ;;
  esac
}

# ========== Theme commands ==========

cmd_theme() {
  case "${1:-}" in
    list)
      shift
      local json='{"command":"theme-list"}'
      local response
      response=$(send_to_socket "$json") || exit 1
      if echo "$response" | grep -q '"ok":true' && command -v python3 &>/dev/null; then
        echo "$response" | python3 -c "
import sys, json
data = json.load(sys.stdin).get('data', {})
presets = data.get('presets', [])
terminals = data.get('terminalThemes', [])
print('Window themes:')
for p in presets:
    print(f'  {p[\"id\"]:12s} {p[\"name\"]}')
print()
print('Terminal themes:')
for t in terminals:
    print(f'  {t}')
"
      else
        check_response "$response" || exit 1
      fi
      ;;
    set)
      shift
      local name="" project_path=""
      while [ $# -gt 0 ]; do
        case "$1" in
          --project) shift; project_path="$1" ;;
          -h|--help) echo "Usage: ft theme set <name> [--project <path>]"; exit 0 ;;
          -*) echo "Unknown option: $1" >&2; exit 1 ;;
          *) name="$1" ;;
        esac
        shift
      done
      if [ -z "$name" ]; then echo "Usage: ft theme set <name>" >&2; exit 1; fi
      project_path=$(resolve_project_path "$project_path") || exit 1
      local json="{\"command\":\"theme-set\",\"name\":$(json_string "$name"),\"projectPath\":$(json_string "$project_path")}"
      local response
      response=$(send_to_socket "$json") || exit 1
      check_response "$response" true && echo "Applied theme '$name'" || exit 1
      ;;
    terminal)
      shift
      local name="" project_path=""
      while [ $# -gt 0 ]; do
        case "$1" in
          --project) shift; project_path="$1" ;;
          -h|--help) echo "Usage: ft theme terminal <name> [--project <path>]"; exit 0 ;;
          -*) echo "Unknown option: $1" >&2; exit 1 ;;
          *) name="$1" ;;
        esac
        shift
      done
      if [ -z "$name" ]; then echo "Usage: ft theme terminal <name>" >&2; exit 1; fi
      project_path=$(resolve_project_path "$project_path") || exit 1
      local json="{\"command\":\"terminal-theme-set\",\"name\":$(json_string "$name"),\"projectPath\":$(json_string "$project_path")}"
      local response
      response=$(send_to_socket "$json") || exit 1
      check_response "$response" true && echo "Set terminal theme '$name'" || exit 1
      ;;
    favorites)
      shift
      local json='{"command":"theme-favorites"}'
      local response
      response=$(send_to_socket "$json") || exit 1
      check_response "$response" || exit 1
      ;;
    -h|--help|help|"")
      cat <<'USAGE'
Usage: ft theme <command>

Commands:
  list                                List available themes
  set <name> [--project <path>]       Apply a window theme preset
  terminal <name> [--project <path>]  Set terminal color theme
  favorites                           List saved favorite themes

Use 'ft theme list' to see available theme names.
USAGE
      ;;
    *) echo "Unknown theme command: $1" >&2; exit 1 ;;
  esac
}

# ========== Usage ==========

usage() {
  cat <<'USAGE'
Usage: ft <command> [options]

Direct commands:
  notify "message"        Send a native notification
  rename "name"           Rename current session
  close                   Close (delete) the current session, like Cmd+W
  info                    Update session info card
  context <0-100>         Report context window usage %
  conversation <id>       Link session to a Claude conversation ID
  activity <state>        Report working state (working|done|attention|idle)
  open [path]             Open a project
  start [name]            Start a new live session (--claude, -p "prompt", -c "cmd")
  open-workspace [path]   Open folder as workspace
  list [--json]           List recent projects

Command groups:
  project                 Manage projects (list, open, remove)
  session                 Manage sessions (list, add, remove)
  workspace               Manage workspaces (list, create, delete, rename, ...)
  config                  Read/write project config
  theme                   Manage themes (list, set, terminal, favorites)

Run 'ft <command> --help' for command-specific help.
USAGE
}

# ========== Main dispatch ==========

case "${1:-}" in
  # Direct commands (backward-compatible)
  notify)    shift; cmd_notify "$@" ;;
  rename)    shift; cmd_rename "$@" ;;
  close)     shift; cmd_close "$@" ;;
  info)      shift; cmd_info "$@" ;;
  context)   shift; cmd_context "$@" ;;
  conversation) shift; cmd_conversation "$@" ;;
  activity)  shift; cmd_activity "$@" ;;
  open)      shift; cmd_open "$@" ;;
  start)     shift; cmd_start "$@" ;;
  list)      shift; cmd_list "$@" ;;
  dashboard) send_command '{"command":"dashboard"}' ;;
  open-workspace) shift; cmd_open_workspace "$@" ;;

  # Command groups
  project)   shift; cmd_project "$@" ;;
  session)   shift; cmd_session "$@" ;;
  workspace) shift; cmd_workspace "$@" ;;
  config)    shift; cmd_config "$@" ;;
  theme)     shift; cmd_theme "$@" ;;

  # Meta
  help|--help|-h) usage ;;
  --version|-v) echo "forgeterm $FORGETERM_VERSION" ;;
  "") usage ;;
  *) echo "Unknown command: $1. Run 'ft help' for usage." >&2; exit 1 ;;
esac
