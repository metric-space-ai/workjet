#!/bin/bash
# Spielt die Bedienung am Simulator durch: Seiten scrollen, aufklappen,
# in der Langfassung blaettern, zuklappen. Ein Screenshot je Schritt;
# "UNVERAENDERT" heisst, die Geste hat nichts bewirkt.
set -u
API=http://127.0.0.1:9898
OUT=${1:-/tmp/flow}
mkdir -p "$OUT"; rm -f "$OUT"/*.png
shot() { curl -s -m 10 -o "$OUT/$1.png" "$API/api/screenshot/glasses"; }
send() { curl -s -m 5 -X POST -H 'content-type: application/json' -d "{\"action\":\"$1\"}" "$API/api/input" >/dev/null; sleep 1.2; }
shot 00_start
for i in 1 2 3; do send down; shot "0${i}_scroll$i"; done
send click;  shot 04_expand
for i in 1 2 3; do send down; shot "0$((4+i))_page$i"; done
send double_click; shot 08_collapse
prev=""
for f in "$OUT"/*.png; do
  h=$(md5 -q "$f" 2>/dev/null || md5sum "$f" | cut -d' ' -f1)
  [ "$h" = "$prev" ] && echo "$(basename "$f" .png): UNVERAENDERT" || echo "$(basename "$f" .png): neu"
  prev=$h
done
