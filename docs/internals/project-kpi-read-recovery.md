# Recovering KPI configuration

Opening a native project's settings requests its KPI prompts again. A failed startup
read no longer leaves the inputs permanently unavailable. Pending reads show a small
status; failed reads offer Retry. Project metadata can still be edited independently.

A first delayed KPI receipt initializes the empty prompt draft without changing any
repository, website, project information or meeting edits. Subsequent refreshes do not
overwrite a prompt the user is editing. Saving retains the captured native revision
and uses the existing conflict check.

Gallery startup reads are serialized and published as each project completes.
Late startup receipts cannot replace a more recent configured KPI revision.
Responses from a closed dialog or a previous instance cannot update its read status.

Desktop and web use this shared gallery/editor. The mobile host consumes the web UI;
no provider, account, native policy or data transport changes are introduced.
