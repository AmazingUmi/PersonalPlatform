#!/usr/bin/env bash
# Standalone PersonalPlatform installer/updater. Host Node/npm/jq are not needed.
set -Eeuo pipefail
umask 077
REPOSITORY=https://github.com/AmazingUmi/PersonalPlatform
DIR=/opt/personal-platform
VERSION='' ENV_SOURCE='' BUNDLE_DIR=''
ADOPT=0 RESUME=0 STATUS=0
PARSER_IMAGE='' PROJECT='' OLD_BACKEND='' OLD_FRONTEND='' STAGE='' BACKUP='' OWNERSHIP_VERIFIED=0 VERIFIED_PROJECT=''
usage() {
  cat <<'HELP'
Usage: bash deploy.sh [--dir PATH] [--version vMAJOR.MINOR.PATCH]
       [--env-file PRIVATE_FILE] [--bundle-dir DOWNLOADED_ASSETS] [--adopt]
       [--resume | --status]

Default: install/update /opt/personal-platform to the latest published stable release.
First install asks for an administrator password; the database password is generated.
--env-file supplies complete private production credentials for noninteractive install.
--bundle-dir uses locally downloaded tar.gz + SHA256SUMS and requires --version.
--adopt explicitly takes over a running manual release deployment in --dir.
--resume retries only a retained pending target; it never restores a database backup.
--status reports the accepted version and any unfinished operation, without secrets.
Docker Engine, Compose >=2.20, Bash >=4, curl, GNU tar/coreutils, openssl and flock
(util-linux) must already be installed. Production browser login requires HTTPS.
HELP
}
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '%s\n' "$*"; }
while (($#)); do
  case "$1" in
    --dir|--version|--env-file|--bundle-dir)
      (($# >= 2)) && [[ -n $2 && $2 != --* ]] || fail "Missing value for $1"
      case "$1" in --dir) DIR=$2;; --version) VERSION=$2;; --env-file) ENV_SOURCE=$2;; --bundle-dir) BUNDLE_DIR=$2;; esac; shift 2;;
    --adopt) ADOPT=1; shift;; --resume) RESUME=1; shift;; --status) STATUS=1; shift;;
    -h|--help) usage; exit 0;; *) fail "Unknown option: $1";;
  esac
