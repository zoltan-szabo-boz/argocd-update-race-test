# argocd-update-race-test

Throwaway repo. Reproduces the release race in GSE's `update-argocd` and tests a fix.

`gitops/targets/cluster-dev/math-models.yaml` is a made-up stand-in for a shared math-models values file.
The `Race` workflow starts 15 deploy legs at once, each releasing one game through its own PR:

- `method: old` uses today's steps (`fjogeleit/yaml-update-action`, then `gh pr update-branch` / `gh pr merge --squash`).
- `method: new` uses `.github/actions/update-argocd-new`: it edits a snapshot of main and commits with that snapshot as parent, then squash-merges.

The `verify` job checks every deployed game carries the run's image and nothing else in the file changed.
