#!/usr/bin/env bash
# Velocity installer
#
# Installs Velocity on Linux as a systemd service with its own copy of Node.js,
# or updates an existing install in place, keeping its settings and data.
# From a Velocity checkout:
#
#   sudo bash install.sh
#
# or straight from GitHub:
#
#   curl -fsSL https://raw.githubusercontent.com/skw359/Velocity/main/install.sh | sudo bash
#
# `--help` lists the options. Each run is logged to /var/log/velocity-install.log.
#
# What goes where (for the default name, velocity):
#   /opt/velocity/app/         the app and all its data, owned by the velocity account
#   /opt/velocity/runtime/     Node.js, owned by root
#   /opt/velocity/install.sh   a copy of this installer, for updates
#   /etc/velocity/             settings (velocity.env) and the installer's own state
#   /etc/systemd/system/velocity.service

# Re-run under bash when started as `sh install.sh`.
if [ -z "${BASH_VERSION:-}" ]; then
  if [ -f "$0" ]; then exec bash "$0" "$@"; fi
  echo "The Velocity installer needs bash: pipe it to 'sudo bash', not 'sh'." >&2
  exit 1
fi
if ((BASH_VERSINFO[0] * 100 + BASH_VERSINFO[1] < 404)); then
  echo "The Velocity installer needs bash 4.4 or newer." >&2
  exit 1
fi

set -euo pipefail
umask 022
# A known PATH: `su` without '-' can drop the sbin directories, and WSL adds
# Windows programs, a Windows npm among them. Arch keeps exiftool in vendor_perl.
SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/bin/site_perl:/usr/bin/vendor_perl:/usr/bin/core_perl
export PATH=$SYSTEM_PATH

REPO=${VELOCITY_REPO:-skw359/Velocity}
REF=${VELOCITY_REF:-main}
TARBALL_URL=${VELOCITY_TARBALL_URL:-https://codeload.github.com/$REPO/tar.gz/$REF}
NODE_MAJOR=${VELOCITY_NODE_MAJOR:-24}
UNIT_MARKER='# Managed by the Velocity installer'
MIN_FREE_KB=$((1024 * 1024))

# Runtime data (accounts, uploads, logs, caches) never comes from the source,
# so an update can't overwrite it.
SOURCE_EXCLUDES=(
  --exclude=./.git --exclude=node_modules --exclude=./client/dist --exclude=./install.sh
  --exclude=./content --exclude=./converted --exclude=./uploads --exclude=./logs
  --exclude='./*.db' --exclude='./*.db-shm' --exclude='./*.db-wal'
  --exclude=./shares.json --exclude=./locks.json --exclude=./bandwidth-stats.json
  --exclude=./network_stats.csv --exclude=./.session-secret
  --exclude=./.env --exclude='./.env.*'
  --exclude='./_comments-backup-*' --exclude='./_legacy-removed-*'
  --exclude=./.claude --exclude=./.vscode --exclude=./.idea --exclude=./tests
)

# Options
NAME=velocity
PORT=3000
PORT_GIVEN=0
INSTALL_DIR=
DIR_GIVEN=0
ASSUME_YES=0
WANT_EXTRAS=1
ACTION=install
PURGE=0
ORIG_ARGS=()

# State
INTERACTIVE=0
EXISTING=0
CURRENT_PORT=
INSTALL_STARTED=0
LOG_FILE=
NPM_LOG_SAVED=
FIREWALL=
OPEN_FIREWALL=0
OWNER_USER=
OWNER_PASS=
OWNER_CREATED=0
SRC=
DOWNLOAD_DIR=
STAGE=
APP_DIR=
RUNTIME_DIR=
SERVICE_STOPPED=0
SANDBOX_DROPPED=0
LAST_EXIT_STATUS=0
CURRENT_STEP=
INTERRUPTED=0
SPINNER_PID=
APT_UPDATED=0
PM=
OS_NAME=Linux
NODE_ARCH=
NODE_BASE_URL=
NODE_TARBALL=
NODE_SHA=
NODE_VERSION=
NODE_DIR_NAME=
NODE_BIN_DIR=
NODE_EXEC=
USE_PRIVATE_NODE=1
TEMP_PATHS=()
WARNINGS=()

usage() {
  cat <<EOF
Velocity installer

Usage: sudo bash install.sh [options]

Installs Velocity as a systemd service, or updates an existing install while
keeping its settings, accounts and files.

Options:
  -y, --yes        Don't ask anything; use the defaults (or the current settings).
                   This also opens the port if a firewall is active.
      --port N     Port for the web interface (default 3000)
      --dir PATH   Install folder (default /opt/velocity). Accounts and files
                   live in its app/ folder.
      --name NAME  Name for the service, its account and its settings folder
                   (default velocity), for running more than one Velocity
      --no-extras  Skip the optional preview tools (ffmpeg, ImageMagick, ExifTool)
      --uninstall  Remove the service. Asks before deleting any data.
      --purge      With --uninstall: also delete all accounts and files
  -h, --help       Show this help

Environment:
  VELOCITY_REF         Branch or tag to download when not run from a checkout
                       (default main)
  VELOCITY_NODE_MAJOR  Node.js major version to install (default $NODE_MAJOR)
EOF
}

usage_error() {
  printf 'install.sh: %s (see --help)\n' "$1" >&2
  exit 2
}

parse_args() {
  while [ $# -gt 0 ]; do
    case $1 in
      -y | --yes) ASSUME_YES=1 ;;
      --port | --dir | --name)
        [ $# -ge 2 ] || usage_error "$1 needs a value"
        set_option "$1" "$2"
        shift ;;
      --port=* | --dir=* | --name=*) set_option "${1%%=*}" "${1#*=}" ;;
      --no-extras) WANT_EXTRAS=0 ;;
      --uninstall) ACTION=uninstall ;;
      --purge) PURGE=1 ;;
      -h | --help) usage; exit 0 ;;
      *) usage_error "unknown option '$1'" ;;
    esac
    shift
  done
  if [ "$PURGE" = 1 ] && [ "$ACTION" != uninstall ]; then usage_error "--purge only works with --uninstall"; fi
  [[ $NAME =~ ^[a-z][a-z0-9-]{0,30}$ ]] || usage_error "--name takes lowercase letters, digits and dashes"
}

set_option() {
  case $1 in
    --port) PORT=$2; PORT_GIVEN=1 ;;
    --dir) INSTALL_DIR=$2; DIR_GIVEN=1 ;;
    --name) NAME=$2 ;;
  esac
}

# --- Output -------------------------------------------------------------------

setup_ui() {
  BOLD='' DIM='' RED='' GREEN='' YELLOW='' CYAN='' RESET=''
  FANCY=0
  if [ -t 1 ] && [ "${TERM:-dumb}" != dumb ]; then
    FANCY=1
    if [ -z "${NO_COLOR:-}" ]; then
      BOLD=$'\033[1m' DIM=$'\033[2m' RED=$'\033[31m' GREEN=$'\033[32m'
      YELLOW=$'\033[33m' CYAN=$'\033[36m' RESET=$'\033[0m'
    fi
  fi
  case ${LC_ALL:-${LC_CTYPE:-${LANG:-}}} in
    *[Uu][Tt][Ff]-8* | *[Uu][Tt][Ff]8*)
      OK_MARK='✓' FAIL_MARK='✗'
      SPIN_FRAMES=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏') ;;
    *)
      OK_MARK='+' FAIL_MARK='x'
      SPIN_FRAMES=('-' '\' '|' '/') ;;
  esac
}

info() { printf '  %s\n' "$*"; }
ok() { printf '    %s%s%s %s\n' "$GREEN" "$OK_MARK" "$RESET" "$*"; }
section() { printf '\n%s%s%s\n' "$BOLD" "$*" "$RESET"; }

# A blank line between questions; without questions it's only clutter.
gap() {
  if [ "$INTERACTIVE" = 1 ]; then printf '\n'; fi
}

warn() {
  WARNINGS+=("$*")
  printf '    %s!%s %s\n' "$YELLOW" "$RESET" "$*"
}

die() {
  stop_spinner
  printf '\n  %s%s %s%s\n' "$RED" "$FAIL_MARK" "$*" "$RESET" >&2
  if [ -n "$LOG_FILE" ]; then printf 'ERROR: %s\n' "$*" >>"$LOG_FILE" 2>/dev/null || true; fi
  exit 1
}

duration() {
  if [ "$1" -ge 60 ]; then printf '%dm %02ds' $(($1 / 60)) $(($1 % 60)); else printf '%ds' "$1"; fi
}

