# Configure the project supervisor

The supervisor has the same composer controls as an ordinary thread. Choose a Luma, or choose **Manual** to select the harness, model and computer separately. Advanced settings are behind the gear; dictation is beside Send.

The selection is saved on the project's instance immediately, without sending a message. Workjet reads it back before showing it as the saved choice. Opening the project again restores that selection. A new supervisor request uses the project's selected Luma; an existing request keeps its original route.

Manual choices create a Luma owned by this project. Changing them leaves shared Lumas intact. A model needs an available account, and the selected computer needs the harness. Workjet creates a missing account route from the advertised model catalog when you make the selection. Workjet explains an unavailable combination in the status line above the editor.

The supervisor connects automatically. If several ready worker connections belong to the project’s instance, choose one in the status line above the editor. Workjet saves that access for the thread and hides the choice once it is bound. Other instances and expired access cannot be selected. If sign-in or reconnection is needed, the status line offers the appropriate action. Worker configuration remains available through Settings and the Luma picker.

## Delegating work

The supervisor plans, decides, reviews and handles escalations. It keeps its own reading and review brief, and delegates code, research, decks and reports, tests and data maintenance to persistent or one-shot workers. Work expected to take more than a few minutes or many tool calls goes to a worker with a clear goal, acceptance criterion, boundaries and result format.

The supervisor chooses each worker's harness and model for the task from approved, available models—for example, Grok for regular-meeting preparation or Codex for code. A one-shot worker prepares the regular meeting. The supervisor checks each result against the acceptance criterion before reporting it as done.
