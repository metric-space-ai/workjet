# Jour fixe owner bridge

Workjet forwards four owner controls through the selected CTOX guest's existing
project-control channel: meeting start/end, owner text append and proposed-to-do
revision. The wire contract follows `ctox.workjet.jour_fixe.v1` from CTOX #409.
There is no HTTP data fallback or new authorization path.

The desktop rejects receipts for another project, meeting, operation, command,
revision or transition. Text receipts must name the submitted turn; proposal
receipts must acknowledge the exact proposal revision. Owner text cannot assert
supervisor identity, audio or speech provenance. Native policy and transactions
remain authoritative.

A caller must retain the operation ID and its complete intent until the receipt
is confirmed. After an uncertain delivery, read the meeting again and retry the
same operation and intent; do not allocate a fresh operation for the same edit.

This bridge does not itself render a live meeting or establish installed
acceptance. The room still needs authorized meeting reads, native snapshot
mapping and callbacks. Comment delivery, supervisor deck/proposal production,
speech and confirmed to-dos becoming supervisor goals remain separate native
integrations. Unsupported native handlers must remain visible failures.