# The spinner draws on fd 4, the terminal, while a step's output goes to the log.
start_spinner() {
  [ "$FANCY" = 1 ] || return 0
  (
    trap 'exit 0' TERM
    i=0 started=$SECONDS
    while :; do
      elapsed=$((SECONDS - started)) extra=''
      if [ "$elapsed" -ge 60 ]; then
        printf -v extra ' %s%dm %02ds%s' "$DIM" $((elapsed / 60)) $((elapsed % 60)) "$RESET"
      elif [ "$elapsed" -ge 5 ]; then
        printf -v extra ' %s%ds%s' "$DIM" "$elapsed" "$RESET"
      fi
      printf '\r    %s%s%s %s%s\033[K' "$CYAN" "${SPIN_FRAMES[i % ${#SPIN_FRAMES[@]}]}" "$RESET" "$1" "$extra" >&4
      i=$((i + 1))
      sleep 0.1
    done
  ) &
  SPINNER_PID=$!
}

stop_spinner() {
  [ -n "$SPINNER_PID" ] || return 0
  kill "$SPINNER_PID" 2>/dev/null || true
  wait "$SPINNER_PID" 2>/dev/null || true
  SPINNER_PID=
  printf '\r\033[K' >&4
}

# step <label> <command...>: runs one install step with its output in the log.
# A failure ends the script; on_exit then shows what went wrong.
step() {
  local __started=$SECONDS __took
  CURRENT_STEP=$1
  shift
  printf '\n==> %s [%s]\n' "$CURRENT_STEP" "$(date +%T)" >>"$LOG_FILE"
  start_spinner "$CURRENT_STEP"
  "$@" >>"$LOG_FILE" 2>&1 </dev/null
  stop_spinner
  __took=$((SECONDS - __started))
  if [ "$__took" -ge 10 ]; then
    ok "$CURRENT_STEP ${DIM}($(duration "$__took"))${RESET}"
  else
    ok "$CURRENT_STEP"
  fi
  CURRENT_STEP=
}

# The failing step's error lines, or the end of its output when nothing is marked.
log_excerpt() {
  local start section errors
  start=$(grep -n '^==> ' "$LOG_FILE" | tail -n 1 | cut -d: -f1)
  # Colors would hide the markers below.
  section=$(tail -n "+${start:-1}" "$LOG_FILE" | sed -E 's/\x1b\[[0-9;?]*[A-Za-z]//g')
  # npm ends a usage error with the command's description, a blank line and its
  # help text, and follows other errors with a stack trace. Its pointer to its
  # own log is dropped too; on_exit saves that log next to this one.
  if grep -qE '^npm (error|ERR!) Usage:' <<<"$section"; then
    section=$(sed -E '/^npm (error|ERR!) Usage:/,$d' <<<"$section" | head -n -2)
  fi
  section=$(sed -E \
    -e '/^npm (error|ERR!) A complete log of this run/d' \
    -e '/^npm (error|ERR!)  +/d' \
    -e '/^npm (error|ERR!) [{}]$/d' <<<"$section")
  # Vite's errors read "[UNRESOLVED_IMPORT] Error: ..." or "SyntaxError: ...".
  errors=$(grep -E '^(npm error|npm ERR!|ERROR|E:|error|(\[[^]]+\] )?[A-Za-z]*Error)[: ]' <<<"$section" | tail -n 15)
  if [ -n "$errors" ]; then printf '%s\n' "$errors"; else tail -n 25 <<<"$section"; fi
}

on_signal() {
  trap '' INT TERM
  INTERRUPTED=1
  exit 130
}

