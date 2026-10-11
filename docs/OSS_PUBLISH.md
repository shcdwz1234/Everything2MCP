# Publishing to public GitHub

<!-- bilingual-header:v1 -->

**语言 / Language:** 正文以中文为主；下方有 English summary。
**English summary:** When mirroring this OSS-prep branch to a **public** GitHub repo, publish as a **single orphan/squash commit** so private process history (local Gitea, phase commits, internal reports) never appears on GitHub.

---

## 为何用 orphan / squash

本仓库在本地 Gitea 上有完整过程历史（阶段提交、内部体检、改版纪要等）。公开 GitHub **不应**带上这些过程。`oss/public`（或同类分支）只是**发布前 scrub 工作区**；真正推到公开远端时，要用**无历史单提交**。

## 推荐步骤

在已 scrub 的 `oss/public`（或等价分支）干净工作树上：

```bash
# 1. 从当前树建 orphan 分支（无父提交）
git checkout --orphan public-release
git add -A
git commit -m "chore: initial public release"

# 2. 推到公开 GitHub（示例远端名 github）
git remote add github https://github.com/OWNER/everything2mcp.git   # 若尚未添加
git push -u github public-release:main
```

等价做法：对 `oss/public` 做 **squash 成一个 commit** 再推到公开 `main`（同样不要把本地 Gitea 的多提交历史 force 到公开仓库）。

## 不要做的事

- **不要**把本地 `main` 的完整历史 force-push 到公开 GitHub。
- **不要**在公开树中恢复 `docs/CONSOLE_REDESIGN_REPORT.md`、`docs/PHASE_M_REVIEW.md` 或未裁剪的长篇 `AUDIT` 过程快照。
- **不要**把 `data/`、`.env`、密钥、本机路径写进公开提交。
- 推公开前把 `package.json` 里的 `OWNER` 占位换成真实 GitHub org/user。

## 本分支已做的 scrub

- 移除内部文：`CONSOLE_REDESIGN_REPORT`、`PHASE_M_REVIEW`；`AUDIT.md` 改为公开短文。
- `package.json` repository/homepage/bugs：localhost Gitea → `github.com/OWNER/...` 占位。
- ROADMAP / PROTOCOLS：去掉「等 maintainer continue」口吻。
- 修复指向已移除文档的链接；清理 `.dockerignore` 中过期 ThinkBook 行。
- `data/` 保持在 `.gitignore`，从不跟踪。

## English

Publish to public GitHub with an **orphan branch** or **single squash commit**. Do not force the local Gitea process history onto the public remote. Replace `OWNER` placeholders in `package.json` before the public push. Keep `data/` untracked.
