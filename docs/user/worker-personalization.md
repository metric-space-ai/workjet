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