on_exit() {
  local rc=$? path npm_log
  set +e
  exec 1>&4 2>&5
  stop_spinner
  if [ "$INTERACTIVE" = 1 ]; then stty echo <&3 2>/dev/null; fi
  # npm's own log sits in the service account's cache folder, so it's read as
  # that account and saved next to the install log.
  if [ "$rc" -ne 0 ] && [ -n "$LOG_FILE" ] && [[ $CURRENT_STEP == "Server dependencies" || $CURRENT_STEP == "Web interface" ]]; then
    npm_log=$(ls -t "$CACHE_DIR"/.npm/_logs/*.log 2>/dev/null | head -n 1)
    if [ -n "$npm_log" ] && (
      set -C
      umask 077
      rm -f "${LOG_FILE%.log}-npm.log"
      runuser -u "$SVC_USER" -- cat -- "$npm_log" >"${LOG_FILE%.log}-npm.log"
    ) 2>/dev/null; then
      NPM_LOG_SAVED=${LOG_FILE%.log}-npm.log
    fi
  fi
  for path in "${TEMP_PATHS[@]}"; do rm -rf "$path"; done
  [ "$rc" -ne 0 ] || return 0

  if [ -n "$CURRENT_STEP" ]; then printf '    %s%s%s %s\n' "$RED" "$FAIL_MARK" "$RESET" "$CURRENT_STEP"; fi
  if [ "$INTERRUPTED" = 1 ]; then
    printf '\n'
    info "Cancelled."
  elif [ -n "$CURRENT_STEP" ]; then
    printf '\n  %sFrom the log:%s\n' "$DIM" "$RESET"
    log_excerpt | sed 's/^/    /'
    printf 'ERROR: %s failed (exit status %s)\n' "$CURRENT_STEP" "$rc" >>"$LOG_FILE"
  fi
  if [ "$SERVICE_STOPPED" = 1 ]; then
    systemctl start "$SERVICE" >/dev/null 2>&1
    if wait_for_service 30 "${CURRENT_PORT:-$PORT}"; then
      info "Velocity is running again."
    else
      info "Velocity is stopped. Run the installer again to finish the update."
    fi
  fi
  if [ "$INSTALL_STARTED" = 1 ] || [ -n "$CURRENT_STEP" ]; then
    printf '\n'
    info "Full log: $LOG_FILE"
    if [ -n "$NPM_LOG_SAVED" ]; then info "npm's log: $NPM_LOG_SAVED"; fi
  fi
  if [ "$INSTALL_STARTED" = 1 ]; then info "Running the installer again is safe; it picks up where it left off."; fi
}

# --- Questions ----------------------------------------------------------------
# Answers come from /dev/tty (fd 3), so prompts work under `curl ... | sudo bash`.

setup_tty() {
  if [ "$ASSUME_YES" = 0 ] && (exec 3<>/dev/tty) 2>/dev/null; then
    exec 3<>/dev/tty
    INTERACTIVE=1
  fi
}

# ask <var> <question> <default>
ask() {
  local __reply=""
  if [ "$INTERACTIVE" = 1 ]; then
    printf '  %s%s: ' "$2" "${3:+ [$3]}" >&3
    IFS= read -r __reply <&3 || die "Cancelled."
  fi
  printf -v "$1" '%s' "${__reply:-$3}"
}

# ask_secret <var> <question>
ask_secret() {
  local __secret=""
  printf '  %s: ' "$2" >&3
  IFS= read -r -s __secret <&3 || { printf '\n' >&3; die "Cancelled."; }
  printf '\n' >&3
  printf -v "$1" '%s' "$__secret"
}

# confirm <question> <Y|N>: without a terminal the default applies.
confirm() {
  local __answer
  if [ "$INTERACTIVE" != 1 ]; then
    [ "$2" = Y ]
    return
  fi
  while :; do
    printf '  %s %s ' "$1" "$([ "$2" = Y ] && echo '[Y/n]' || echo '[y/N]')" >&3
    IFS= read -r __answer <&3 || die "Cancelled."
    case ${__answer:-$2} in
      [Yy]*) return 0 ;;
      [Nn]*) return 1 ;;
    esac
  done
}

# --- System -------------------------------------------------------------------

is_this_script() { [ -f "$1" ] && grep -q '^# Velocity installer$' "$1" 2>/dev/null; }

require_root() {
  if [ "$(id -u)" -eq 0 ]; then return 0; fi
  if is_this_script "$0" && command -v sudo >/dev/null 2>&1; then
    echo "The installer needs root; asking sudo."
    exec sudo env VELOCITY_REPO="$REPO" VELOCITY_REF="$REF" VELOCITY_TARBALL_URL="$TARBALL_URL" \
      VELOCITY_NODE_MAJOR="$NODE_MAJOR" bash "$0" "$@"
  fi
  echo "Please run the installer as root, for example: sudo bash install.sh" >&2
  exit 1
}

derive_names() {
  SERVICE=$NAME
  SVC_USER=$NAME
  CONFIG_DIR=/etc/$NAME
  ENV_FILE=$CONFIG_DIR/$NAME.env
  STATE_FILE=$CONFIG_DIR/installer.state
  UNIT_FILE=/etc/systemd/system/$NAME.service
  LOG_PATH=/var/log/$NAME-install.log
  CACHE_DIR=/var/cache/$NAME
}

# Refuses a name that belongs to something else on this system. Runs before
# anything is written, so a refused name leaves no trace.
check_name_free() {
  if [ -f "$UNIT_FILE" ]; then
    grep -qF "$UNIT_MARKER" "$UNIT_FILE" ||
      die "$UNIT_FILE wasn't made by this installer (perhaps it's a Velocity set up by hand). Remove that service first, or install under another name with --name."
    return 0
  fi
  if systemctl cat -- "$SERVICE.service" >/dev/null 2>&1; then
    die "This system already has a service called $SERVICE. Install Velocity under another name with --name."
  fi
  if [ "$(state_get created_user)" != "$SVC_USER" ]; then
    if id -u "$SVC_USER" >/dev/null 2>&1; then
      die "This system already has an account called '$SVC_USER'. Install Velocity under another name with --name."
    fi
    if getent group "$SVC_USER" >/dev/null 2>&1; then
      die "This system already has a group called '$SVC_USER'. Install Velocity under another name with --name."
    fi
  fi
  if [ -d "$CONFIG_DIR" ] && [ ! -f "$ENV_FILE" ] && [ ! -f "$STATE_FILE" ] && [ -n "$(ls -A "$CONFIG_DIR")" ]; then
    die "$CONFIG_DIR belongs to something else. Install Velocity under another name with --name."
  fi
}

take_lock() {
  command -v flock >/dev/null 2>&1 || return 0
  exec 9>"/run/$NAME-install.lock"
  flock -n 9 || die "The installer is already running."
}

# Keeps the previous run's log as .1 when that run did anything, so a re-run
# doesn't erase why it failed. After a switch to the downloaded installer, the
# run carries on in the same log.
start_log() {
  LOG_FILE=$LOG_PATH
  if [ -n "${VELOCITY_REEXEC:-}" ] && [ -f "$LOG_FILE" ] && [ ! -L "$LOG_FILE" ]; then
    printf '\nSwitched to the installer that comes with this version. Arguments: %s\n' "$*" >>"$LOG_FILE"
    return 0
  fi
  if [ -f "$LOG_FILE" ] && [ ! -L "$LOG_FILE" ] && grep -q '^==> ' "$LOG_FILE"; then
    mv -f "$LOG_FILE" "$LOG_FILE.1"
  else
    rm -f "$LOG_FILE"
  fi
  if ! (set -C; umask 077; : >"$LOG_FILE") 2>/dev/null; then LOG_FILE=$(mktemp /tmp/velocity-install.XXXXXX); fi
  printf 'Velocity installer, %s\nArguments: %s\n' "$(date)" "$*" >>"$LOG_FILE"
}

preflight() {
  local tool
  [ -d /run/systemd/system ] || die "The installer needs systemd, which isn't running on this system."
  for tool in runuser useradd systemctl; do
    command -v "$tool" >/dev/null 2>&1 || die "'$tool' is missing, and the installer can't continue without it."
  done
  case $(uname -m) in
    x86_64 | amd64) NODE_ARCH=x64 ;;
    aarch64 | arm64) NODE_ARCH=arm64 ;;
    armv7l) NODE_ARCH=armv7l ;;
    ppc64le) NODE_ARCH=ppc64le ;;
    s390x) NODE_ARCH=s390x ;;
    *) NODE_ARCH= ;;
  esac
  # A 64-bit kernel can run a 32-bit system, as on 32-bit Raspberry Pi OS.
  if [ "$(getconf LONG_BIT 2>/dev/null)" = 32 ]; then
    case $NODE_ARCH in
      arm64) NODE_ARCH=armv7l ;;
      x64) NODE_ARCH= ;;
    esac
  fi
  for tool in apt-get dnf pacman zypper; do
    if command -v "$tool" >/dev/null 2>&1; then
      PM=${tool%-get}
      break
    fi
  done
  if [ -r /etc/os-release ]; then OS_NAME=$(. /etc/os-release && printf '%s' "${PRETTY_NAME:-Linux}"); fi
  printf 'System: %s, %s, package manager: %s\n' "$OS_NAME" "$(uname -m)" "${PM:-none}" >>"$LOG_FILE"
}

check_install_dir() {
  [[ $1 =~ ^/[A-Za-z0-9._/-]+$ && $1 != *..* ]] ||
    die "The install folder must be an absolute path of letters, digits and . _ - / (no spaces)."
  case $1 in
    /bin | /boot | /dev | /etc | /home | /lib | /lib64 | /media | /mnt | /opt | /proc | /root | /run | /sbin | /srv | /sys | /tmp | /usr | /var | \
      /boot/* | /dev/* | /etc/* | /proc/* | /run/* | /sys/* | /tmp/* | /usr/*)
      die "$1 can't be the install folder. Use a folder of its own, such as /opt/$NAME." ;;
  esac
}

# The service account has to be able to reach the folder through its parents.
check_traversable() {
  local dir=$1
  while [ "$dir" != / ]; do
    dir=$(dirname "$dir")
    if [ -d "$dir" ] && [ -z "$(find "$dir" -maxdepth 0 -perm -0001 2>/dev/null)" ]; then
      die "The '$SVC_USER' account couldn't reach $1 because $dir is closed to other users. Pick a folder such as /opt/$NAME or /srv/$NAME."
    fi
  done
}

# True when $1 is missing or empty, or is the folder this installer recorded
# as its own. Anything else could be someone's data, whatever it contains.
looks_like_ours() {
  [ -e "$1" ] || return 0
  [ -d "$1" ] || return 1
  if [ "$(state_get install_dir)" = "$1" ]; then return 0; fi
  [ -z "$(ls -A "$1")" ]
}

# check_name_free has already refused names that belong to something else.
detect_existing() {
  local workdir recorded port=""
  if [ -f "$UNIT_FILE" ]; then
    workdir=$(sed -n 's/^WorkingDirectory=//p' "$UNIT_FILE")
    workdir=${workdir%%$'\n'*}
    if [ "$DIR_GIVEN" = 1 ] && [ "${INSTALL_DIR%/}/app" != "$workdir" ]; then
      die "Velocity is already installed in ${workdir%/app}. To move it, uninstall it (your data stays), move the folder, then install with --dir."
    fi
    INSTALL_DIR=${workdir%/app}
    EXISTING=1
  fi
  recorded=$(state_get install_dir)
  INSTALL_DIR=${INSTALL_DIR:-${recorded:-/opt/$NAME}}
  INSTALL_DIR=${INSTALL_DIR%/}
  check_install_dir "$INSTALL_DIR"
  APP_DIR=$INSTALL_DIR/app
  RUNTIME_DIR=$INSTALL_DIR/runtime

  if [ "$EXISTING" = 0 ]; then
    looks_like_ours "$INSTALL_DIR" || die "$INSTALL_DIR already exists and holds other files. Choose another folder with --dir."
    check_traversable "$INSTALL_DIR"
  fi

  # The settings file, or for an install that stopped before writing it, the state.
  if [ -f "$ENV_FILE" ]; then
    port=$(sed -n 's/^PORT=//p' "$ENV_FILE")
    port=${port##*$'\n'}
  fi
  if [ -z "$port" ]; then port=$(state_get port); fi
  if [[ $port =~ ^[0-9]+$ ]]; then
    if [ "$EXISTING" = 1 ]; then CURRENT_PORT=$port; fi
    if [ "$PORT_GIVEN" = 0 ]; then PORT=$port; fi
  fi
}

# Uses the checkout the script runs from; otherwise (piped from curl, or the
# copy in the install folder) the source is downloaded.
resolve_source() {
  local dir
  SRC=
  is_this_script "$0" || return 0
  dir=$(cd "$(dirname "$0")" && pwd -P)
  if [ -f "$dir/server.js" ] && [ -f "$dir/client/package.json" ]; then SRC=$dir; fi
}

check_disk_space() {
  local probe=$INSTALL_DIR df_out avail
  while [ ! -d "$probe" ]; do probe=$(dirname "$probe"); done
  df_out=$(df -Pk "$probe" 2>/dev/null) || return 0
  read -r _ _ _ avail _ <<<"${df_out##*$'\n'}"
  if [[ $avail =~ ^[0-9]+$ ]] && [ "$avail" -lt "$MIN_FREE_KB" ]; then
    die "The installer needs at least 1 GB free on the disk holding $INSTALL_DIR."
  fi
}

port_in_use() {
  local out
  command -v ss >/dev/null 2>&1 || return 1
  out=$(ss -Hltn "sport = :$1" 2>/dev/null) || return 1
  [ -n "$out" ]
}

lan_address() {
  local out=""
  out=$(ip -4 route get 1.1.1.1 2>/dev/null) || out=""
  if [[ $out =~ src\ ([0-9.]+) ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return 0
  fi
  out=$(hostname -I 2>/dev/null) || out=""
  printf '%s' "${out%% *}"
}

state_get() {
  [ -f "$STATE_FILE" ] || return 0
  sed -n "s/^$1=//p" "$STATE_FILE"
}

state_set() {
  mkdir -p "$CONFIG_DIR"
  touch "$STATE_FILE"
  sed -i "/^$1=/d" "$STATE_FILE"
  printf '%s=%s\n' "$1" "$2" >>"$STATE_FILE"
}

state_del() {
  if [ -f "$STATE_FILE" ]; then sed -i "/^$1=/d" "$STATE_FILE"; fi
}

name_arg() {
  if [ "$NAME" != velocity ]; then printf ' --name %s' "$NAME"; fi
}

# installer_cmd [args]: how to run this installer again later.
installer_cmd() {
  local sudo=""
  if command -v sudo >/dev/null 2>&1; then sudo="sudo "; fi
  if [ -f "$INSTALL_DIR/install.sh" ]; then
    printf '%sbash %s/install.sh%s' "$sudo" "$INSTALL_DIR" "${1-}"
  else
    printf 'curl -fsSL https://raw.githubusercontent.com/%s/%s/install.sh | %sbash -s --%s' "$REPO" "$REF" "$sudo" "${1-}"
  fi
}

# --- Packages -----------------------------------------------------------------

have_ca_bundle() {
  local f
  for f in /etc/ssl/certs/ca-certificates.crt /etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem \
    /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/ca-bundle.pem /etc/ssl/cert.pem; do
    if [ -s "$f" ]; then return 0; fi
  done
  return 1
}

# Commands needed to download Node.js and compile the native modules.
missing_base() {
  local cmd missing=()
  for cmd in curl tar gzip python3 make g++; do
    command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
  done
  echo "${missing[*]}"
}

base_packages_for() {
  local cmd pkgs=()
  for cmd in "$@"; do
    case $PM:$cmd in
      apt:make | apt:g++) pkgs+=(build-essential) ;;
      dnf:g++ | zypper:g++) pkgs+=(gcc gcc-c++) ;;
      pacman:g++) pkgs+=(gcc) ;;
      pacman:python3) pkgs+=(python) ;;
      *) pkgs+=("$cmd") ;;
    esac
  done
  echo "${pkgs[*]}"
}

missing_extras() {
  local missing=()
  command -v ffmpeg >/dev/null 2>&1 || missing+=(ffmpeg)
  command -v magick >/dev/null 2>&1 || command -v convert >/dev/null 2>&1 || missing+=(ImageMagick)
  command -v exiftool >/dev/null 2>&1 || missing+=(ExifTool)
  echo "${missing[*]}"
}

# Package names to try, in order, for each preview tool.
extra_packages() {
  case $PM:$1 in
    apt:ffmpeg) echo ffmpeg ;;
    apt:ImageMagick) echo imagemagick ;;
    apt:ExifTool) echo libimage-exiftool-perl ;;
    dnf:ffmpeg) echo ffmpeg ffmpeg-free ;;
    dnf:ImageMagick) echo ImageMagick ;;
    dnf:ExifTool) echo perl-Image-ExifTool ;;
    pacman:ffmpeg) echo ffmpeg ;;
    pacman:ImageMagick) echo imagemagick ;;
    pacman:ExifTool) echo perl-image-exiftool ;;
    zypper:ffmpeg) echo ffmpeg ffmpeg-7 ;;
    zypper:ImageMagick) echo ImageMagick ;;
    zypper:ExifTool) echo exiftool ;;
  esac
}

pkg_install() {
  local rc=0
  case $PM in
    apt)
      if [ "$APT_UPDATED" = 0 ]; then
        apt-get -o DPkg::Lock::Timeout=300 update || echo "apt-get update had problems; installing anyway"
        APT_UPDATED=1
      fi
      DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1 apt-get -o DPkg::Lock::Timeout=300 \
        -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold \
        install -y --no-install-recommends "$@" ;;
    dnf) dnf install -y --setopt=install_weak_deps=False "$@" ;;
    # Arch doesn't support partial upgrades, so installing means upgrading too.
    pacman) pacman -Syu --needed --noconfirm "$@" ;;
    zypper)
      ZYPP_LOCK_TIMEOUT=300 zypper --non-interactive install --no-recommends "$@" || rc=$?
      # Codes from 100 up are informational (106: some repos were skipped),
      # except 104 (no such package) and 105 (interrupted).
      [ "$rc" -eq 0 ] || { [ "$rc" -ge 100 ] && [ "$rc" -ne 104 ] && [ "$rc" -ne 105 ]; } ;;
    *) return 1 ;;
  esac
}

install_build_tools() {
  local still
  if ! have_ca_bundle; then set -- "$@" ca-certificates; fi
  pkg_install "$@"
  still=$(missing_base)
  if [ -n "$still" ]; then
    echo "ERROR: still missing after installing packages: $still"
    return 1
  fi
}

install_extras() {
  local tool pkg first=()
  for tool in $(missing_extras); do
    pkg=$(extra_packages "$tool")
    first+=("${pkg%% *}")
  done
  # One transaction first (a single `pacman -Syu` on Arch), then tool by tool
  # with the fallback names.
  if [ "${#first[@]}" -gt 0 ] && pkg_install "${first[@]}"; then return 0; fi
  for tool in $(missing_extras); do
    for pkg in $(extra_packages "$tool"); do
      if pkg_install "$pkg"; then break; fi
    done
  done
}

ffmpeg_can_h264() {
  local encoders
  encoders=$(ffmpeg -hide_banner -encoders 2>/dev/null) || return 0
  [[ $encoders == *libx264* ]]
}

install_packages() {
  local missing hint=""
  missing=$(missing_base)
  if [ -n "$missing" ]; then
    [ -n "$PM" ] || die "Please install these with your package manager, then run the installer again: $missing"
    # shellcheck disable=SC2046,SC2086 # one package name per word
    step "Build tools" install_build_tools $(base_packages_for $missing)
  else
    ok "Build tools ${DIM}(already installed)${RESET}"
  fi
  if [ "$WANT_EXTRAS" = 1 ] && [ "$EXISTING" = 0 ] && [ -n "$PM" ] && [ -n "$(missing_extras)" ]; then
    step "Preview tools" install_extras
    missing=$(missing_extras)
    if [ -n "$missing" ]; then
      warn "Couldn't install ${missing// /, }. Velocity still works; only the previews that need it are off."
    fi
  fi
  if [ "$EXISTING" = 0 ] && command -v ffmpeg >/dev/null 2>&1 && ! ffmpeg_can_h264; then
    if [ "$PM" = dnf ]; then
      hint=" For the full ffmpeg, enable RPM Fusion and run: dnf swap ffmpeg-free ffmpeg --allowerasing"
    fi
    warn "This ffmpeg can't encode H.264, so .mov videos won't be converted.$hint"
  fi
}

# --- Node.js ------------------------------------------------------------------
# Velocity gets its own Node.js under runtime/, so distro upgrades can't change
# the version its native modules were built for.

resolve_node() {
  local sums line
  [ -n "$NODE_ARCH" ] || return 1
  NODE_BASE_URL=https://nodejs.org/dist/latest-v$NODE_MAJOR.x
  sums=$(curl -fsSL --retry 3 --max-time 60 "$NODE_BASE_URL/SHASUMS256.txt" 2>>"$LOG_FILE") || return 1
  line=$(grep -E "^[0-9a-f]{64}  node-v[0-9.]+-linux-$NODE_ARCH\.tar\.gz\$" <<<"$sums") || return 1
  line=${line%%$'\n'*}
  NODE_SHA=${line%% *}
  NODE_TARBALL=${line##* }
  NODE_VERSION=${NODE_TARBALL#node-}
  NODE_VERSION=${NODE_VERSION%-linux-"$NODE_ARCH".tar.gz}
}

download_node() {
  local dest=$RUNTIME_DIR/node-$NODE_VERSION-linux-$NODE_ARCH tmp
  if [ -x "$dest/bin/node" ]; then
    echo "Node.js $NODE_VERSION is already installed"
    return 0
  fi
  mkdir -p "$RUNTIME_DIR"
  # Unpacked next to its final place so it gets that folder's SELinux label.
  tmp=$(mktemp -d "$RUNTIME_DIR/.download.XXXXXX")
  TEMP_PATHS+=("$tmp")
  curl -fsSL --retry 3 -o "$tmp/node.tar.gz" "$NODE_BASE_URL/$NODE_TARBALL"
  printf '%s  %s\n' "$NODE_SHA" "$tmp/node.tar.gz" | sha256sum -c -
  mkdir "$tmp/node"
  tar -xzf "$tmp/node.tar.gz" -C "$tmp/node" --strip-components=1 --no-same-owner
  rm -rf "$dest"
  mv "$tmp/node" "$dest"
  rm -rf "$tmp"
}

current_runtime() {
  local target
  target=$(readlink "$RUNTIME_DIR/node" 2>/dev/null) || return 1
  [ -x "$RUNTIME_DIR/$target/bin/node" ] || return 1
  printf '%s' "$target"
}

use_private_node() {
  USE_PRIVATE_NODE=1
  NODE_DIR_NAME=$1
  NODE_BIN_DIR=$RUNTIME_DIR/$1/bin
  NODE_EXEC=$RUNTIME_DIR/node/bin/node
}

# 22.12 or newer: Vite needs it on the 22 line, and better-sqlite3 ships no binaries for
# Node 20 (which has reached end of life), so it would have to be compiled there.
system_node_ok() {
  local node
  node=$(command -v node 2>/dev/null) || return 1
  command -v npm >/dev/null 2>&1 || return 1
  "$node" -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit(major >= 23 || (major === 22 && minor >= 12) ? 0 : 1);
  ' >/dev/null 2>&1
}

setup_node() {
  local current
  if resolve_node; then
    step "Node.js $NODE_VERSION" download_node
    if "$RUNTIME_DIR/node-$NODE_VERSION-linux-$NODE_ARCH/bin/node" -e 0 >>"$LOG_FILE" 2>&1; then
      use_private_node "node-$NODE_VERSION-linux-$NODE_ARCH"
      return 0
    fi
    warn "The official Node.js $NODE_VERSION build doesn't run here (it needs glibc 2.28 or newer)."
    rm -rf "$RUNTIME_DIR/node-$NODE_VERSION-linux-$NODE_ARCH"
  elif current=$(current_runtime); then
    NODE_VERSION=${current#node-}
    NODE_VERSION=${NODE_VERSION%%-linux-*}
    warn "Couldn't reach nodejs.org to check for updates; keeping Node.js $NODE_VERSION."
    use_private_node "$current"
    return 0
  fi
  if system_node_ok; then
    USE_PRIVATE_NODE=0
    NODE_EXEC=$(command -v node)
    NODE_BIN_DIR=${NODE_EXEC%/*}
    ok "Node.js $("$NODE_EXEC" --version) (from the system)"
    return 0
  fi
  die "Couldn't set up Node.js for $(uname -m). Install Node.js 22.12 or newer with your package manager, then run the installer again."
}

# --- Build and install --------------------------------------------------------

download_source() {
  DOWNLOAD_DIR=$(mktemp -d "${TMPDIR:-/tmp}/velocity-src.XXXXXX")
  TEMP_PATHS+=("$DOWNLOAD_DIR")
  curl -fsSL --retry 3 -o "$DOWNLOAD_DIR/source.tar.gz" "$TARBALL_URL"
  mkdir "$DOWNLOAD_DIR/source"
  tar -xzf "$DOWNLOAD_DIR/source.tar.gz" -C "$DOWNLOAD_DIR/source" --strip-components=1 --no-same-owner
  rm -f "$DOWNLOAD_DIR/source.tar.gz"
  SRC=$DOWNLOAD_DIR/source
}

# A newer installer handed us its download folder to clean up (see below).
adopt_download_dir() {
  local dir=${VELOCITY_CLEANUP:-}
  if [ -n "$dir" ] && [ -d "$dir" ] && [[ ${dir##*/} == velocity-src.* ]]; then
    TEMP_PATHS+=("$dir")
    DOWNLOAD_DIR=$dir
  fi
}

