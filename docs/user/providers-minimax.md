# MiniMax Code

Choose **MiniMax Code** in Harnesses and select the computer where it should run. Workjet supports the official MiniMax Code CLI 0.6.2 through ACP. Install MiniMax Code on that computer, or set its executable path to an existing installation. Installation and updates preserve your separately stored MiniMax Code profile and sessions.

Sign in with MiniMax Code on the selected computer, or use an authorized provider already configured in its profile. An optional profile directory selects an existing profile on that computer. Workjet checks the actual runtime before offering models; a saved model name alone does not establish access.

The preferred model is **MiniMax-M3.1-Flash-Preview**. Workjet offers it only when the authenticated runtime advertises it. Choose the provider route separately when multiple routes are available. Workjet rejects an unavailable model or route and never substitutes another model. Workjet gateway routing for this CLI is not yet verified; use an explicitly configured MiniMax Code provider route.

Thinking is always enabled for this preview model. Workjet sends only the effort choices advertised by the selected runtime: Low, Medium, High, Extra high, and Max. Automatic retains the runtime's effort setting. Responses can arrive without a visible reasoning transcript.

Approval-required tasks need the native MiniMax Code permission mode **Ask**. If the profile uses Auto or Bypass, switch it to Ask in MiniMax Code and reconnect. Workjet refuses approval-required tasks on a permissive profile and does not rewrite its permission setting.

Tasks stream replies, reasoning when provided, tool activity, file changes, permission prompts, and questions. Answer questions or approve tools in the conversation. Plan mode is available when the runtime advertises it. This CLI's ACP interface currently advertises text prompts; the model's separate image/video capabilities do not imply attachment support in ACP.

Stop interrupts the active task. Reopen a saved thread to resume its same MiniMax Code session on the same computer and profile. A missing or incompatible saved session is reported; Workjet does not silently start a replacement task. If the CLI disconnects, reconnect by resuming that saved thread.
