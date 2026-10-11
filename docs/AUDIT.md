# Audit / test coverage

<!-- bilingual-header:v1 -->

**语言 / Language:** 正文以中文为主；下方有 English summary。
**English summary:** Public coverage pointer. Run `npm test` for the current baseline. Per-phase internal audit snapshots are not published in this tree.

---

## 当前基线

以根目录 README 的 Tests 徽章与 [RELEASE_NOTES.md](RELEASE_NOTES.md) 为准。本地复跑：

```bash
npm run build && npm test
```

## 范围

本文件不再收录分阶段内部体检快照。协议边界见 [PROTOCOLS.md](PROTOCOLS.md)；产品约束见 [ROADMAP.md](ROADMAP.md)；安全架构见 [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md)；控制台见 [CONSOLE.md](CONSOLE.md)。

Phase M 时代的 audience/actor 约定已固化为 ADR：[adr/0002-actor-bound-audience.md](adr/0002-actor-bound-audience.md)。

## English

Current baseline: root README Tests badge and [RELEASE_NOTES.md](RELEASE_NOTES.md). Re-run with `npm run build && npm test`. Historical per-phase audit notes are omitted from the public tree. See PROTOCOLS / ROADMAP / SECURITY_ARCHITECTURE / CONSOLE for product boundaries.