# An update run from an older copy switches to the installer that ships with
# the downloaded version, so that version's install steps apply.
use_newer_installer() {
  [ -z "${VELOCITY_REEXEC:-}" ] || return 0
  if ! is_this_script "$0" || [ ! -f "$SRC/install.sh" ]; then return 0; fi
  if [ "$(sha256sum <"$0")" = "$(sha256sum <"$SRC/install.sh")" ]; then return 0; fi
  info "Switching to the installer that comes with this version."
  trap - EXIT INT TERM
  exec 9>&- 3>&-
  exec env VELOCITY_REEXEC=1 VELOCITY_CLEANUP="$DOWNLOAD_DIR" VELOCITY_REPO="$REPO" VELOCITY_REF="$REF" \
    VELOCITY_TARBALL_URL="$TARBALL_URL" VELOCITY_NODE_MAJOR="$NODE_MAJOR" bash "$SRC/install.sh" "${ORIG_ARGS[@]}"
}

# /opt/velocity stays root's; only app/ belongs to the service account.
ensure_service_account() {
  local shell=/bin/false candidate group
  if ! id -u "$SVC_USER" >/dev/null 2>&1; then
    for candidate in /usr/sbin/nologin /sbin/nologin /usr/bin/nologin; do
      if [ -x "$candidate" ]; then
        shell=$candidate
        break
      fi
    done
    if getent group "$SVC_USER" >/dev/null 2>&1; then
      useradd --system --gid "$SVC_USER" --home-dir "$APP_DIR" --no-create-home --shell "$shell" "$SVC_USER"
    else
      useradd --system --user-group --home-dir "$APP_DIR" --no-create-home --shell "$shell" "$SVC_USER"
    fi
    state_set created_user "$SVC_USER"
  fi
  state_set install_dir "$INSTALL_DIR"
  # So a run that stops before the settings file exists still knows the port.
  state_set port "$PORT"
  group=$(id -gn "$SVC_USER")
  install -d -o root -g root -m 0755 "$INSTALL_DIR"
  install -d -o "$SVC_USER" -g "$group" -m 0750 "$APP_DIR"
}