done
[[ ${BASH_VERSINFO[0]} -ge 4 ]] || fail 'Bash >=4 is required.'
[[ $(uname -s) == Linux ]] || fail 'Run this script on a Linux server.'
[[ $DIR != *$'\n'* && $DIR != *$'\r'* && $DIR != / ]] || fail 'Invalid deployment directory.'
[[ -z $VERSION || $VERSION =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || fail 'Use a stable version such as v0.1.0.'
[[ -z $BUNDLE_DIR || -n $VERSION ]] || fail '--bundle-dir requires --version.'
(( !ADOPT || (!RESUME && !STATUS) )) || fail '--adopt cannot be combined with --resume/--status.'
(( !RESUME || !STATUS )) || fail '--resume and --status are separate operations.'
[[ -z $ENV_SOURCE || ( $ADOPT == 0 && $RESUME == 0 && $STATUS == 0 ) ]] || fail '--env-file is only for first installation.'
for command in docker curl tar sha256sum openssl flock awk sed grep sort cmp mktemp realpath stat find sync wc uniq head date cp mv chmod rm mkdir xargs; do
  command -v "$command" >/dev/null || fail "Missing dependency: $command"
done
[[ ! -L $DIR ]] || fail 'Deployment directory must not be a symlink.'
DIR=$(realpath -m -- "$DIR")
[[ $DIR != / ]] || fail 'The filesystem root cannot be a deployment directory.'
if (( STATUS )); then
  [[ -d $DIR && -O $DIR && ! -L $DIR/.deploy && -f $DIR/.deploy/managed && -f $DIR/.deploy.lock && ! -L $DIR/.deploy.lock ]] || fail 'This directory is not a managed deployment.'
  [[ -z $(find "$DIR/.deploy" -type l -print -quit) ]] || fail 'Unsafe managed state.'
  exec 9<"$DIR/.deploy.lock"; flock -s -n 9 || fail 'Another deployment operation holds this directory lock.'
  log "Directory: $DIR"
  if [[ -f $DIR/.deploy/active ]]; then IFS= read -r active < "$DIR/.deploy/active"; log "Accepted version: $active"; else log 'Accepted version: none'; fi
  for field in target phase backup; do
    if [[ -f $DIR/.deploy/pending/$field ]]; then IFS= read -r value < "$DIR/.deploy/pending/$field"; log "Pending $field: $value"; fi
  done
  exit 0
fi
[[ -z $ENV_SOURCE ]] || ENV_SOURCE=$(realpath -e -- "$ENV_SOURCE")
[[ -z $BUNDLE_DIR ]] || BUNDLE_DIR=$(realpath -e -- "$BUNDLE_DIR")
mkdir -p -- "$DIR"
[[ -d $DIR && -O $DIR ]] || fail 'Deployment directory must be owned by the current user.'
[[ ! -L $DIR/.deploy.lock ]] || fail 'Unsafe lock path.'
exec 9>"$DIR/.deploy.lock"
flock -n 9 || fail 'Another deployment operation holds this directory lock.'
if [[ -d $DIR/.deploy ]]; then
  [[ ! -L $DIR/.deploy && -f $DIR/.deploy/managed && $(cat "$DIR/.deploy/managed") == 1 ]] || fail 'Unrecognized deployment state; refusing an unmanaged target.'
else
  if (( !ADOPT )); then
    [[ -z $(find "$DIR" -mindepth 1 -maxdepth 1 ! -name .deploy.lock -print -quit) ]] || fail 'Directory is not managed. Use --adopt only for an existing release deployment.'
  fi
  mkdir -m 700 -- "$DIR/.deploy"
  printf '1\n' > "$DIR/.deploy/managed"
  sync -f "$DIR/.deploy"
fi
[[ ! -L $DIR/.deploy && -f $DIR/.deploy/managed || ! -e $DIR/.deploy/managed ]] || fail 'Unsafe managed state.'
[[ ! -L $DIR/.env.release ]] || fail 'Private environment must not be a symlink.'
if [[ -n $(find "$DIR/.deploy" -type l -print -quit) ]]; then fail 'Managed state must not contain symlinks.'; fi
for path in releases backups; do
  [[ ! -L $DIR/$path ]] || fail "Unsafe $path directory."
  mkdir -p -- "$DIR/$path"
  chmod 700 -- "$DIR/$path"
done
chmod 700 -- "$DIR" "$DIR/.deploy"
printf '1\n' > "$DIR/.deploy/managed"
STATE=$DIR/.deploy
ENV_FILE=$DIR/.env.release
PENDING=$STATE/pending
ACTIVE=''
[[ ! -f $STATE/active ]] || IFS= read -r ACTIVE < "$STATE/active"
[[ -z $ACTIVE || $ACTIVE =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || fail 'Invalid accepted release state.'
atomic() { local path=$1 value=$2 temporary; temporary=$(mktemp "$STATE/write.XXXXXX"); printf '%s\n' "$value" > "$temporary"; chmod 600 "$temporary"; sync -f "$temporary"; mv -f -- "$temporary" "$path"; sync -f "$(dirname "$path")"; }
state_value() { local value=; [[ ! -f $1 ]] || IFS= read -r value < "$1"; printf '%s' "$value"; }
if [[ -d $PENDING && $RESUME == 0 ]]; then fail 'An operation is unfinished. Inspect --status, then use --resume for a forward retry or restore a matching backup manually.'; fi
if (( RESUME )) && [[ ! -d $PENDING ]]; then fail 'No pending operation to resume.'; fi
if [[ -e $ENV_FILE && -n $ENV_SOURCE ]]; then [[ -z $ACTIVE ]] && cmp "$ENV_FILE" "$ENV_SOURCE" >/dev/null || fail 'The saved environment already exists; --env-file cannot replace it.'; fi
docker info >/dev/null 2>&1 || fail 'Docker is not available to the current user.'
compose_version=$(docker compose version --short)
compose_version=${compose_version#v}
[[ $compose_version =~ ^([0-9]+)\.([0-9]+) ]] || fail 'Could not determine Docker Compose version.'
(( BASH_REMATCH[1] > 2 || (BASH_REMATCH[1] == 2 && BASH_REMATCH[2] >= 20) )) || fail 'Docker Compose >=2.20 is required.'
# Compose interpolation comes only from the saved private file. Keep Docker client
# context/credentials, but never inherit application variables from the caller.
CLEAN_ENV=(env)
while IFS='=' read -r key _; do
  case "$key" in DOCKER_*|PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|XDG_*|SSH_AUTH_SOCK|SSL_CERT_FILE|SSL_CERT_DIR|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy|LANG|LC_*) ;;
    *) [[ $key =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] && CLEAN_ENV+=(-u "$key");;
  esac
done < <(env)
compose() {
  local release=$1 environment=$2; shift 2
  "${CLEAN_ENV[@]}" docker compose --project-name "$PROJECT" --env-file "$environment" -f "$release/docker/docker-compose.release.yml" "$@"
}
# Parse only a fixed dotenv key as data; the file is never sourced or evaluated.
env_value() {
  local file=$1 key=$2 line
  [[ $(grep -c "^${key}=" "$file") == 1 ]] || fail "Expected one $key entry in the environment."
  line=$(grep "^${key}=" "$file"); line=${line#*=}
  if [[ $line == \"*\" || $line == \'*\' ]]; then line=${line:1:${#line}-2}; fi
  printf '%s' "$line"
}
validate_env_file() {
  [[ -f $1 && ! -L $1 ]] || fail 'Expected a regular private environment file.'
  [[ -z $(awk 'NF && $0 !~ /^[[:space:]]*#/ && $0 !~ /^[A-Za-z_][A-Za-z0-9_]*=/ {print NR; exit}' "$1") ]] || fail 'Use single-line KEY=value entries in the private environment.'
  [[ -z $(awk -F= '/^[A-Za-z_][A-Za-z0-9_]*=/ {if (seen[$1]++) {print $1;exit}}' "$1") ]] || fail 'Duplicate private environment key.'
}
put_images() {
  local input=$1 output=$2
  awk -v backend="$TARGET_BACKEND" -v frontend="$TARGET_FRONTEND" '
    /^BACKEND_IMAGE=/ {print "BACKEND_IMAGE=" backend; b=1; next}
    /^FRONTEND_IMAGE=/ {print "FRONTEND_IMAGE=" frontend; f=1; next}
    {print}
    END {if (!b) print "BACKEND_IMAGE=" backend; if (!f) print "FRONTEND_IMAGE=" frontend}
  ' "$input" > "$output"
  chmod 600 "$output"
}
# This JS runs inside an already-pulled application image; no host JS runtime.
read -r -d '' JSON_PROGRAM <<'JS' || true
const fs=require('fs'),assert=require('assert/strict'),crypto=require('crypto');
const [action,...args]=process.argv.slice(1);const input=JSON.parse(fs.readFileSync(0,'utf8'));
const digest=/^ghcr\.io\/amazingumi\/personalplatform-(backend|frontend)@sha256:[a-f0-9]{64}$/;
const canonical=o=>Array.isArray(o)?o.map(canonical):o&&typeof o==='object'?Object.fromEntries(Object.entries(o).sort().map(([k,v])=>[k,canonical(v)])):o;
const hash=o=>crypto.createHash('sha256').update(JSON.stringify(canonical(o))).digest('hex');
if(action==='release'){
 assert.equal(input.version,args[0]);assert.match(input.revision,/^[a-f0-9]{40}$/);assert.deepEqual([...input.platforms].sort(),['linux/amd64','linux/arm64']);
 for(const service of ['backend','frontend']){assert.match(input.images[service].reference,digest);assert.ok(input.images[service].reference.startsWith('ghcr.io/amazingumi/personalplatform-'+service+'@'));assert.equal(input.images[service].reference,args[service==='backend'?1:2]);}
}else if(action==='config'){
 assert.match(input.name,/^[a-z0-9][a-z0-9_-]*$/);assert.deepEqual(Object.keys(input.services).sort(),['backend','database','frontend']);
 for(const service of Object.values(input.services)){assert.ok(!service.build);for(const mount of service.volumes||[])assert.equal(mount.type,'volume');}
 const b=input.services.backend,d=input.services.database,f=input.services.frontend;
 assert.ok(!(b.ports||[]).length&&!(d.ports||[]).length);assert.equal(b.environment.PLATFORM_ENVIRONMENT,'production');
 assert.match(b.environment.BOOTSTRAP_ADMIN_USERNAME,/^[a-z0-9_-]{3,32}$/);const password=b.environment.BOOTSTRAP_ADMIN_PASSWORD.replaceAll('$$','$');assert.ok([...password].length>=8&&[...password].length<=256);assert.ok(b.environment.POSTGRES_PASSWORD.length>0);
 assert.equal(b.volumes.length,1);assert.equal(b.volumes[0].target,'/workspace/storage');assert.equal(d.volumes.length,1);assert.equal(d.volumes[0].target,'/var/lib/postgresql/data');
 const db=input.volumes[d.volumes[0].source].name,storage=input.volumes[b.volumes[0].source].name;
 assert.equal(db,input.name+'_postgres-data');assert.equal(storage,input.name+'_app-storage');
 assert.equal(f.ports.length,1);assert.equal(f.ports[0].target,8080);
 console.log([input.name,db,storage,hash(d)].join('\n'));
}else if(action==='container'){
 assert.equal(input.length,1);const c=input[0],[project,service,volume,destination,origin]=args;
 assert.equal(c.Config.Labels['com.docker.compose.project'],project);assert.equal(c.Config.Labels['com.docker.compose.service'],service);
 assert.equal(c.Config.Labels['com.docker.compose.project.config_files'],origin,'container belongs to another deployment directory');
 if(volume){const matches=c.Mounts.filter(m=>m.Destination===destination);assert.equal(matches.length,1);assert.equal(matches[0].Type,'volume');assert.equal(matches[0].Name,volume);}
 assert.ok(c.State.Running,'expected running '+service);assert.equal(c.State.Health?.Status,'healthy','expected healthy '+service);
 console.log(c.Id+'\n'+c.Image+'\n'+c.Config.Labels['com.docker.compose.project.config_files']);
}else if(action==='volume'){
 assert.equal(input.length,1);assert.equal(input[0].Labels['com.docker.compose.project'],args[0]);assert.equal(input[0].Labels['com.docker.compose.volume'],args[1]);
}else if(action==='owner'){
 assert.equal(input.length,1);const labels=input[0].Labels;assert.equal(labels['io.personalplatform.deploy.managed'],'1');assert.equal(labels['io.personalplatform.deploy.project'],args[0]);assert.equal(labels['io.personalplatform.deploy.owner'],args[1],'project is owned by another deployment');assert.equal(labels['io.personalplatform.deploy.directory'],args[2],'project is managed from another directory');
}else if(action==='fingerprint'){
 console.log(hash(input.map(v=>({Name:v.Name,CreatedAt:v.CreatedAt,Driver:v.Driver,Options:v.Options,Labels:v.Labels}))));
}else if(action==='owned'){
 const [project,db,storage,dbOrigin,appOrigin,targetOrigin]=args;
 for(const c of input){const service=c.Config.Labels['com.docker.compose.service'];assert.ok(['backend','frontend','database'].includes(service));assert.equal(c.Config.Labels['com.docker.compose.project'],project);const origin=c.Config.Labels['com.docker.compose.project.config_files'];assert.ok(service==='database'?origin===dbOrigin:[appOrigin,targetOrigin].includes(origin),'container belongs to another deployment directory');if(service!=='frontend'){const dest=service==='database'?'/var/lib/postgresql/data':'/workspace/storage';const mount=c.Mounts.find(m=>m.Destination===dest);assert.ok(mount&&mount.Type==='volume');assert.equal(mount.Name,service==='database'?db:storage);}}
}else if(action==='stopped'){
 for(const c of input)assert.equal(c.State.Running,false,'writer still running');
}else throw Error('Unknown parser action');
JS
json_action() { docker run --rm -i --network none --entrypoint node "$PARSER_IMAGE" -e "$JSON_PROGRAM" -- "$@"; }
validate_bundle() {
  local folder=$1 version=$2 manifest path
  [[ -z $(find "$folder" -type l -print -quit) ]] || fail 'Release must not contain links.'
  for path in .env.release.example release.json SHA256SUMS README.md docker/docker-compose.release.yml docker/docker-compose.runtime.yml; do
    [[ -f $folder/$path ]] || fail "Missing release file: $path"
  done
  # A checksum list is data, not a command or arbitrary filesystem read list.
  while IFS= read -r manifest; do
    [[ $manifest =~ ^[a-f0-9]{64}[[:space:]][[:space:]](.+)$ ]] || fail 'Invalid internal checksum list.'
    path=${BASH_REMATCH[1]}
    case "$path" in .env.release.example|release.json|README.md|docker/docker-compose.release.yml|docker/docker-compose.runtime.yml|deploy.sh|scripts/deploy.sh) ;;
      *) fail 'Unexpected internal checksum path.';; esac
  done < "$folder/SHA256SUMS"
  for path in .env.release.example release.json README.md docker/docker-compose.release.yml docker/docker-compose.runtime.yml; do
    [[ $(grep -Ec "^[a-f0-9]{64}  ${path//./\.}$" "$folder/SHA256SUMS") == 1 ]] || fail "Missing or duplicate checksum: $path"
  done
  for path in deploy.sh scripts/deploy.sh; do
    if [[ -f $folder/$path ]]; then [[ $(grep -Ec "^[a-f0-9]{64}  ${path//./\.}$" "$folder/SHA256SUMS") == 1 ]] || fail "Missing or duplicate checksum: $path"; fi
  done
  (cd "$folder" && sha256sum --strict -c SHA256SUMS >/dev/null) || fail 'Internal release checksum mismatch.'
  TARGET_BACKEND=$(env_value "$folder/.env.release.example" BACKEND_IMAGE)
  TARGET_FRONTEND=$(env_value "$folder/.env.release.example" FRONTEND_IMAGE)
  [[ $TARGET_BACKEND =~ ^ghcr\.io/amazingumi/personalplatform-backend@sha256:[a-f0-9]{64}$ && $TARGET_FRONTEND =~ ^ghcr\.io/amazingumi/personalplatform-frontend@sha256:[a-f0-9]{64}$ ]] || fail 'Release must pin both official application images by digest.'
}
acquire_bundle() {
  local version=$1 destination=$2 download archive entry kind root
  download=$(mktemp -d "$STATE/download.XXXXXX")
  archive="personalplatform-$version.tar.gz"; root="personalplatform-$version"
  if [[ -n $BUNDLE_DIR ]]; then
    [[ -f $BUNDLE_DIR/$archive && -f $BUNDLE_DIR/SHA256SUMS && ! -L $BUNDLE_DIR/$archive && ! -L $BUNDLE_DIR/SHA256SUMS ]] || fail 'Local bundle assets are missing or linked.'
    cp -- "$BUNDLE_DIR/$archive" "$BUNDLE_DIR/SHA256SUMS" "$download/"
  else
    for entry in "$archive" SHA256SUMS; do
      curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --retry 2 --connect-timeout 15 --max-time 300 "$REPOSITORY/releases/download/$version/$entry" -o "$download/$entry" || fail 'Release download failed; active services are unchanged.'
    done
  fi
  local checksum_line; checksum_line=$(cat "$download/SHA256SUMS")
  (( $(wc -l < "$download/SHA256SUMS") == 1 )) && [[ $checksum_line =~ ^[a-f0-9]{64}[[:space:]][[:space:]] && ${checksum_line:66} == "$archive" ]] || fail 'Unexpected external checksum list.'
  (cd "$download" && sha256sum --strict -c SHA256SUMS >/dev/null) || fail 'Release archive checksum mismatch.'
  # GNU tar quoting makes embedded control/newline names visible as backslash
  # escapes. Only an exact, small path/type allowlist can reach extraction.
  tar -tzf "$download/$archive" --quoting-style=escape > "$download/paths"
  tar -tvzf "$download/$archive" --quoting-style=escape > "$download/types"
  while IFS= read -r entry; do
    case "$entry" in "$root/"|"$root/docker/"|"$root/scripts/"|"$root/.env.release.example"|"$root/release.json"|"$root/SHA256SUMS"|"$root/README.md"|"$root/docker/docker-compose.release.yml"|"$root/docker/docker-compose.runtime.yml"|"$root/deploy.sh"|"$root/scripts/deploy.sh") ;;
      *) fail 'Unexpected, unsafe or ambiguous archive path.';; esac
  done < "$download/paths"
  (( $(sort "$download/paths" | uniq -d | wc -l) == 0 )) || fail 'Duplicate archive entry.'
  while IFS= read -r entry; do kind=${entry:0:1}; [[ $kind == d || $kind == - ]] || fail 'Archive contains a link or special file.'; done < "$download/types"
  mkdir -- "$download/unpacked"
  tar -xzf "$download/$archive" --no-same-owner --no-same-permissions -C "$download/unpacked"
  validate_bundle "$download/unpacked/$root" "$version"
  if [[ -e $destination ]]; then
    [[ ! -L $destination ]] || fail 'Unsafe saved release path.'
    cmp "$destination/SHA256SUMS" "$download/unpacked/$root/SHA256SUMS" >/dev/null || fail 'Published version content changed; refusing replacement.'
    validate_bundle "$destination" "$version"
  else mv -- "$download/unpacked/$root" "$destination"; fi
  rm -rf -- "$download"
}
# Leave recovery state intact. Only pre-migration failures can restart old code.
on_exit() {
  local status=$?
  trap - EXIT INT TERM
  if (( status != 0 )) && [[ -d ${PENDING:-/nonexistent} ]]; then
    local phase; phase=$(state_value "$PENDING/phase")
    if [[ $phase == attempted || $phase == failed ]]; then
      local stopped=0 ids
      if (( OWNERSHIP_VERIFIED )) && [[ $PROJECT == "$VERIFIED_PROJECT" && -n ${PROJECT:-} && -f $PENDING/target.env ]] && compose "$DIR/releases/$(state_value "$PENDING/target")" "$PENDING/target.env" stop frontend backend >/dev/null 2>&1; then
        if ids=$(compose "$DIR/releases/$(state_value "$PENDING/target")" "$PENDING/target.env" ps --all --quiet backend frontend); then
          if [[ -z $ids ]]; then stopped=1; else
            local -a writer_ids; mapfile -t writer_ids <<< "$ids"
            if docker inspect "${writer_ids[@]}" | json_action stopped >/dev/null 2>&1; then stopped=1; fi
          fi
        fi
      fi
      atomic "$PENDING/phase" failed
      if (( stopped )); then printf 'Update did not finish; application writers were stopped.\n' >&2; else printf 'Update did not finish; stopping writers could not be verified. Stop frontend/backend manually before recovery.\n' >&2; fi
      printf 'Data and recovery artifacts were retained. Backup: %s\nInspect --status; use --resume only for forward retry. Database migrations are not automatically reversed.\n' "$(state_value "$PENDING/backup")" >&2
    elif [[ $phase == staged ]]; then
      rm -rf -- "$PENDING"
    elif [[ $phase == preparing ]]; then
      if (( OWNERSHIP_VERIFIED )) && [[ $PROJECT == "$VERIFIED_PROJECT" && -n ${OLD_BACKEND:-} && -n ${OLD_FRONTEND:-} ]] && docker start "$OLD_BACKEND" "$OLD_FRONTEND" >/dev/null 2>&1; then
        rm -rf -- "$PENDING"
        printf 'Pre-start preparation failed; previous application containers were restarted. Incomplete backup retained: %s\n' "${BACKUP:-}" >&2
      fi
    fi
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if (( RESUME )); then
  pending_version=$(state_value "$PENDING/target")
  [[ -z $VERSION || $VERSION == "$pending_version" ]] || fail '--resume cannot change the pending target.'
  [[ $pending_version =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || fail 'Invalid pending target version.'
  pending_source=$(state_value "$PENDING/source")
  [[ -z $pending_source || $pending_source =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || fail 'Invalid pending source version.'
  [[ $ACTIVE == "$pending_source" || $ACTIVE == "$pending_version" ]] || fail 'Pending operation does not match the accepted source.'
  case "$(state_value "$PENDING/phase")" in staged|preparing|attempted|failed) ;; *) fail 'Invalid pending operation phase.';; esac
  [[ -f $PENDING/target.env && -f $PENDING/identity && -f $PENDING/target.env.sha256 ]] || fail 'Pending operation metadata is incomplete.'
  pending_env_hash=$(sha256sum "$PENDING/target.env"); pending_env_hash=${pending_env_hash%% *}
  [[ $pending_env_hash == "$(state_value "$PENDING/target.env.sha256")" ]] || fail 'Pending private environment changed; refusing to select another project or database.'
  if [[ $ACTIVE == "$pending_version" ]]; then
    case "$(state_value "$PENDING/phase")" in attempted|failed) ;; *) fail 'An already accepted target has an invalid pending phase.';; esac
    [[ -f $ENV_FILE && -f $STATE/identity ]] && cmp "$ENV_FILE" "$PENDING/target.env" >/dev/null && cmp "$STATE/identity" "$PENDING/identity" >/dev/null || fail 'Accepted target configuration does not match the unfinished commit.'
  fi
  VERSION=$pending_version
fi
if [[ -z $VERSION ]]; then
  release_url=$(curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 60 --output /dev/null --write-out '%{url_effective}' "$REPOSITORY/releases/latest") || fail 'Could not resolve the latest published release.'
  [[ $release_url == "$REPOSITORY/releases/tag/"* ]] || fail 'Unexpected latest-release redirect.'
  VERSION=${release_url##*/}
fi
[[ $VERSION =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || fail 'Latest release must be a stable vMAJOR.MINOR.PATCH version.'
if [[ -n $ACTIVE && $(printf '%s\n%s\n' "${ACTIVE#v}" "${VERSION#v}" | sort -V | head -1) != "${ACTIVE#v}" ]]; then fail 'Downgrades are refused; review schema compatibility and matching backup recovery manually.'; fi
STAGE=$DIR/releases/$VERSION
if (( !RESUME )); then acquire_bundle "$VERSION" "$STAGE"; else
  [[ -d $STAGE && ! -L $STAGE && -f $PENDING/target.env ]] || fail 'Pending release files are missing.'
  validate_bundle "$STAGE" "$VERSION"
fi
log "Pulling paired application images for $VERSION..."
docker pull "$TARGET_BACKEND" >/dev/null
docker pull "$TARGET_FRONTEND" >/dev/null
PARSER_IMAGE=$TARGET_BACKEND
json_action release "$VERSION" "$TARGET_BACKEND" "$TARGET_FRONTEND" < "$STAGE/release.json" >/dev/null
ensure_config() {
  local release=$1 environment=$2 output=$3
  PROJECT=$(env_value "$environment" COMPOSE_PROJECT_NAME)
  [[ $PROJECT =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail 'Explicit valid COMPOSE_PROJECT_NAME is required.'
  compose "$release" "$environment" config --format json | json_action config > "$output"
  mapfile -t IDENTITY < "$output"
  [[ ${#IDENTITY[@]} == 4 && ${IDENTITY[0]} == "$PROJECT" ]] || fail 'Invalid release configuration.'
  chmod 600 "$output"
}
current_ids() {
  local release=$1 environment=$2 mode=${3:-saved} service volume target output origin
  OLD_BACKEND='' OLD_FRONTEND=''
  for service in database backend frontend; do
    local id; id=$(compose "$release" "$environment" ps -q "$service")
    [[ -n $id && $id != *$'\n'* ]] || fail "Expected exactly one running $service container."
    volume='' target=''
    case "$service" in database) volume=${IDENTITY[1]}; target=/var/lib/postgresql/data;; backend) volume=${IDENTITY[2]}; target=/workspace/storage;; esac
    origin=$release/docker/docker-compose.release.yml
    if [[ $service == database && -f $STATE/database.origin ]]; then origin=$(state_value "$STATE/database.origin");
    elif [[ $service != database && $mode == saved && -f $STATE/app.origin ]]; then origin=$(state_value "$STATE/app.origin"); fi
    output=$(docker inspect "$id" | json_action container "$PROJECT" "$service" "$volume" "$target" "$origin")
    mapfile -t inspected <<< "$output"
    case "$service" in backend) OLD_BACKEND=${inspected[0]}; OLD_IMAGE=${inspected[1]};; frontend) OLD_FRONTEND=${inspected[0]}; OLD_FRONTEND_IMAGE=${inspected[1]};; database) DATABASE_ID=${inspected[0]}; DATABASE_IMAGE=${inspected[1]}; DATABASE_ORIGIN=${inspected[2]};; esac
  done
  docker volume inspect "${IDENTITY[1]}" | json_action volume "$PROJECT" postgres-data >/dev/null
  docker volume inspect "${IDENTITY[2]}" | json_action volume "$PROJECT" app-storage >/dev/null
  VOLUME_FINGERPRINT=$(docker volume inspect "${IDENTITY[1]}" "${IDENTITY[2]}" | json_action fingerprint)
  [[ ! -f $STATE/volumes.fingerprint || $(state_value "$STATE/volumes.fingerprint") == "$VOLUME_FINGERPRINT" ]] || fail 'A data volume was replaced; refusing an empty replacement deployment.'
  [[ ! -f $STATE/database.id || $(state_value "$STATE/database.id") == "$DATABASE_ID" ]] || fail 'The database container changed; review the database operation manually.'
}
verify_existing_ownership() {
  local ids db_origin app_origin
  ids=$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")
  if [[ -n $ids ]]; then
    db_origin=$(state_value "$STATE/database.origin"); db_origin=${db_origin:-$STAGE/docker/docker-compose.release.yml}
    app_origin=$(state_value "$STATE/app.origin"); app_origin=${app_origin:-$STAGE/docker/docker-compose.release.yml}
    # Container IDs are validated hex strings, never shell fragments.
    local -a existing_ids; mapfile -t existing_ids <<< "$ids"
    docker inspect "${existing_ids[@]}" | json_action owned "$PROJECT" "${IDENTITY[1]}" "${IDENTITY[2]}" "$db_origin" "$app_origin" "$STAGE/docker/docker-compose.release.yml" >/dev/null
  fi
  for pair in "${IDENTITY[1]}:postgres-data" "${IDENTITY[2]}:app-storage"; do
    local volume=${pair%:*} logical=${pair##*:}
    if docker volume ls --format '{{.Name}}' | grep -Fxq "$volume"; then docker volume inspect "$volume" | json_action volume "$PROJECT" "$logical" >/dev/null; fi
  done
  if [[ -f $STATE/volumes.fingerprint ]]; then
    [[ $(docker volume inspect "${IDENTITY[1]}" "${IDENTITY[2]}" | json_action fingerprint) == "$(state_value "$STATE/volumes.fingerprint")" ]] || fail 'A saved data volume is missing or was replaced.'
  fi
}
claim_project() {
  local owner directory_hash
  if [[ ! -f $STATE/owner ]]; then atomic "$STATE/owner" "$(openssl rand -hex 16)"; fi
  owner=$(state_value "$STATE/owner")
  [[ $owner =~ ^[a-f0-9]{32}$ ]] || fail 'Invalid saved deployment owner identity.'
  directory_hash=$(printf '%s' "$DIR" | sha256sum); directory_hash=${directory_hash%% *}
  # Docker creates a named volume atomically and never replaces an existing
  # volume's labels. Different directories/remote clients cannot claim twice.
  docker volume create --label io.personalplatform.deploy.managed=1 --label "io.personalplatform.deploy.project=$PROJECT" --label "io.personalplatform.deploy.owner=$owner" --label "io.personalplatform.deploy.directory=$directory_hash" "${PROJECT}_deploy-owner" >/dev/null
  docker volume inspect "${PROJECT}_deploy-owner" | json_action owner "$PROJECT" "$owner" "$directory_hash" >/dev/null
}
check_initial_collision() {
  [[ -z $(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT") ]] || fail 'Project already has containers. Use explicit --adopt for a supported existing deployment.'
  local existing_volumes volume
  existing_volumes=$(docker volume ls --format '{{.Name}}')
  for volume in "${IDENTITY[1]}" "${IDENTITY[2]}"; do
    if grep -Fxq "$volume" <<< "$existing_volumes"; then fail 'Project data volume already exists. Refusing to replace or silently adopt it.'; fi
  done
}
if (( ADOPT )); then
  [[ -z $ACTIVE && ! -d $PENDING ]] || fail 'Only an unmanaged manual deployment can be adopted.'
  [[ -f $ENV_FILE && -f $DIR/release.json ]] || fail '--adopt requires a manual release bundle with its real .env.release.'
  validate_env_file "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  # The metadata is parsed by the pinned backend, never as shell input.
  old_version=$(docker run --rm -i --network none --entrypoint node "$PARSER_IMAGE" -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));if(!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(r.version))process.exit(1);console.log(r.version)' < "$DIR/release.json")
  validate_bundle "$DIR" "$old_version"
  json_action release "$old_version" "$TARGET_BACKEND" "$TARGET_FRONTEND" < "$DIR/release.json" >/dev/null
  # validate_bundle changed the image-pair variables; restore target afterwards.
  ensure_config "$DIR" "$ENV_FILE" "$STATE/adopt.identity"
  current_ids "$DIR" "$ENV_FILE"
  claim_project; OWNERSHIP_VERIFIED=1; VERIFIED_PROJECT=$PROJECT
  if [[ ! -d $DIR/releases/$old_version ]]; then
    mkdir -- "$DIR/releases/$old_version"
    cp -- "$DIR/.env.release.example" "$DIR/release.json" "$DIR/SHA256SUMS" "$DIR/README.md" "$DIR/releases/$old_version/"
    cp -R -- "$DIR/docker" "$DIR/releases/$old_version/docker"
    if [[ -f $DIR/deploy.sh ]]; then cp -- "$DIR/deploy.sh" "$DIR/releases/$old_version/deploy.sh"; fi
    if [[ -f $DIR/scripts/deploy.sh ]]; then mkdir -- "$DIR/releases/$old_version/scripts"; cp -- "$DIR/scripts/deploy.sh" "$DIR/releases/$old_version/scripts/deploy.sh"; fi
  fi
  mv -- "$STATE/adopt.identity" "$STATE/identity"
  atomic "$STATE/database.origin" "$DATABASE_ORIGIN"; atomic "$STATE/app.origin" "$DIR/docker/docker-compose.release.yml"
  atomic "$STATE/database.id" "$DATABASE_ID"; atomic "$STATE/volumes.fingerprint" "$VOLUME_FINGERPRINT"
  atomic "$STATE/active" "$old_version"; ACTIVE=$old_version
  validate_bundle "$STAGE" "$VERSION"
fi
if [[ -n $ACTIVE && $(printf '%s\n%s\n' "${ACTIVE#v}" "${VERSION#v}" | sort -V | head -1) != "${ACTIVE#v}" ]]; then fail 'Downgrades are refused; review schema compatibility and matching backup recovery manually.'; fi
if [[ -n $ACTIVE ]]; then
  [[ -f $ENV_FILE && -f $STATE/identity ]] || fail 'Accepted environment/identity is missing.'
  validate_env_file "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ensure_config "$DIR/releases/$ACTIVE" "$ENV_FILE" "$STATE/current.identity"
  cmp "$STATE/identity" "$STATE/current.identity" >/dev/null || fail 'Saved project/database identity changed; refusing to attach replacement data.'
  if (( RESUME )) && [[ $(state_value "$PENDING/phase") == preparing ]]; then
    claim_project; verify_existing_ownership; OWNERSHIP_VERIFIED=1; VERIFIED_PROJECT=$PROJECT
    compose "$DIR/releases/$ACTIVE" "$ENV_FILE" up -d --no-recreate --no-deps --no-build --pull never --wait --wait-timeout 180 backend frontend
  fi
  if (( !RESUME )); then current_ids "$DIR/releases/$ACTIVE" "$ENV_FILE"; fi
  claim_project; verify_existing_ownership; OWNERSHIP_VERIFIED=1; VERIFIED_PROJECT=$PROJECT
fi
if [[ $ACTIVE == "$VERSION" && $RESUME == 0 ]]; then
  compose "$STAGE" "$ENV_FILE" exec -T backend wget -q -T 5 -O /dev/null http://127.0.0.1:8000/api/core/health/ready
  log "$VERSION is already active and healthy. Data and credentials were retained."
  cp -- "${BASH_SOURCE[0]}" "$STATE/deploy.new"; chmod 700 "$STATE/deploy.new"; mv -f -- "$STATE/deploy.new" "$DIR/deploy.sh"
  exit 0
fi
if (( !RESUME )); then
  if [[ -z $ACTIVE ]]; then
    if [[ -f $ENV_FILE ]]; then validate_env_file "$ENV_FILE"; elif [[ -n $ENV_SOURCE ]]; then validate_env_file "$ENV_SOURCE"; cp -- "$ENV_SOURCE" "$ENV_FILE"; else
      if ! { exec 8<>/dev/tty; } 2>/dev/null; then fail 'First install needs a terminal, or a complete private --env-file.'; fi
      printf 'Administrator username [admin]: ' >&8; IFS= read -r admin <&8; admin=${admin:-admin}
      [[ $admin =~ ^[a-z0-9_-]{3,32}$ ]] || fail 'Username must contain 3-32 lowercase letters, digits, underscores or hyphens.'
      printf 'Administrator password (8-256 characters): ' >&8; IFS= read -rs password <&8; printf '\nConfirm password: ' >&8; IFS= read -rs confirm <&8; printf '\n' >&8
      exec 8>&-
      [[ $password == "$confirm" && ${#password} -ge 8 && ${#password} -le 256 ]] || fail 'Passwords differ or length is outside 8-256 characters.'
      cp -- "$STAGE/.env.release.example" "$ENV_FILE"
      database_password=$(openssl rand -hex 32)
      # Double-quoted dotenv values escape backslashes, double quotes and dollars.
      escaped=${password//\\/\\\\}; escaped=${escaped//\"/\\\"}; escaped=${escaped//\$/\$\$}
      awk '!/^POSTGRES_PASSWORD=/ && !/^BOOTSTRAP_ADMIN_USERNAME=/ && !/^BOOTSTRAP_ADMIN_PASSWORD=/' "$ENV_FILE" > "$STATE/env.new"
      printf 'POSTGRES_PASSWORD=%s\nBOOTSTRAP_ADMIN_USERNAME=%s\nBOOTSTRAP_ADMIN_PASSWORD="%s"\n' "$database_password" "$admin" "$escaped" >> "$STATE/env.new"
      mv -- "$STATE/env.new" "$ENV_FILE"; unset password confirm escaped database_password
    fi
    chmod 600 "$ENV_FILE"
  fi
  pending_new=$(mktemp -d "$STATE/pending.new.XXXXXX")
  atomic "$pending_new/target" "$VERSION"; atomic "$pending_new/source" "$ACTIVE"; atomic "$pending_new/phase" staged; atomic "$pending_new/backup" ''
  put_images "$ENV_FILE" "$pending_new/target.env"
  ensure_config "$STAGE" "$pending_new/target.env" "$pending_new/identity"
  if [[ -n $ACTIVE ]]; then cmp "$STATE/identity" "$pending_new/identity" >/dev/null || fail 'Candidate changes database configuration or volume identity; perform that migration manually.'; fi
  target_env_hash=$(sha256sum "$pending_new/target.env"); target_env_hash=${target_env_hash%% *}
  atomic "$pending_new/target.env.sha256" "$target_env_hash"
  sync -f "$pending_new"
  mv -- "$pending_new" "$PENDING"
  sync -f "$STATE"
fi
ensure_config "$STAGE" "$PENDING/target.env" "$STATE/candidate.identity"
cmp "$PENDING/identity" "$STATE/candidate.identity" >/dev/null || fail 'Pending project/database identity changed; refusing to reinterpret the unfinished operation.'
if [[ -n $ACTIVE ]]; then
  cmp "$STATE/identity" "$PENDING/identity" >/dev/null || fail 'Candidate changes database configuration or volume identity; perform that migration manually.'
else
  if (( !RESUME )) || [[ $(state_value "$PENDING/phase") == staged ]]; then
    check_initial_collision
    claim_project
    check_initial_collision
    OWNERSHIP_VERIFIED=1; VERIFIED_PROJECT=$PROJECT
  fi
  if (( RESUME )) && [[ $(state_value "$PENDING/phase") != staged ]]; then claim_project; verify_existing_ownership; OWNERSHIP_VERIFIED=1; VERIFIED_PROJECT=$PROJECT; fi
  # Initial installation alone may pull/start the release database.
  compose "$STAGE" "$PENDING/target.env" pull database
fi
if [[ -n $ACTIVE && $(state_value "$PENDING/phase") != attempted && $(state_value "$PENDING/phase") != failed ]]; then
  current_ids "$DIR/releases/$ACTIVE" "$ENV_FILE"
  BACKUP=$(mktemp -d "$DIR/backups/$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")
  atomic "$PENDING/backup" "$BACKUP"; atomic "$PENDING/phase" preparing
  log "Stopping application writers and creating backup: $BACKUP"
  compose "$DIR/releases/$ACTIVE" "$ENV_FILE" stop frontend backend
  docker inspect "$OLD_BACKEND" "$OLD_FRONTEND" | json_action stopped >/dev/null
  # shellcheck disable=SC2016 # These variables must expand inside the database container.
  compose "$DIR/releases/$ACTIVE" "$ENV_FILE" exec -T database sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --no-privileges' > "$BACKUP/database.sql"
  [[ -s $BACKUP/database.sql ]] || fail 'Database backup is empty.'
  docker run --rm --network none --user root --entrypoint tar --mount "type=volume,source=${IDENTITY[2]},target=/data,readonly" "$OLD_IMAGE" -czf - -C /data . > "$BACKUP/storage.tar.gz"
  tar -tzf "$BACKUP/storage.tar.gz" >/dev/null
  docker cp "$OLD_BACKEND:/workspace/config" "$BACKUP/config"
  cp -- "$ENV_FILE" "$BACKUP/old.env"; cp -- "$STATE/identity" "$BACKUP/identity"
  cp -- "$DIR/releases/$ACTIVE/release.json" "$BACKUP/release.json"
  cp -R -- "$DIR/releases/$ACTIVE" "$BACKUP/release"
  printf '%s\n' "$OLD_BACKEND" "$OLD_FRONTEND" "$DATABASE_ID" "$OLD_IMAGE" "$OLD_FRONTEND_IMAGE" "$DATABASE_IMAGE" > "$BACKUP/images-and-containers"
  mkdir -m 700 "$BACKUP/deployment-state"
  for field in owner active identity database.id database.origin app.origin volumes.fingerprint; do
    [[ ! -f $STATE/$field ]] || cp -- "$STATE/$field" "$BACKUP/deployment-state/$field"
  done
  find "$BACKUP" -type d -exec chmod 700 {} +
  find "$BACKUP" -type f -exec chmod 600 {} +
  (cd "$BACKUP" && find . -type f ! -name SHA256SUMS ! -name complete -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS && sha256sum --strict -c SHA256SUMS >/dev/null)
  printf 'complete\n' > "$BACKUP/complete"
  sync -f "$BACKUP"
fi
if [[ -n $(state_value "$PENDING/source") && ( $(state_value "$PENDING/phase") == attempted || $(state_value "$PENDING/phase") == failed ) ]]; then
  BACKUP=$(state_value "$PENDING/backup")
  [[ $BACKUP == "$DIR/backups/"* && -f $BACKUP/complete ]] || fail 'Complete matching backup is required for a forward retry.'
  (cd "$BACKUP" && sha256sum --strict -c SHA256SUMS >/dev/null) || fail 'Retained backup checksum verification failed.'
fi
verify_existing_ownership
# Durable logical boundary: after this marker no old-code restart is safe.
atomic "$PENDING/phase" attempted
if [[ -z $ACTIVE ]]; then
  compose "$STAGE" "$PENDING/target.env" up -d --no-build --pull never --wait --wait-timeout 180
else
  compose "$STAGE" "$PENDING/target.env" up -d --force-recreate --no-deps --no-build --pull never --wait --wait-timeout 180 backend frontend
fi
compose "$STAGE" "$PENDING/target.env" exec -T backend wget -q -T 5 -O /dev/null http://127.0.0.1:8000/api/core/health/ready
current_ids "$STAGE" "$PENDING/target.env" target
cp -- "$PENDING/target.env" "$STATE/env.accepted"; chmod 600 "$STATE/env.accepted"; mv -f -- "$STATE/env.accepted" "$ENV_FILE"
cp -- "$PENDING/identity" "$STATE/identity.accepted"; mv -f -- "$STATE/identity.accepted" "$STATE/identity"
atomic "$STATE/database.origin" "$DATABASE_ORIGIN"; atomic "$STATE/app.origin" "$STAGE/docker/docker-compose.release.yml"
atomic "$STATE/database.id" "$DATABASE_ID"; atomic "$STATE/volumes.fingerprint" "$VOLUME_FINGERPRINT"
atomic "$STATE/active" "$VERSION"
rm -rf -- "$PENDING"
cp -- "${BASH_SOURCE[0]}" "$STATE/deploy.new"; chmod 700 "$STATE/deploy.new"; mv -f -- "$STATE/deploy.new" "$DIR/deploy.sh"
log "PersonalPlatform $VERSION is healthy. Directory: $DIR"
[[ -z $BACKUP ]] || log "Matching backup retained: $BACKUP"
frontend_address=$(compose "$STAGE" "$ENV_FILE" port frontend 8080)
log "Frontend mapping: $frontend_address. Configure your domain HTTPS proxy before production browser login."
