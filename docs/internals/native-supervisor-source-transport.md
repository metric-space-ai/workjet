# Native Supervisor Source transport ownership

The managed Workjet service can acquire the original enrolled native Source
with `acquireNativeSupervisorSourceTransport`. Its scope must belong to Root /
NodeService and survive every UI disconnect and Electron Quit.

The input is an internal retained enrollment reference: actual native executable,
encrypted native target ID, original native root and a dedicated private IPC
directory. Workjet computer IDs, guest sessions, managed instance IDs and labels
are not substitutes. No public client setting or automatic account selection is
introduced. Missing original enrollment mapping remains an explicit setup gap.

For a retained exact target, the command is
`ctox sync supervisor-source TARGET IPC_DIRECTORY --root ROOT`. When native
supports the protected existing-account selector (CTOX #566), the service uses
`ctox sync supervisor-source-selected INSTANCE COMPUTER IPC_DIRECTORY --root ROOT`
and checks the emitted native instance and computer association in that same
owned process. No separate lookup generation, new pairing or account guess is
used. The emitted original Source facts remain observations, not execution
permission; epoch/generation fields are opaque and never reconstructed as
native authority. The managed native executable/root locator is still required.
The client consumes the actual emitted endpoint and checks private directory /
socket rights and current UID. One bounded Unix socket serializes requests using
the merged CTOX #560 four-byte big-endian framing, 256 KiB requests and 1 MiB
responses. Strict envelopes preserve request IDs and opaque native replies.
No business data uses HTTP, and no credential is transferred in the envelope.

The caller retains offer/controller/operation identities. After a dispatched
request, EOF, timeout, malformed correlation or native unavailability reports
an unknown outcome. The transport never retries, reconnects, rebases an offer,
or manufactures cancellation evidence. The caller must resolve original native
state before proceeding. Invalid or oversized local input is rejected before
dispatch; no request is truncated.

Resource release closes the socket, requests SIGTERM only on its captured owned
native child and awaits its actual exit. Failure to drain is explicit. This is
a transport-process receipt, not evidence that a Claude SDK or a native task
stopped.

Focused regressions launch an explicitly labeled isolated IPC fixture, exercise
fragmented frames, concurrent serialization, original argv, size/correlation
failure and actual child drain. They do not attest enrollment, a real SDK,
a live model or installed B6.

This additive boundary does not activate the selected Supervisor SDK producer.
Original enrollment mapping, the genuine Claude SDK holder, private model
exchange and native SDK lifecycle journal composition remain separate work.
The default instance Supervisor execution path is unchanged.