# npm runs as the service account, never as root. Its home is the cache folder,
# so updates reuse downloaded packages.
as_service_user() {
  local var env_args=(
    HOME="$CACHE_DIR"
    TMPDIR="$STAGE/.tmp"
    PATH="$NODE_BIN_DIR:/usr/local/bin:/usr/bin:/bin"
    npm_config_update_notifier=false
  )
  for var in http_proxy https_proxy no_proxy HTTP_PROXY HTTPS_PROXY NO_PROXY NODE_EXTRA_CA_CERTS npm_config_registry; do
    if [ -n "${!var:-}" ]; then env_args+=("$var=${!var}"); fi
  done
  runuser -u "$SVC_USER" -- env -i "${env_args[@]}" "$@"
}

# The new version is built in .staging while the current one keeps running.
prepare_stage() {
  STAGE=$INSTALL_DIR/.staging
  TEMP_PATHS+=("$STAGE")
  rm -rf "$STAGE"
  mkdir -m 0700 "$STAGE"
  tar -C "$SRC" -cf - "${SOURCE_EXCLUDES[@]}" . | tar -C "$STAGE" -xf - --no-same-owner --no-same-permissions
  if [ ! -f "$STAGE/server.js" ] || [ ! -f "$STAGE/client/package.json" ]; then
    echo "ERROR: $SRC isn't a complete copy of Velocity (server.js and client/ are needed)."
    return 1
  fi
  mkdir -p "$STAGE/.tmp"
  chown -R "$SVC_USER:" "$STAGE"
  install -d -o "$SVC_USER" -g "$(id -gn "$SVC_USER")" -m 0750 "$CACHE_DIR"
}

build_server() {
  (cd "$STAGE" && as_service_user npm ci --omit=dev --no-audit --no-fund)
}

build_client() {
  (cd "$STAGE/client" && as_service_user npm ci --no-audit --no-fund && as_service_user npm run build &&
    as_service_user rm -rf node_modules)
}

# Runs as the service account, so root never writes inside the folder that
# account controls. Swaps in the new build and removes code files the new
# version no longer has; data never appears in those file lists.
deploy_files() {
  set -eu
  local stage=$1 app=$2 list=.installed-files old=""
  cd "$stage"
  rm -rf .tmp
  find . \( -path ./node_modules -o -path ./client/dist -o -path "./$list" \) -prune -o \( -type f -o -type l \) -print |
    LC_ALL=C sort >"$list"
  if [ -f "$app/$list" ]; then old=$(cat "$app/$list"); fi
  # Renames first, so the old and new dependency trees swap in a moment; the
  # old ones are deleted at the end.
  rm -rf "$app/.old-node_modules" "$app/.old-dist"
  mkdir -p "$app/client"
  if [ -e "$app/node_modules" ]; then mv "$app/node_modules" "$app/.old-node_modules"; fi
  if [ -e "$app/client/dist" ]; then mv "$app/client/dist" "$app/.old-dist"; fi
  mv node_modules "$app/node_modules"
  mv client/dist "$app/client/dist"
  # Files the new version doesn't have go before the copy, so a path that
  # turned from a file into a folder (or back) can't trip it up. Folders are
  # only removed once empty, so data inside them is never touched.
  if [ -n "$old" ]; then
    LC_ALL=C comm -23 <(printf '%s\n' "$old") "$list" | while IFS= read -r file; do
      if [ "$file" = "./$list" ] || { [ -d "$app/$file" ] && [ ! -L "$app/$file" ]; }; then continue; fi
      rm -f -- "$app/$file"
      (cd "$app" && rmdir -p --ignore-fail-on-non-empty -- "$(dirname -- "$file")" 2>/dev/null) || true
    done
  fi
  tar -cf - . | tar -C "$app" -xf -
  rm -rf "$app/.old-node_modules" "$app/.old-dist"
}

