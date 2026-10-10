# Worker personalization

Saved workers can carry an optional behavior and writing profile in **Settings → Workjet → Workers**.

- Turn **Personalization** on only for workers that should use the profile.
- The six large sliders set the broad profile. Open a row to reveal its smaller detail sliders.
- **Customize** allows detail sliders to be added, renamed, removed, and coupled through the W/A
  weighting controls.
- The **Organigram** tab arranges saved workers and records directed dependencies between them.
- The **Prompt** tab shows the complete generated persona system prompt for every worker. It is
  read-only because it is derived from the stored profile; edit the profile to change it.

When personalization is enabled, Workjet prepends the generated persona prompt to the worker task.
The prompt identifies the worker by name and job, embeds the complete saved worker graph as Mermaid
with the active worker marked, and then supplies the resolved profile. It describes both sides of
every slider as positive strengths, includes the selected numeric values, and explicitly states which
side should not be the default. Safety rules, facts, and required output formats still take precedence.

The generated prompt and its JSON use canonical English text. Changing the app's display language
does not translate or otherwise alter the instructions sent to the model. Custom slider poles are
therefore entered as English prompt text.

## Connect project workers

Open the project supervisor and choose **Connect workers**. This connects the selected Business OS
for worker dispatch without configuring a separate coding chat. **Workers connected** confirms that
the worker connection is ready. Ordinary supervisor messages remain available independently.

Connect from the desktop app. If the connection is unavailable later, choose **Connect workers** again;
existing Business OS permissions still apply.

## Persistent Worker goals

A Persistent Worker keeps its assignment visible above its conversation, including imported threads.
Before its goal loop starts, the header says that no goal is set; importing a conversation does not start work automatically.
Use **Ziel festlegen** to save an objective and start the loop. **Ziel ändern**, **Pausieren** and **Fortsetzen** control the saved goal.
A failed save retains your draft. A paused worker stays paused when its objective changes.

The project Supervisor can assign or change a bound Persistent Worker's objective with
`workjet_update_goal {action: "set", threadId, objective, expectedRevision?}`.
The Supervisor cannot change a worker outside its project or resume a worker stopped by its Owner.

The loop state and iteration count come from the saved thread state. At each iteration's start the worker records
its mini-kanban with `workjet_worker_kanban`. Workjet displays that retained Slide-Engine board above the conversation.
A previous iteration remains labelled as an earlier snapshot until a new one is recorded.
Cards and completed turns report activity; they do not verify goal completion. Supervisors and One-Shot Workers have no mini-kanban.
