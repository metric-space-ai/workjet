#!/bin/bash
# Prove the Decision Hub chain on a managed tenant, end to end:
#   inbound mail -> Vorgang -> Entscheidung -> approval thread for the owner
#
# Also purges its own test artefacts first, so a production instance never
# accumulates example.org noise.
#
# Usage: GUEST_SSH="ssh -i key -p 22017 ctox@host" tools/decision-hub/verify-chain.sh
#
# Patience matters: the business-record projection runs in 25-doc slices and
# sleeps up to BUSINESS_OS_STANDBY_RECONCILE_INTERVAL_SECS (30 min) once idle.
# The service restart below wakes it deterministically instead of waiting.
set -euo pipefail
: "${GUEST_SSH:?set GUEST_SSH (see welsch-guest-key.sh)}"
OWNER="${OWNER_USER_ID:-michael.welsch@metric-space.ai}"
$GUEST_SSH bash -s "$(date +%s)" "$OWNER" <<'GUEST'
set -u
STAMP="$1"; OWNER="$2"
export PATH="$HOME/.local/bin:$HOME/.local/lib/ctox/current/bin:$PATH"
export XDG_RUNTIME_DIR=/run/user/$(id -u)
D=~/.local/state/ctox/business-os.sqlite3
C=~/.local/state/ctox/ctox.sqlite3
ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
KEY="dh-verify-$STAMP"

echo "== purge earlier verification artefacts"
sqlite3 "$D" "delete from business_records where collection in ('kundenpipeline_vorgaenge','kundenpipeline_entscheidungen','user_threads','user_thread_links','user_thread_messages','user_thread_states') and payload_json like '%example.org%';"
sqlite3 "$C" "delete from communication_messages where sender_address like '%@example.org';"
rm -f ~/.local/state/ctox/business-record-projection-progress.json

echo "== inject one inbound mail (example.org only — never a real address)"
sqlite3 "$C" "INSERT OR REPLACE INTO communication_messages
 (message_key, channel, account_key, thread_key, remote_id, direction, folder_hint,
  sender_display, sender_address, recipient_addresses_json, cc_addresses_json,
  bcc_addresses_json, subject, preview, body_text, body_html, raw_payload_ref,
  trust_level, status, seen, has_attachments, external_created_at, observed_at, metadata_json)
 VALUES ('$KEY','email','dh-verify','thr-$KEY','remote-$KEY','inbound','INBOX',
  'Beispielkunde','kunde@example.org','[\"owner@example.org\"]','[]','[]',
  'Angebot fuer Wartungsvertrag','Bitte um Angebot',
  'Wir moechten ein Angebot fuer einen Wartungsvertrag ueber 12 Monate.','','',
  'untrusted','received',0,0,'$ISO','$ISO','{}');"

echo "== restart so the projection loop starts awake"
systemctl --user restart ctox.service; sleep 20; systemctl --user is-active ctox.service

echo "== wait for Vorgang -> Entscheidung -> Thread"
VOR=""; DEC=""; THR=""
for i in $(seq 1 60); do
  sleep 15
  [ -z "$VOR" ] && VOR=$(sqlite3 "$D" "select record_id from business_records where collection='kundenpipeline_vorgaenge' and payload_json like '%$KEY%' limit 1")
  [ -n "$VOR" ] && [ -z "$DEC" ] && DEC=$(sqlite3 "$D" "select record_id from business_records where collection='kundenpipeline_entscheidungen' and payload_json like '%$VOR%' limit 1")
  [ -n "$DEC" ] && THR=$(sqlite3 "$D" "select record_id from business_records where collection='user_threads' and payload_json like '%$DEC%' limit 1")
  [ -n "$THR" ] && break
done
echo "vorgang=$VOR"; echo "decision=$DEC"; echo "thread=$THR"
[ -z "$THR" ] && { echo "FAIL: no thread projected"; exit 1; }
ASSIGNEE=$(sqlite3 "$D" "select json_extract(payload_json,'\$.assigned_user_id') from business_records where collection='user_threads' and record_id='$THR'")
STATUS=$(sqlite3 "$D" "select json_extract(payload_json,'\$.status') from business_records where collection='user_threads' and record_id='$THR'")
echo "assignee=$ASSIGNEE status=$STATUS"
[ "$ASSIGNEE" = "$OWNER" ] || { echo "FAIL: thread assigned to $ASSIGNEE, expected $OWNER"; exit 1; }
[ "$STATUS" = "open" ] || { echo "FAIL: thread status $STATUS, expected open"; exit 1; }
echo "PASS: decision reaches the owner's inbox"
GUEST
