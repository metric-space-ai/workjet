# Greppy harness

Workjet connects to Greppy through ACP over standard input/output, using the same session runtime as its Grok integration. The Greppy executable must expose `greppy agent stdio`; a version number alone does not establish that capability.

In **Settings → Harnesses**, enable Greppy, select its executable if it is not on your PATH, and configure a gateway endpoint and model. The endpoint is a plain HTTP gateway root such as `http://127.0.0.1:8317`. Workjet's configured gateway routing supplies the session environment; API keys travel in the child environment rather than command arguments. The project folder is the child process's working directory.

A Greppy thread accepts text prompts and follow-up messages. Model selection can change within the session. Streaming text and tool activity use Workjet's normal conversation events. In approval mode, tool requests wait for a Workjet permission decision; full-access mode permits the advertised one-time option. Stopping a turn sends ACP cancellation, including while Greppy waits for model output or a permission decision. The adapter remains busy until the prompt settles.

The resume cursor stores the ACP session ID. After Workjet restarts, Greppy loads that session's persisted conversation. Sessions created by the earlier socket transport cannot be resumed through this adapter. A failed transcript write is reported as an error instead of claiming the turn was saved.

This initial ACP implementation accepts text only. It does not support attachments, a separate planning mode, structured user-input requests, transcript rollback, or Workjet MCP capabilities. Workjet refuses these operations explicitly. A Greppy installation without ACP is shown as unavailable for starting threads.
