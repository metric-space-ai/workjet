# Connect a Business OS for workers

Opening a project Supervisor automatically connects its selected Business OS for workers. If setup fails, **Erneut verbinden** appears in the composer bar; its tooltip explains the error. Sign in with an Owner or Admin account for the selected Business OS when requested.

In other chats, open the composer's **gear → Tools → CTOX Business OS**, enable the tool and choose **Connect selected Business OS**.

Workjet adds a separate connection for worker admission, dispatch and Luma configuration. Its permission lasts one day and grants only the Luma configuration collection, without approvals or external effects. Existing connector permissions stay unchanged. The connection remains pinned to the chat after it starts.

Existing chats keep their ready worker connection. When a connection expires, Workjet can use a single authorized replacement for the same Business OS instance and tenant. If several connections are ready, use **Choose worker access** in the Supervisor composer to select one for this chat. The short grant ID distinguishes otherwise identical names. This also works for a new Supervisor chat. Choosing a connection preserves history and saved task receipts, issues no new permission and leaves other chats and their connections unchanged.

A connection error leaves the chat unbound. Check the account's permissions and the Business OS MCP availability, then reconnect. Disconnecting the connection in Settings revokes this additional client.
