#!/bin/bash
set -euo pipefail
: "${TMPDIR:?Run through the Mac admission gate}"
case "$TMPDIR" in /Volumes/tmp/*|/Volumes/OneTB/*) ;; *) echo "Gate artifact TMPDIR required" >&2; exit 64 ;; esac
task_speech_build="$TMPDIR/speech-build"
swift test --package-path native/speech-helper --scratch-path "$task_speech_build" \
  --cache-path "$TMPDIR/speech-package-cache" --config-path "$TMPDIR/speech-package-config" \
  --security-path "$TMPDIR/speech-package-security" --jobs 2 \
  -Xswiftc -module-cache-path -Xswiftc "$TMPDIR/speech-module-cache"
"$task_speech_build/debug/workjet-speech-helper" --version
/usr/bin/python3 native/speech-helper/smoke.py "$task_speech_build/debug/workjet-speech-helper"
if [ "${1:-}" = "--probe" ]; then
  /usr/bin/python3 native/speech-helper/probe.py \
    --binary "$task_speech_build/debug/workjet-speech-helper" \
    --output "$TMPDIR/speech-helper-probe.json"
fi
