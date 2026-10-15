# Native pairing reference in computer assignment

The normal computer control request can carry `deviceBindingId` only for
`computer.assign`. It is an optional, bounded public reference to a device
already paired by the genuine native Owner enrollment path. It is not a
credential, an Owner claim or a substitute for enrollment.

Workjet preserves this reference through the selected Business OS guest.
The CTOX Shell maps it to `device_binding_id` on the existing
`ctox.workjet.computer.assign` RxDB/WebRTC command. The receiving native Owner
policy validates the current pairing and association. The Shell confirms a
binding only from the correlated successful native command receipt for the
same Owner, computer, assigned status and binding; a cached projection is
insufficient. Assignments without this optional field remain compatible.

Normal first setup still needs the actual managed native executable, its
original native root, a real Owner one-time invite and an independently trusted
source public identity. The native `ctox transfer pair` result supplies the
device proof reference; then Owner computer assignment establishes association.
Do not infer it from a UI row, SSH connection, workspace, browser guest or
another tenant. The selected Source startup subsequently verifies the current
native identity and association; the assignment reply is not execution
authority.

See the native
[Source transport contract](https://github.com/metric-space-ai/ctox/blob/358cfcffc8c4d09c2b8ddbe7e83e64a50883397c/docs/native-supervisor-source-transport.md).
Compatible native payload delivery, actual first enrollment and installed
G4/A0 acceptance are separate prerequisites; these contract and guest tests
do not claim them.
