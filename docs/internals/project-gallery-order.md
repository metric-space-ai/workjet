# Project gallery order

The **All projects** grid stores one order per user in CTOX, not in the browser.

- Commands: `ctox.workjet.project.gallery.order.read` and `ctox.workjet.project.gallery.order.set`, served by `src/core/business_os/workjet_project_gallery_order.rs`.
- Storage: table `workjet_project_gallery_order`, keyed by the canonical owner. `set` requires the expected revision and rejects repeated ids and lists over 500 entries.
- Web: `apps/web/src/routes/_chat.index.tsx` (`ProjectGallery`) reads the order on load, saves it after a drop, and reverts to the last confirmed order when the save fails.
- Shell: `project.gallery.order.read|set` in `src/apps/business-os/app.js` forwards to the command plane and checks the receipt before returning.
- Only native project ids are stored. Local-only projects keep their place after saved ones. A dedicated drag handle leaves website links, project actions and mobile scrolling independent. Sorting is disabled while native order is unavailable or a save is pending; instance changes discard late UI receipts and reset the projection.
