// Local replacement for the archive's missing, side-effect-only config chunk.
// Upstream 0.18.0 exports build constants here; the two subset modules import
// it solely for side effects. It has none. No remote service defaults are needed
// by the font subsetter. See NOTICE.md and PROVENANCE.json.
export {};
