# Add a project

Select the instance that should own the project, choose **Add project**, then
enter its name. The project keeps one Supervisor conversation. A computer and
working folder can be attached later.

Until you attach a working folder, the project's Lumas use a private project
directory on the connected Workjet server. Its contents remain available to
that project across sessions and restarts. An attached working folder takes
precedence for new sessions.

If the instance requires a separate sign-in, choose **Sign in to instance**.
Workjet opens that instance in **Business OS**. After signing in, return to
**Code** to continue. A project waiting for registration is not confirmation
that the instance has accepted it.

If Workjet reports that the instance does not provide project management,
update its Business OS shell in **Settings**.

## Browse projects

In the desktop or web app, choose **All projects** above the project picker to
return to the overview.
The cards show the saved projects for the selected instance. Choose a card to
open that project, or choose **Add project** to create another one.

If an existing instance project has no conversation on this Code environment,
choose **Open supervisor**. Workjet retains the same project identity and opens
its saved Supervisor conversation. No working folder is required. Instance
synchronization may still be pending; it never replaces another instance’s
conversation.

The overview stays selected when you reopen Workjet. If a previously selected
project is removed, Workjet returns to the overview instead of opening a
different project automatically.

To start an existing local backend, open **Settings**, select **Computers**,
inspect **This computer** under **Install on a computer**, and choose
**Start backend** when the installed backend is detected.
