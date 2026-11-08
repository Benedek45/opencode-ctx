# Changelog

## 1.0.2

- Documentation only: publish aggregate results of a conversation-recall
  benchmark (8 long real sessions, 144 questions) comparing simulated native
  OpenCode compaction with the ctx projection, with its method and limits. No
  code changes.

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