# Running Velocity by hand as root leaves files the service can't write.
repair_ownership() {
  local stray
  stray=$(find "$APP_DIR" -maxdepth 1 ! -user "$SVC_USER" -print -quit 2>/dev/null) || stray=""
  [ -n "$stray" ] || return 0
  find "$APP_DIR" -xdev ! -user "$SVC_USER" \( -type d -o -links 1 \) -execdir chown -h "$SVC_USER:" {} + || true
}

deploy() {
  local updater=""
  if systemctl is-active --quiet "$SERVICE"; then
    systemctl stop "$SERVICE"
    SERVICE_STOPPED=1
  fi
  if command -v pkill >/dev/null 2>&1; then pkill -KILL -u "$SVC_USER" || true; fi
  repair_ownership
  runuser -u "$SVC_USER" -- bash -c "$(declare -f deploy_files); deploy_files \"\$1\" \"\$2\"" deploy "$STAGE" "$APP_DIR"
  rm -rf "$STAGE"
  # The copy that `Update` runs lives outside app/, where only root can change it.
  if [ -f "$SRC/install.sh" ]; then
    updater=$SRC/install.sh
  elif is_this_script "$0"; then
    updater=$0
  fi
  if [ -n "$updater" ] && [ ! "$updater" -ef "$INSTALL_DIR/install.sh" ]; then
    install -m 0755 -o root -g root "$updater" "$INSTALL_DIR/install.sh"
  fi
  if [ "$USE_PRIVATE_NODE" = 1 ]; then ln -sfn "$NODE_DIR_NAME" "$RUNTIME_DIR/node"; fi
  chown root:root "$INSTALL_DIR"
  chmod 0755 "$INSTALL_DIR"
  chown "$SVC_USER:" "$APP_DIR"
  chmod 0750 "$APP_DIR"
  SERVICE_STOPPED=0
}

prune_runtimes() {
  local dir
  [ "$USE_PRIVATE_NODE" = 1 ] || return 0
  for dir in "$RUNTIME_DIR"/node-v*; do
    if [ -d "$dir" ] && [ "${dir##*/}" != "$NODE_DIR_NAME" ]; then rm -rf "$dir"; fi
  done
}

# --- Service ------------------------------------------------------------------

write_env_file() {
  cat >"$ENV_FILE" <<EOF
# Velocity settings, read by $SERVICE.service.
# After changing anything here, run: systemctl restart $SERVICE

# Port for the web interface.
PORT=$PORT

# Disks mounted under /media, /run/media and /mnt are offered as external
# drives, as long as the '$SVC_USER' account may read them (mount them with its
# uid/gid; see DEPLOY-UBUNTU.md in the Velocity repository). To scan other mount
# points too, list them here, separated by commas:
#VELOCITY_EXTERNAL_DRIVES=/srv/disk1,/data

# Only the owner can add accounts (in Settings). To let anyone who can reach
# the server create their own account, uncomment this:
#VELOCITY_SIGNUP=open

# Behind a reverse proxy on this machine (Caddy, nginx) that provides HTTPS,
# uncomment this so the plain-HTTP port isn't reachable from the network:
#VELOCITY_HOST=127.0.0.1

NODE_ENV=production
VELOCITY_NO_COLOR=1
EOF
}

set_env() {
  if grep -q "^$1=" "$ENV_FILE"; then
    sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"
  fi
}

# write_unit full|minimal: minimal leaves out what some containers can't apply.
write_unit() {
  {
    printf '%s (install.sh), which rewrites this file on\n' "$UNIT_MARKER"
    printf '# every run. Put local changes in a drop-in instead: systemctl edit %s\n' "$SERVICE"
    cat <<EOF
[Unit]
Description=Velocity file manager
After=network.target

[Service]
Type=simple
User=$SVC_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
Environment=PATH=$SYSTEM_PATH
ExecStart=$NODE_EXEC $APP_DIR/server.js
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
LimitNOFILE=65536
NoNewPrivileges=true
EOF
    if [ "$1" = full ]; then
      cat <<'EOF'
# Lets PORT be below 1024 without running as root.
AmbientCapabilities=CAP_NET_BIND_SERVICE
# Sandboxing. The installer leaves this out where the system can't apply it.
PrivateTmp=true
ProtectSystem=full
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
LockPersonality=true
EOF
    fi
    printf '\n[Install]\nWantedBy=multi-user.target\n'
  } >"$UNIT_FILE"
}

configure_service() {
  mkdir -p "$CONFIG_DIR"
  if [ ! -f "$ENV_FILE" ]; then
    write_env_file
  elif [ "$EXISTING" = 0 ] || [ "$PORT_GIVEN" = 1 ]; then
    set_env PORT "$PORT"
  fi
  chmod 600 "$ENV_FILE"
  state_set port "$PORT"
  write_unit full
  if command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled; then
    # bin_t is runnable by systemd wherever the install folder is.
    if [ "$USE_PRIVATE_NODE" = 1 ]; then chcon -R -t bin_t "$RUNTIME_DIR/$NODE_DIR_NAME/bin" || true; fi
    if command -v restorecon >/dev/null 2>&1; then restorecon -R "$UNIT_FILE" "$CONFIG_DIR" || true; fi
  fi
  systemctl daemon-reload
  systemctl enable --quiet "$SERVICE"
}

# wait_for_service [seconds] [port]: waits for Velocity to answer. After a
# crash, LAST_EXIT_STATUS holds its exit status.
wait_for_service() {
  local i props limit=${1:-60} port=${2:-$PORT}
  LAST_EXIT_STATUS=0
  for ((i = 0; i < limit; i++)); do
    sleep 1
    if curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:$port/api/auth/bootstrap" 2>/dev/null; then return 0; fi
    props=$(systemctl show -p Result -p ExecMainStatus "$SERVICE" 2>/dev/null) || props=""
    case $props in
      "" | *Result=success*) ;;
      *)
        LAST_EXIT_STATUS=${props#*ExecMainStatus=}
        LAST_EXIT_STATUS=${LAST_EXIT_STATUS%%[!0-9]*}
        LAST_EXIT_STATUS=${LAST_EXIT_STATUS:-0}
        return 1 ;;
    esac
  done
  return 1
}

start_velocity() {
  systemctl restart "$SERVICE" || true
  if wait_for_service; then return 0; fi
  # systemd's own codes for a sandbox it couldn't build, as in containers
  # without mount namespaces: 218 CAPABILITIES, 226 NAMESPACE, 228 SECCOMP.
  case $LAST_EXIT_STATUS in
    218 | 226 | 228)
      echo "systemd couldn't set up the sandbox (exit status $LAST_EXIT_STATUS); retrying without it"
      SANDBOX_DROPPED=1
      write_unit minimal
      systemctl daemon-reload
      systemctl restart "$SERVICE" || true
      if wait_for_service; then return 0; fi ;;
  esac
  systemctl --no-pager status "$SERVICE" || true
  journalctl -u "$SERVICE" -n 40 --no-pager || true
  return 1
}

# --- Firewall -----------------------------------------------------------------

# firewall-cmd waits about 10 seconds for D-Bus when firewalld is stopped.
firewalld_running() {
  systemctl is-active --quiet firewalld && firewall-cmd --state >/dev/null 2>&1
}

detect_firewall() {
  local status
  FIREWALL=
  if command -v ufw >/dev/null 2>&1; then
    status=$(ufw status 2>/dev/null) || status=""
    if [[ $status == *"Status: active"* ]]; then
      FIREWALL=ufw
      return 0
    fi
  fi
  if command -v firewall-cmd >/dev/null 2>&1 && firewalld_running; then FIREWALL=firewalld; fi
}

firewall_port_open() {
  local status pattern
  case $FIREWALL in
    ufw)
      status=$(ufw status 2>/dev/null) || status=""
      pattern="(^|"$'\n'")$PORT(/tcp)?[[:space:]]+ALLOW"
      [[ $status =~ $pattern ]] ;;
    firewalld) firewall-cmd --query-port="$PORT/tcp" >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

