#!/usr/bin/env bash
# Local end-to-end setup: a copy of the server's data in a local container (port 8199), the
# connected physical phone with an APK pointing at it, and an APK for the phone pointing at AWS.
# The phone reaches the local server through `adb reverse`; this script never starts an emulator.
# Nothing here writes to the server; secrets are read from it at run time, never stored in git.
#   scripts/e2e-local.sh <workdir>          set everything up
#   scripts/e2e-local.sh <workdir> server   just (re)start the local server on a fresh copy
set -euo pipefail
W=${1:?workdir}; MODE=${2:-all}
mkdir -p "$W/e2edata"
# your own deployment and toolchain (set in the environment, nothing personal lives in git):
#   UNIBOX_SSH_KEY, UNIBOX_SSH_HOST (user@host of the server), UNIBOX_PUBLIC_URL (https://…),
#   ANDROID_HOME, JAVA_HOME
KEY=${UNIBOX_SSH_KEY:?set UNIBOX_SSH_KEY}; HOST=${UNIBOX_SSH_HOST:?set UNIBOX_SSH_HOST}
PUBLIC_URL=${UNIBOX_PUBLIC_URL:?set UNIBOX_PUBLIC_URL}
ANDROID_HOME=${ANDROID_HOME:?set ANDROID_HOME}; JAVA_HOME=${JAVA_HOME:?set JAVA_HOME}; export ANDROID_HOME JAVA_HOME
ADB=$ANDROID_HOME/platform-tools/adb
cd "$(dirname "$0")/.."

ssh -i $KEY $HOST 'sudo cat /opt/unibox/.env' > "$W/server.env"
[ -f "$W/e2e.env" ] || { grep -E '^(LLM_MODEL|UNIBOX_LANG|UNIBOX_ME_NAME)=' "$W/server.env"; echo "UNIBOX_TOKEN=$(openssl rand -hex 24)"; echo "UNIBOX_HOST=0.0.0.0"; echo "UNIBOX_DATA_DIR=/data"; } > "$W/e2e.env"

# a consistent copy of the server's database
echo 'const s=require("node:sqlite");new s.DatabaseSync("/data/unibox.db").exec("VACUUM INTO '"'"'/tmp/c.db'"'"'")' > "$W/vac.js"
scp -q -i $KEY "$W/vac.js" $HOST:/tmp/vac.js
ssh -i $KEY $HOST 'cd /opt/unibox; C=$(docker compose ps -q unibox); docker cp /tmp/vac.js $C:/tmp/vac.js; docker exec $C sh -c "rm -f /tmp/c.db; node /tmp/vac.js"; docker cp $C:/tmp/c.db /tmp/c.db; docker exec $C rm -f /tmp/c.db /tmp/vac.js'
docker rm -f unibox-e2e >/dev/null 2>&1 || true; rm -f "$W/e2edata/unibox.db-"*
scp -q -i $KEY $HOST:/tmp/c.db "$W/e2edata/unibox.db"; ssh -i $KEY $HOST 'rm -f /tmp/c.db /tmp/vac.js'
node -e 'const s=require("node:sqlite");const d=new s.DatabaseSync(process.argv[1]);d.prepare("DELETE FROM meta WHERE key = ?").run("tasks_paused");d.exec("PRAGMA wal_checkpoint(TRUNCATE)");d.close()' "$W/e2edata/unibox.db"  # the tests need tasks on, whatever is paused for real
cp "$W/e2edata/unibox.db" "$W/base.db"; rm -f "$W/e2edata/unibox.db-"* "$W/vac.js"

docker build -q -t unibox:prod . >/dev/null
docker rm -f unibox-e2e >/dev/null 2>&1 || true
docker run -d --name unibox-e2e -p 8199:8124 --env-file "$W/e2e.env" -e TZ=Europe/Madrid \
  -e NAN_API_KEY="$(grep -E '^NAN_API_KEY=' "$W/server.env" | cut -d= -f2-)" -v "$W/e2edata":/data unibox:prod >/dev/null
[ "$MODE" = server ] && exit 0

# Use the real phone, never an emulator. Set UNIBOX_PHONE_SERIAL to override.
PHONE=${UNIBOX_PHONE_SERIAL:-}
if [ -z "$PHONE" ]; then
  PHONE=$($ADB devices | awk '$2 == "device" && $1 !~ /^emulator-/ { print $1; exit }')
fi
[ -n "$PHONE" ] || {
  echo "No physical Android device connected; refusing to start an emulator." >&2
  exit 1
}
case "$PHONE" in
  emulator-*) echo "Refusing to use an emulator ($PHONE); use the physical phone." >&2; exit 1 ;;
esac
echo "using phone: $PHONE"

# APKs: local server for the phone, and AWS for the phone
build() {
  printf '// Baked-in backend address for the Android app.\nwindow.UNIBOX_DEFAULT_SERVER = "%s";\nwindow.UNIBOX_DEFAULT_TOKEN = "%s";\n' "$1" "$2" > android-web/config.js
  npx cap sync android >/dev/null 2>&1
  (cd android && ./gradlew --offline -q assembleDebug 2>&1 | grep -iv deprecat || true)
  cp android/app/build/outputs/apk/debug/app-debug.apk "$3"
}
build "http://127.0.0.1:8199" "$(grep -E '^UNIBOX_TOKEN=' "$W/e2e.env" | cut -d= -f2-)" "$W/unibox-e2e.apk"
build "$PUBLIC_URL" "$(grep -E '^UNIBOX_TOKEN=' "$W/server.env" | cut -d= -f2-)" "$W/unibox-aws.apk"

# the phone reaches the local container through adb, so no LAN/firewall setup is needed
$ADB -s "$PHONE" reverse tcp:8199 tcp:8199 >/dev/null
$ADB -s "$PHONE" install -r "$W/unibox-e2e.apk" >/dev/null
$ADB -s "$PHONE" shell 'cmd role add-role-holder android.app.role.HOME app.unibox.launcher; pm grant app.unibox.launcher android.permission.WRITE_SECURE_SETTINGS; pm grant app.unibox.launcher android.permission.POST_NOTIFICATIONS; appops set app.unibox.launcher GET_USAGE_STATS allow; cmd notification allow_listener app.unibox.launcher/app.unibox.launcher.NotifListener; am set-debug-app --persistent com.android.chrome; echo "_ --disable-fre --no-default-browser-check --no-first-run" > /data/local/tmp/chrome-command-line; settings put secure enabled_accessibility_services ""; am force-stop app.unibox.launcher; settings put secure enabled_accessibility_services app.unibox.launcher/app.unibox.launcher.BlockerService; settings put secure accessibility_enabled 1; input keyevent KEYCODE_HOME'
echo "ready: server :8199, $PHONE, $W/unibox-aws.apk"
