# macOS background-service permissions

Workjet keeps the background service's Node executable at a fixed location across Workjet updates. Updates using the same Node major reuse that executable instead of creating a new program identity for each Workjet version.

macOS may ask for Documents access when the service first moves to this location or when Workjet changes Node major. Choose the permission according to the folders you want Workjet to use. Workjet does not change or reset your macOS privacy permissions.
