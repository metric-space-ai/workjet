/** Reuse an operational daemon when adding a computer; repair remains explicit. */
export function reuseHealthyCtox(installScript: string): string {
  return `ctox_bin="$(command -v ctox || true)"
if [ -z "$ctox_bin" ] && [ -x "$HOME/.local/bin/ctox" ]; then ctox_bin="$HOME/.local/bin/ctox"; fi
ctox_ready=false
if [ -n "$ctox_bin" ]; then
  if "$ctox_bin" status > "$tmp/ctox-status.json" 2>/dev/null && python3 - "$tmp/ctox-status.json" <<'WORKJET_STATUS'
import json,sys
try:
    status=json.load(open(sys.argv[1],encoding='utf-8'))
    sys.exit(0 if status.get('running') is True else 1)
except (ValueError,OSError,AttributeError):
    sys.exit(1)
WORKJET_STATUS
  then ctox_ready=true; fi
fi
if [ "$ctox_ready" = true ]; then
  printf '{"phase":"health","status":"completed","percent":78,"message":"Existing CTOX service verified; reusing this installation"}\\n'
else
${installScript}
fi`;
}
