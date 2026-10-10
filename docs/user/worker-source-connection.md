# Connect a Business OS for workers

Opening a project Supervisor automatically connects its selected Business OS for workers. If setup fails, **Erneut verbinden** appears in the composer bar; its tooltip explains the error. Sign in with an Owner or Admin account for the selected Business OS when requested.

In other chats, open the composer's **gear → Tools → CTOX Business OS**, enable the tool and choose **Connect selected Business OS**.

Workjet adds a separate connection for worker admission and dispatch. Its permission lasts one day and excludes collection access, approvals and external effects. Existing connector permissions stay unchanged. The connection remains pinned to the chat after it starts.

After you sign in again, existing Supervisor, Persistent Worker and One-Shot Worker chats automatically use the single authorized worker connection for the same Business OS instance and tenant. Their history and saved task receipts remain available. If multiple authorized connections match, remove the unused connection in Settings; Workjet explains the choice instead of offering a reconnect button that cannot resolve it.

A connection error leaves the chat unbound. Check the account's permissions and the Business OS MCP availability, then reconnect. Disconnecting the connection in Settings revokes this additional client.
