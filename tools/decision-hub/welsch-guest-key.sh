#!/bin/bash
# Recreate the welsch guest SSH key from the fleet DB.
#
# The key is NOT stored anywhere durable on purpose — it is decrypted on demand
# from fleet_instances.vm_encrypted_private_key with the control plane's
# CTOX_ENCRYPTION_KEY. Earlier sessions kept it in /tmp and lost it to the OS
# temp sweep mid-task (2026-08-20).
#
# Usage: eval "$(tools/decision-hub/welsch-guest-key.sh)"   -> sets GUEST_SSH
set -euo pipefail
CTOX_DEV="${CTOX_DEV_DIR:-$HOME/Documents/ctox-dev}"
OUT="${1:-${TMPDIR:-/tmp}/welsch-guest.key}"
cd "$CTOX_DEV"
set -a; . ./.env.local; set +a
node -e '
const { neon } = require("@neondatabase/serverless");
const crypto = require("crypto"), fs = require("fs");
const sql = neon(process.env.DATABASE_URL);
function encryptionKey() {
  const c = process.env.CTOX_ENCRYPTION_KEY || process.env.CTOX_COOKIE_SECRET;
  if (/^[A-Za-z0-9+/=]{43,}$/.test(c)) { const d = Buffer.from(c, "base64"); if (d.length >= 32) return d.subarray(0, 32); }
  return crypto.createHash("sha256").update(c).digest();
}
function decryptSecret(payload) {
  const [ivRaw, tagRaw, bodyRaw] = payload.split(".");
  const d = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivRaw, "base64url"), { authTagLength: 16 });
  d.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([d.update(Buffer.from(bodyRaw, "base64url")), d.final()]).toString("utf8");
}
(async () => {
  const rows = await sql`select fi.vm_encrypted_private_key, fi.ssh_port, s.public_ip, s.ssh_host, fi.ssh_username
    from fleet_instances fi
    join tenants t on t.id = fi.tenant_id
    join fleet_servers s on s.id = fi.server_id
    where t.domain = ${process.env.TENANT_DOMAIN || "welsch.ctox.dev"}`;
  if (!rows.length) throw new Error("no fleet instance for tenant");
  const r = rows[0];
  const key = decryptSecret(r.vm_encrypted_private_key);
  fs.writeFileSync(process.env.KEY_OUT, key.endsWith("\n") ? key : key + "\n", { mode: 0o600 });
  process.stdout.write(`GUEST_SSH="ssh -i ${process.env.KEY_OUT} -o StrictHostKeyChecking=no -p ${r.ssh_port} ${r.ssh_username}@${r.public_ip || r.ssh_host}"\nexport GUEST_SSH\n`);
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
' KEY_OUT="$OUT"
