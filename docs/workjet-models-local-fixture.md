# Isolated Models provider fixture

This is test preparation for the normal Workjet server and native gateway. It
uses three clearly synthetic API keys, two Z.ai accounts and one Kimi account,
all configured with an explicit loopback upstream. It writes the ordinary
`provider-gateway.json` and reference-only private secret files before the first
app launch. It creates no database, authority ID, grants, replies or usage history.

The common desktop writer owns the packaged app, fresh profile, normal native
startup, visible selection of the actual instance/provider/model, recording and
shutdown. The provider fixture does not establish that authority or prove a
working composer. An actual streamed arithmetic response is generated only when
the normal native client sends an inference request to the fixture.

1. Under the existing admitted app acceptance unit, start the provider as an owned
   process group. Substitute the actual task owner and a new task output directory:

   ```sh
   /usr/bin/python3 scripts/workjet-models-fixture-provider.py \
     --owner ACTUAL_THREAD_ID \
     --output /Volumes/tmp/dev-artifacts/workjet/ACTUAL_TASK/provider \
     --seconds 900
   ```

   Its private `receipt.json` names the PID, endpoint and deadline. Keep the
   supervisor handle and terminate only that owned group at the unit's end. The
   server accepts at most 200 inference attempts and exits by SIGTERM or its 900s
   wall deadline. It stores sanitized request receipts, never request prompts,
   authorization headers or raw session/cache identities.

2. Before launching that fresh app profile, derive the actual `ServerConfig.stateDir`
   from the common writer's launch configuration and pass it explicitly:

   ```sh
   /usr/bin/python3 scripts/prepare-workjet-models-fixture.py \
     --owner ACTUAL_THREAD_ID \
     --profile /Volumes/tmp/dev-artifacts/workjet/ACTUAL_TASK/profile \
     --state-dir /Volumes/tmp/dev-artifacts/workjet/ACTUAL_TASK/profile/state/userdata \
     --provider-receipt /Volumes/tmp/dev-artifacts/workjet/ACTUAL_TASK/provider/receipt.json
   ```

   The example state directory applies when the launch's explicit `WORKJET_HOME`
   is `profile/state` and the normal server derives its `userdata` directory there.
   Confirm the actual launch binding. Preparation refuses existing state or a
   stopped, expired, differently owned or non-loopback fixture. Keys and config
   use 0600, directories 0700. It refuses repeated preparation and never repairs
   state after a UI failure.

3. Launch the source-bound common app once, identify its real isolated authority,
   and visibly open Settings → Models. Bind stories to the actual app/profile and
   instance, with `Fixture Primary`, `Fixture Secondary` and `Fixture Other`
   labels. For a Models selection chapter, select `fixture-shared-model` through
   the normal worker controls before inference. New project-team creation instead
   retains the production resolver's required `gpt-6.1-sol` default. The fixture
   advertises that ID as a clearly recorded local transport alias so the normal
   creation path can run without changing its model guard or a persisted team.
   It does not execute GPT or prove real-provider availability. Request
   `What is 297 + 306?` and check the real streamed reply 603,
   requested-model receipt, reload and normal Quit/reopen persistence. This is fixture transport
   acceptance, not evidence of real-provider availability or token consumption.

For a separate error chapter, choose `--primary-status 401`, `402`, `403`,
`404`, `429`, `500` or `503` before launching a new fixture and profile. The
original Primary key returns that real HTTP status; Secondary and Other remain
healthy. A synthetic replacement key
`fixture-primary-replacement-not-a-real-key-r004` maps to Primary and succeeds,
so the visible existing-account key replacement can be tested without changing
the fixture after launch. Never add this replacement as a new account or use
any of these synthetic keys against a real vendor. Error receipts contain
status/account/model/attempt only, and successful completions have a separate
number. A429 supplies a60-second Retry-After; this is a local retry signal,
not a measured provider percentage, subscription reset or cache report. These
modes are prepared fixtures, not proof that the packaged UI chapters have run.
They do not provide OAuth login, quota endpoints or configuration-write faults.

Limits and balance are deliberately unknown. The fixture supplies no measured
token counts or cache counters, so those remain absent. Do not inject older usage
history or claim reset/cache behavior from this server; native policy tests and
separate genuinely measured provider workflows cover those requirements.

New accounts added through the current UI still use their provider's normal
upstream. The fixture does not intercept or silently inherit that destination.
For an add/remove UI chapter, use only a clearly synthetic Z.ai key in a fresh
profile with no concurrent inference, remove it visibly before any composer
request, and verify that no upstream request occurred. Z.ai has no configured
quota probe. Do not infer against that newly added account, use a real key, or
rewrite its endpoint after launch to make a failed story pass.

Run the Python fixture smoke and the `ProviderGatewayConfig` loopback-boundary
regression before composed app acceptance. A successful preparation/smoke alone
is not installed UI acceptance. Keep source, receipts, video and independent
review under the existing PR and owner evidence records.