open_firewall() {
  local previous
  previous=$(state_get firewall)
  if [ -n "$previous" ] && [ "$previous" != "$FIREWALL $PORT/tcp" ]; then close_firewall_rule "$previous" || true; fi
  case $FIREWALL in
    ufw) ufw allow "$PORT/tcp" comment Velocity ;;
    # Runtime and permanent separately: a --reload would drop the admin's other
    # runtime-only rules.
    firewalld)
      firewall-cmd --add-port="$PORT/tcp"
      firewall-cmd --permanent --add-port="$PORT/tcp" ;;
  esac
  state_set firewall "$FIREWALL $PORT/tcp"
}

# close_firewall_rule "<ufw|firewalld> <port>/tcp"; fails if it couldn't.
close_firewall_rule() {
  local kind=${1%% *} rule=${1#* }
  case $kind in
    ufw) command -v ufw >/dev/null 2>&1 && ufw delete allow "$rule" ;;
    firewalld)
      if firewalld_running; then
        firewall-cmd --remove-port="$rule" && firewall-cmd --permanent --remove-port="$rule"
      else
        command -v firewall-offline-cmd >/dev/null 2>&1 && firewall-offline-cmd --remove-port="$rule"
      fi ;;
    *) return 1 ;;
  esac
}

ask_firewall() {
  detect_firewall
  [ -n "$FIREWALL" ] || return 0
  if firewall_port_open; then return 0; fi
  if confirm "Allow port $PORT through the firewall ($FIREWALL) so other devices can connect?" Y; then OPEN_FIREWALL=1; fi
}

# --- Owner account ------------------------------------------------------------

ask_owner() {
  local user="" pass="" again=""
  while :; do
    ask user "Username" ""
    user=${user//[[:space:]]/}
    # The rule from user-store.js, checked now rather than after the install.
    if [[ $user =~ ^[A-Za-z0-9][A-Za-z0-9._-]{1,30}[A-Za-z0-9]$ ]]; then break; fi
    info "Use 3 to 32 letters, numbers, dots, dashes or underscores, starting and ending with a letter or number."
  done
  while :; do
    ask_secret pass "Password (at least 8 characters)"
    if [ "${#pass}" -lt 8 ]; then
      info "That's shorter than 8 characters."
      continue
    fi
    ask_secret again "Type the password again"
    if [ "$pass" = "$again" ]; then break; fi
    info "Those didn't match. Let's try again."
  done
  OWNER_USER=$user
  OWNER_PASS=$pass
}

has_users() {
  local out
  out=$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/auth/bootstrap" 2>/dev/null) || return 2
  [[ $out == *'"hasUsers":true'* ]]
}

# Signs up through Velocity's own API, so the owner is set up exactly as from
# the browser. Prints the server's reason on failure.
signup() {
  VELOCITY_SIGNUP_URL="http://127.0.0.1:$PORT/api/signup" VELOCITY_SIGNUP_USER=$1 VELOCITY_SIGNUP_PASS=$2 \
    "$NODE_EXEC" -e '
      const { VELOCITY_SIGNUP_URL: url, VELOCITY_SIGNUP_USER: username, VELOCITY_SIGNUP_PASS: password } = process.env;
      fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) })
        .then(async (res) => {
          if (res.ok) return;
          const body = await res.json().catch(() => ({}));
          console.log(body.message || (body.error === "username_taken" ? "That username is taken." : body.error) || `HTTP ${res.status}`);
          process.exitCode = 1;
        })
        .catch((err) => { console.log(err.message); process.exitCode = 1; });
    '
}

create_owner() {
  local message attempts=0
  [ -n "$OWNER_USER" ] || return 0
  while :; do
    if has_users; then
      info "An account already exists, so no owner account was created."
      break
    fi
    if message=$(signup "$OWNER_USER" "$OWNER_PASS" 2>&1); then
      OWNER_CREATED=1
      ok "Owner account '$OWNER_USER'"
      break
    fi
    attempts=$((attempts + 1))
    if [ "$INTERACTIVE" != 1 ] || [ "$attempts" -ge 3 ]; then
      warn "Couldn't create the owner account ($message). Create it in the browser instead."
      break
    fi
    info "${YELLOW}Couldn't create the owner account:${RESET} $message"
    ask_owner
  done
  OWNER_PASS=
}

# --- Flows --------------------------------------------------------------------

