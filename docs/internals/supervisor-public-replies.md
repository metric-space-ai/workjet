# Supervisor public replies

Workjet requests real assistant text with `executionPage.include_public_text: true`
through its existing authorized project-control port. This mirrors the shared
CTOX `ctox.workjet.supervisor_execution.v1` fixture, including the public text
extension in CTOX #507. The matching native binary and signed Shell slot must be
installed; this client does not implement another producer, data transport or
model route.

The selected project, instance, admitted command and actual attempt remain
correlated by the existing receipt decoder. Public text has exact native turn
and item identities, Unicode character offsets and completion/truncation flags.
Only contiguous chunks render. Duplicate ledger IDs do not append twice;
conflicts or missing offsets retain the known prefix and mark it incomplete.
An item completion never changes the authoritative task status.

The conversation renders in the chat's scroll area with composer inset, while
technical execution details remain collapsed. Imported timeline entries are
retained when present. The composer owns the single observer and portals its
conversation to this area; there is no second submitting client or model call.
A restored journal backfills the same native command, and forward cursor pages
load serially while the latest task is observed. The reader retains at most
4096 events per selected attempt and reports that limit rather than hiding it.
It follows new replies only while the reader stays at the end.

An older Shell/native may reject the opt-in. The consumer then attempts one
ordinary history read with a separate observation identity, the same target
command/attempt and no public flag. Authorization failures are not retried.
Successful legacy history is explicitly shown without live reply support.
Refreshing history from the start retries support; no fallback creates text,
resubmits the prompt or copies private tool/reasoning metadata.

B3/B6 are accepted only after an actual installed model reply and ordinary
quit/reopen recover the same native run and text. Source fixtures and unit
checks are not that product proof.
