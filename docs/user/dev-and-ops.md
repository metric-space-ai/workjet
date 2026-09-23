# Dev and Ops

The Workjet desktop header keeps your selected Business OS instance visible
while you switch between Dev and Ops.

Use **Dev** for projects and conversations. Use **Ops** to open the selected
instance's Business OS desktop. Switching views keeps the instance selected;
it does not move an existing conversation to another instance.

Choose another instance from the header dropdown. Project navigation remains
in the Dev sidebar. Ops gives the available width to the Business OS desktop.

In compact windows, project or app controls move to a second header row.
The instance selector, Dev/Ops switch and Settings remain in the top row;
the editor, sidebar and Business OS desktop begin below both rows.

Open **Settings → Business OS → Instanzverbindungen verwalten** to sign in,
refresh connections, add a connection or remove one. These controls are shared
by both views. The Settings button stays available in the header when the
sidebar is hidden.

To work on Business OS apps with an external coding harness, enable **CTOX
Business OS** in the conversation's **Tools** menu and choose its MCP
connection. Available connections must belong to the computer running that
harness. With an instance selected in the header, new selections are limited
to that instance.

The conversation keeps its chosen connection. Turning the tool off removes
access without changing that identity; use a new conversation for another
instance. The coding agent can inspect and edit app sources, read the instance's
development rules, validate changes or delegate app work to CTOX. Delegated
work has its own command/run status and is not complete merely because the
request was accepted.
