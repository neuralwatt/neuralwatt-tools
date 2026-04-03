# Neuralwatt Tools

Neuralwatt tools, plugins, and recipes for AI inference workflows.

## Workflow

This repository uses **trunk-based development**:

1. **Create feature branches** from `main` for all changes
2. **Push changes as Pull Requests** targeting `main`
3. **Never push directly to `main`**

### Git Hooks

Enable on every fresh clone:
```bash
git config core.hooksPath .githooks
```
This is a per-clone setting and must be re-run after cloning to a new machine.

**Pre-push hook** — blocks direct pushes to `main`. All changes should go
through a feature branch + PR.

To override in an emergency: `ALLOW_MAIN=1 git push`
