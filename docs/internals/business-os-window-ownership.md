# Business OS window ownership

The Desktop main process resolves guest operations from the native IPC sender and
its current main frame. Renderer payloads cannot select a host window. Missing,
subframe, stale-frame and guest-view senders are refused; focus and the first
window are never used as fallbacks.

Each host window owns its Business OS mode, active instance, guest views, bounds,
theme and session-transfer subscription state. Guest lifecycle and transfer events
return only to that host. Windows can display the same instance using separate
views while retaining the instance's existing authenticated Electron session.

Closing or reloading a host, or losing its renderer, fences that window's results,
interrupts pending guest work and destroys its views. A subsequent host document
starts with fresh guest state. A local selection reset affects only its window.
Account invalidation closes all window scopes; removing a registry instance
invalidates that instance's views across every window.

All windows share the existing four-renderer budget. New views evict the least
recently used detached, fully prepared guest. Active and loading guests are not
evicted to satisfy another window. If all four slots are active or loading, a
further load returns the existing guest failure result without creating a fifth
renderer. Closing a guest releases its slot and launch resources.

Focused IPC and guest-manager tests cover sender propagation, two-window routing,
reload/close with late navigation, all-window account and registry invalidation,
and the global renderer limit. These adapter tests do not establish native
Electron or installed Desktop acceptance; that requires the real multiwindow UI
story against the exact packaged revision.
