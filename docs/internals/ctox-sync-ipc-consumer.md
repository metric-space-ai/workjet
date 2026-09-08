# Native CTOX Sync IPC consumer

The server-side requestSyncAuthority client talks only to the local native host's
Unix socket or Windows named pipe. It imports the shared generated execution
contract through @t3tools/contracts/ctoxSync. The native authority remains the
owner of membership, job ownership and effect replay decisions.

The client validates request and response schemas, enforces the frame and time
budgets, checks request IDs and protocol versions, and closes the socket on
completion, cancellation or host loss. It never retries an unknown outcome or
translates a failed resume into a new execution.

This change makes the client available to the existing CTOX native integration
tests. It does not yet wire Desktop/Mobile onboarding or production executors
to the native host, and does not retire the existing mailbox.

Validation:
- Focused socket tests cover fragmented replies, membership receipts, invalid
  frames/protocol IDs, cancellation and rejection of network endpoints.
- CTOX's authority_cluster and webrtc_authority tests load this actual TypeScript
  client and exercise quorum loss, replay and host shutdown. Results must be
  recorded for the pinned consumer commit; presence of these tests is not a pass.
- Generated files already exist on main with the same fixture hash as CTOX.
  Strict byte comparison currently reports formatting drift; generated files
  were not edited by this consumer change.