choose_port() {
  local port=$PORT
  while :; do
    if [ "$PORT_GIVEN" = 0 ]; then ask port "Port for the web interface" "$port"; fi
    if ! [[ $port =~ ^[0-9]{1,5}$ ]] || [ "$((10#$port))" -lt 1 ] || [ "$((10#$port))" -gt 65535 ]; then
      [ "$INTERACTIVE" = 1 ] && [ "$PORT_GIVEN" = 0 ] || die "'$port' isn't a port number (1-65535)."
      info "Please enter a number from 1 to 65535."
      port=$PORT
      continue
    fi
    port=$((10#$port))
    # Velocity's own listener doesn't count.
    if [ "$port" != "$CURRENT_PORT" ] && port_in_use "$port"; then
      [ "$INTERACTIVE" = 1 ] && [ "$PORT_GIVEN" = 0 ] || die "Port $port is already in use by another program. Choose another with --port."
      info "Port $port is already in use by another program."
      port=$((port + 1))
      continue
    fi
    break
  done
  PORT=$port
}

configure() {
  section "Setup"
  if [ "$ASSUME_YES" = 0 ] && [ "$INTERACTIVE" = 0 ]; then
    info "There's no terminal to ask questions on, so the defaults are used."
  fi
  if [ "$EXISTING" = 1 ]; then
    info "Velocity is already installed in $INSTALL_DIR."
    if [ -n "$DOWNLOAD_DIR" ]; then
      info "This updates it to the latest version ($REPO, $REF)."
    else
      info "This updates it from $SRC."
    fi
    info "Your settings, accounts and files are kept."
    if [ "$PORT_GIVEN" = 1 ] && [ "$PORT" != "$CURRENT_PORT" ]; then
      choose_port
      info "The port changes from ${CURRENT_PORT:-its old value} to $PORT."
      ask_firewall
      if [ "$OPEN_FIREWALL" = 1 ] && [ "$INTERACTIVE" = 0 ]; then info "Port $PORT will be opened in the firewall ($FIREWALL)."; fi
    fi
    confirm "Update now?" Y || { info "Nothing was changed."; exit 0; }
    return 0
  fi

  info "Velocity will be installed in $INSTALL_DIR and run in the background as the"
  info "'$SERVICE' service, which starts when the computer boots."
  if [ -n "$DOWNLOAD_DIR" ]; then info "Version: the latest from GitHub ($REPO, $REF)."; fi
  if [ "$PM" = pacman ] && { [ -n "$(missing_base)" ] || { [ "$WANT_EXTRAS" = 1 ] && [ -n "$(missing_extras)" ]; }; }; then
    info "On Arch, installing packages also upgrades the system (pacman -Syu)."
  fi
  gap
  choose_port
  if [ "$WANT_EXTRAS" = 1 ] && [ -n "$PM" ] && [ -n "$(missing_extras)" ]; then
    confirm "Install the optional preview tools (ffmpeg, ImageMagick, ExifTool)? They add a few hundred MB." Y || WANT_EXTRAS=0
  fi
  ask_firewall
  if [ "$INTERACTIVE" = 1 ] && [ ! -f "$APP_DIR/operations.db" ]; then
    printf '\n'
    info "The first account is the owner, who manages everyone else's accounts."
    if confirm "Create the owner account now? (Otherwise, do it in the browser.)" Y; then ask_owner; fi
  fi

  if [ "$INTERACTIVE" = 1 ]; then
    printf '\n'
    confirm "Ready to install. Continue?" Y || { info "Nothing was changed."; exit 0; }
    return 0
  fi
  info "Port: $PORT"
  if [ "$WANT_EXTRAS" = 1 ] && [ -n "$PM" ] && [ -n "$(missing_extras)" ]; then info "Preview tools: will be installed"; fi
  if [ "$OPEN_FIREWALL" = 1 ]; then info "Firewall: port $PORT will be opened ($FIREWALL)"; fi
  if [ -f "$APP_DIR/operations.db" ]; then
    info "Accounts: kept from the earlier install"
  else
    info "Owner account: create it in the browser once Velocity is running"
  fi
}

install_velocity() {
  INSTALL_STARTED=1
  if [ "$EXISTING" = 1 ]; then
    section "Updating ${DIM}(this takes a minute or two)${RESET}"
  else
    section "Installing ${DIM}(this takes a few minutes)${RESET}"
  fi
  check_disk_space
  install_packages
  if [ -z "$SRC" ]; then step "Velocity source ($REPO, $REF)" download_source; fi
  step "Service account '$SVC_USER'" ensure_service_account
  setup_node
  step "Velocity files" prepare_stage
  step "Server dependencies" build_server
  step "Web interface" build_client
  step "Installation in $INSTALL_DIR" deploy
  step "Service $SERVICE.service" configure_service
  step "Velocity running on port $PORT" start_velocity
  if [ "$SANDBOX_DROPPED" = 1 ]; then
    warn "This system can't apply the service's sandboxing options, so Velocity runs without them."
  fi
  prune_runtimes
  create_owner
  # Opened last, so the port isn't reachable before the owner account exists.
  if [ "$OPEN_FIREWALL" = 1 ]; then step "Firewall rule for port $PORT ($FIREWALL)" open_firewall; fi
}

summary() {
  local address warning sudo=""
  if command -v sudo >/dev/null 2>&1; then sudo="sudo "; fi
  address=$(lan_address)
  section "${GREEN}Velocity is ready${RESET}"
  if [ -n "$address" ]; then
    info "Open ${BOLD}http://$address:$PORT${RESET} in a browser on any device on your network,"
    info "or http://localhost:$PORT on this computer."
  else
    info "Open ${BOLD}http://localhost:$PORT${RESET} in a browser."
  fi
  if [ "$OWNER_CREATED" = 1 ]; then
    info "Sign in as '$OWNER_USER'."
  elif ! has_users; then
    info "Create the owner account there now. The first account becomes the owner,"
    info "and until it exists, anyone who can reach this address could claim it."
  fi
  printf '\n'
  info "Status      ${sudo}systemctl status $SERVICE"
  info "Restart     ${sudo}systemctl restart $SERVICE"
  info "Logs        ${sudo}journalctl -u $SERVICE -f"
  info "Settings    $ENV_FILE"
  info "Your files  $APP_DIR (back this folder up)"
  info "Update      $(installer_cmd "$(name_arg)")"
  info "Uninstall   $(installer_cmd " --uninstall$(name_arg)")"
  printf '\n'
  info "${DIM}Velocity speaks plain HTTP, and anyone who can reach it can sign up for"
  info "an account. Before exposing it to the internet, put it behind an HTTPS"
  info "reverse proxy (Caddy, nginx) or a VPN such as Tailscale.${RESET}"
  if [ "${#WARNINGS[@]}" -gt 0 ]; then
    printf '\n'
    info "${YELLOW}Warnings${RESET}"
    for warning in "${WARNINGS[@]}"; do info "- $warning"; done
  fi
}

remove_account() {
  local created
  created=$(state_get created_user)
  if [ -n "$created" ] && id -u "$created" >/dev/null 2>&1; then
    if command -v pkill >/dev/null 2>&1; then pkill -KILL -u "$created" || true; fi
    if userdel "$created" >>"$LOG_FILE" 2>&1; then
      ok "Removed the '$created' account"
    else
      warn "Couldn't remove the '$created' account."
    fi
  fi
}

uninstall() {
  local workdir dir="" answer="" delete=0 rule had_unit=0 ours=0
  section "Uninstall"
  if [ "$ASSUME_YES" = 0 ] && [ "$INTERACTIVE" = 0 ]; then
    info "There's no terminal to ask questions on, so the defaults are used."
  fi
  if [ -f "$UNIT_FILE" ]; then
    grep -qF "$UNIT_MARKER" "$UNIT_FILE" || die "$UNIT_FILE wasn't made by this installer, so it's left alone."
    workdir=$(sed -n 's/^WorkingDirectory=//p' "$UNIT_FILE")
    workdir=${workdir%%$'\n'*}
    dir=${workdir%/app}
    had_unit=1
  else
    dir=$(state_get install_dir)
  fi
  if [ "$DIR_GIVEN" = 1 ]; then
    if [ -n "$dir" ] && [ "${INSTALL_DIR%/}" != "$dir" ]; then die "Velocity is installed in $dir, not ${INSTALL_DIR%/}."; fi
    dir=${INSTALL_DIR%/}
  fi
  dir=${dir:-/opt/$NAME}
  check_install_dir "$dir"
  INSTALL_DIR=$dir
  if [ "$had_unit" = 0 ] && [ ! -f "$STATE_FILE" ] && [ ! -f "$ENV_FILE" ]; then
    info "Velocity isn't installed."
    return 0
  fi
  if looks_like_ours "$dir"; then ours=1; fi

  if [ "$PURGE" = 1 ]; then
    info "This removes Velocity and permanently deletes all its accounts and files in $dir."
  elif [ "$had_unit" = 1 ]; then
    info "This stops Velocity and removes its service. Your accounts and files stay in $dir/app."
  else
    info "Velocity's service is already gone; this tidies up what's left."
  fi
  confirm "Continue?" Y || { info "Nothing was changed."; return 0; }
  printf '\n==> Uninstall [%s]\n' "$(date +%T)" >>"$LOG_FILE"

  if [ "$had_unit" = 1 ]; then
    systemctl disable --now "$SERVICE" >>"$LOG_FILE" 2>&1 || true
    rm -f "$UNIT_FILE"
    systemctl daemon-reload
    systemctl reset-failed "$SERVICE" >/dev/null 2>&1 || true
    ok "Removed $SERVICE.service"
  fi
  rule=$(state_get firewall)
  if [ -n "$rule" ]; then
    if close_firewall_rule "$rule" >>"$LOG_FILE" 2>&1; then
      state_del firewall
      ok "Removed the firewall rule for ${rule#* }"
    else
      warn "Couldn't remove the ${rule%% *} rule for ${rule#* }; remove it by hand."
    fi
  fi
  if [ "$ours" = 1 ]; then rm -rf "$dir/runtime" "$dir/.staging"; fi
  rm -rf "$CACHE_DIR"

  if [ "$PURGE" = 1 ]; then
    delete=1
  elif [ "$INTERACTIVE" = 1 ] && [ -d "$dir/app" ]; then
    printf '\n'
    info "Your accounts and files are in $dir/app."
    ask answer "Type 'delete' to erase them for good, or press Enter to keep them" ""
    if [ "$answer" = delete ]; then delete=1; fi
  fi

  if [ "$delete" = 1 ]; then
    if [ -d "$dir" ]; then
      [ "$ours" = 1 ] || die "$dir holds files this installer didn't make, so it wasn't deleted."
      rm -rf "$dir"
      ok "Deleted $dir"
    fi
    remove_account
    rm -f "$ENV_FILE" "$STATE_FILE"
    rmdir "$CONFIG_DIR" 2>/dev/null || true
    # Drop-ins from `systemctl edit` are ours once no unit of that name is left.
    if [ -d "/etc/systemd/system/$SERVICE.service.d" ] &&
      { [ "$had_unit" = 1 ] || ! systemctl cat -- "$SERVICE.service" >/dev/null 2>&1; }; then
      rm -rf "/etc/systemd/system/$SERVICE.service.d"
      systemctl daemon-reload
    fi
    ok "Removed the settings in $CONFIG_DIR"
    rm -f "$LOG_FILE" "$LOG_PATH.1" "${LOG_PATH%.log}-npm.log" "/run/$NAME-install.lock"
    LOG_FILE=
  elif [ -d "$dir/app" ]; then
    info "Kept your accounts and files in $dir/app, and the settings in $CONFIG_DIR."
    info "Installing again picks them up. To erase everything:"
    info "$(installer_cmd " --uninstall --purge$(name_arg)")"
  fi
  info "Packages installed for Velocity (build tools, preview tools) were left in place."
}

main() {
  ORIG_ARGS=("$@")
  parse_args "$@"
  setup_ui
  require_root "$@"
  exec 4>&1 5>&2
  derive_names
  if [ "$ACTION" = install ]; then check_name_free; fi
  take_lock
  setup_tty
  start_log "$@"
  trap on_signal INT TERM
  trap on_exit EXIT
  adopt_download_dir
  preflight
  # A run that switched to the downloaded installer has printed this already.
  if [ -z "${VELOCITY_REEXEC:-}" ]; then
    printf '%sVelocity installer%s\n' "$BOLD" "$RESET"
    info "${DIM}$OS_NAME, $(uname -m)${RESET}"
  fi
  if [ "$ACTION" = uninstall ]; then
    uninstall
    return 0
  fi
  detect_existing
  resolve_source
  # Downloading before the questions lets an update switch to the newer installer.
  if [ -z "$SRC" ] && command -v curl >/dev/null 2>&1; then
    step "Velocity source ($REPO, $REF)" download_source
    use_newer_installer
  fi
  configure
  install_velocity
  summary
}

main "$@"
exit
