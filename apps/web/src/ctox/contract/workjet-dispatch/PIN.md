# Workjet worker dispatch handler pin

Byte-identical copy of the Shell v4 instance-module handler `workjet.worker.dispatch` (E54.3b) from
https://github.com/metric-space-ai/ctox/pull/924, branch `shell-v4/workjet-dispatch`, commit
`c2d40c42d306d4c66a7206d2568953d622e2cc22`, directory
`src/apps/business-os/modules/workjet/handlers/` (AGPL-3.0-only, see `../../kernel/LICENSE`).
Test-only: `workerDispatchHandler.fixture.ts` joins the files into one fake-core handler module.
To update, copy the files unchanged from the new commit and replace the commit and hashes here;
`kernelProvenance.test.ts` checks every hash.

| File                       | Source                     | SHA-256                                                          |
| -------------------------- | -------------------------- | ---------------------------------------------------------------- |
| dispatch.js                | \_lib/dispatch.js          | 1fd912bdc8716c41f877d11feebff40f0849a0cdc13ca71c0a9fc0430ff5f42d |
| sha256.js                  | \_lib/sha256.js            | 9d4ce8a6b54db463483dacb41bc782e242f7608fb2df2100b0aec5144926ba26 |
| outcome-contract.js        | \_lib/outcome-contract.js  | 88089d05b3a507a7fa86af2df1413dad4cce1b4afbe4c03688c9171b01acc73f |
| workjet.worker.dispatch.js | workjet.worker.dispatch.js | 4d9e2d41dae4482298f6c430faaa6bd5d44703a5bf67a72845d66662c26001ca |
