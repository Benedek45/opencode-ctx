# Changelog

## 1.0.1

- Restrict near-duplicate pruning to a known same-tool, same-resource pair;
  preserve case and syntax in fingerprints and retain operator changes. Only the
  earlier result is superseded. Invalidate legacy near-dupe decisions once to
  restore potentially hidden content (may invalidate prompt cache).
- Archive original V2 part JSON so media and opaque payloads survive decompression
  after native host compaction. Missing legacy payloads now error explicitly.
  Unsupported V2 portable/remote handoffs reject rather than omit attachments.
- Create/tighten plugin-owned offload directories to 0700 and atomically publish
  exclusive 0600 files. Tighten existing log files to 0600 on append.
- Clarify summary visibility, recovery limits and evaluation status; remove stale
  known-test-failure documentation. No published task-level compaction A/B yet.
