"""Prepare normal gateway configuration in a fresh, explicitly named test profile."""
import argparse
import json
import os
from pathlib import Path
import time
from urllib.parse import urlsplit

parser = argparse.ArgumentParser()
parser.add_argument('--profile', required=True)
parser.add_argument('--state-dir', required=True, help='Actual ServerConfig.stateDir inside that isolated profile')
parser.add_argument('--provider-receipt', required=True)
parser.add_argument('--owner', required=True)
args = parser.parse_args()
allowed = Path('/Volumes/tmp/dev-artifacts/workjet')
profile = Path(args.profile)
state = Path(args.state_dir)
receipt_path = Path(args.provider_receipt)
for path in (profile, state, receipt_path):
    if not path.is_absolute() or path.resolve() != path or not path.is_relative_to(allowed):
        raise SystemExit('Only unsymlinked absolute Workjet task paths on the tmp volume are accepted')
if not Path('/Volumes/tmp').is_mount() or not state.is_relative_to(profile) or state == profile:
    raise SystemExit('State directory must be inside the caller-owned isolated profile')
if state.exists():
    raise SystemExit('State already exists; fixture preparation is allowed only before first app launch')
receipt = json.loads(receipt_path.read_text())
if (receipt.get('schema') != 'workjet.models.local-provider-fixture.v1'
        or receipt.get('owner') != args.owner or receipt.get('terminal') is not False
        or receipt.get('deadline_unix', 0) <= time.time()
        or receipt_path.parent != Path(receipt.get('output', ''))):
    raise SystemExit('A live, caller-owned local-provider receipt is required')
endpoint = receipt.get('endpoint', '')
url = urlsplit(endpoint)
if (url.scheme != 'http' or url.hostname != '127.0.0.1' or url.port is None
        or url.path != '/v1' or url.username or url.password or url.query or url.fragment):
    raise SystemExit('The fixture must have an exact loopback API endpoint')
try:
    os.kill(receipt['pid'], 0)
except (KeyError, OSError, TypeError):
    raise SystemExit('The recorded local-provider process is not alive')

scope = 'workjet-provider-gateway'
accounts = []
secrets = []
for name, provider, label, key in [
    ('primary', 'zai', 'Fixture Primary', 'fixture-primary-not-a-real-key-p001'),
    ('secondary', 'zai', 'Fixture Secondary', 'fixture-secondary-not-a-real-key-s002'),
    ('other', 'kimi', 'Fixture Other', 'fixture-other-not-a-real-key-o003'),
]:
    secret_name = 'fixture-' + name + '.api-key'
    accounts.append(dict(id='fixture-' + name, label=label, provider=provider, enabled=True,
                         priority=0, weight=1, models=['gpt-6.1-sol', 'fixture-model-before', 'fixture-shared-model'],
                         apiKeySecret=dict(scope=scope, name=secret_name),
                         upstreamBaseUrl=endpoint, credentialSuffix=key[-4:]))
    secrets.append((scope + '.' + secret_name + '.bin', key))
config = dict(schemaVersion=1, defaultProvider='zai', accounts=accounts,
              pools=[], routes=[], routingStrategy='fill-first')
state.mkdir(parents=True, mode=0o700, exist_ok=False)
os.chmod(state, 0o700)
secret_root = state / 'secrets'
secret_root.mkdir(mode=0o700)

def write_private(path, data):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())

for filename, key in secrets:
    write_private(secret_root / filename, key.encode())
config_path = state / 'provider-gateway.json'
write_private(config_path, (json.dumps(config, indent=2) + '\n').encode())
prepared = dict(schema='workjet.models.fixture-preparation.v1', owner=args.owner,
                profile=str(profile), state_dir=str(state), config=str(config_path),
                secret_root=str(secret_root), endpoint=endpoint,
                provider_receipt=str(receipt_path), created_unix=time.time(),
                account_ids=[account['id'] for account in accounts],
                limits='Unknown: fixture supplies no quota or balance measurements',
                native_authority='Not established; normal app startup must identify the isolated authority',
                acceptance='Prepared only: no app actions, persistence, reply or installed acceptance verified')
write_private(state / 'fixture-preparation.receipt.json', (json.dumps(prepared, indent=2) + '\n').encode())
print('MODEL_FIXTURE_PREPARED ' + json.dumps({key:prepared[key] for key in ('owner', 'state_dir', 'endpoint', 'account_ids')}))
