# Desktop account-session invalidation

The Electron host owns one CtoxAccountLifecycle service, provided by desktopCtoxControlLayer in apps/desktop/src/main.ts. Login and logout IPC handlers share it. It stores only a process-local generation and consumer callbacks; it is not an account or credential store.

## Consumer contract

Import apps/desktop/src/ctox/CtoxAccountLifecycle.ts and resolve CtoxAccountLifecycle from the host Effect context.

- registerInvalidator(callback) returns an unregister function. The callback receives { reason: "account-transition" | "logout", sessionEpoch: number } and returns Promise<void>. Register before admitting requests. Registration during invalidation is rejected so a new consumer cannot miss a running transition.
- In the callback, detach old handles/subscriptions and remove their projections before resolving. Cleanup must be bounded by the consumer's transport lifecycle; the host waits for all callbacks, including when another callback throws. Rejections fail the transition and keep authority closed. Do not invoke transition recursively from a callback.
- sessionEpoch() captures the current local generation. It is distinct from the server's signed authorizationEpoch.
- isCurrent(epoch) must pass immediately before opening an authorized handle and before publishing an asynchronous result. Recheck after every asynchronous authority/open step; dispose results that lose the race.
- confirmSession(epoch) returns false for a stale generation or while invalidation is active. Only the host's independently verified native-principal admission path may call it. It is not exposed to renderer IPC. Neither account-login completion nor a maintenance token is evidence sufficient to call it.
- transition(reason, operation) serializes the entire invalidation and account operation. Native code detecting an account replacement outside login IPC must use this same barrier before releasing the replacement session.

The initial generation is zero and awaits authority. A transition fences old generations before callbacks start. The login handler then deactivates pooled guests and revokes DecisionHub grants before opening the login window, which uses the existing account partition. Logout performs the same cleanup before deleting account cookies. Cancellation never restores old handles. A successful operation still awaits independently confirmed native authority.

Invalidation is not interrupted halfway through outstanding callback promises: another transition must not overtake cleanup that is still running. An operation or invalidation failure leaves the gate closed. A later successful transition can recover it, followed by fresh authority verification.

## Verification and remaining integration

CtoxAccountLifecycle.test.ts covers authority, pending/failed cleanup, consumer disposal, login/logout serialization, stale generations, failure recovery and interruption during cleanup. IPC tests execute the real login/logout handlers with isolated auth/guest/consumer fixtures and check ordering and cancellation.

This host hook alone does not implement NativeBusinessData handle/subscription/projection cleanup. Every native consumer must register and enforce the open/publish checks above, with proof and enrollment pin verification before confirmSession. Account changes discovered during refresh must also be connected to the barrier. Existing guest destruction is not proof of that native integration. Installed desktop, mobile and cross-account UI acceptance remain required.
