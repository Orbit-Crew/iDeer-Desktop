# Local development storage

Before running direct installs, Python/uv commands, or PowerShell acceptance
scripts on Windows, dot-source `scripts/project-env.ps1` in the same shell
invocation as the command. Project npm scripts initialize this environment
automatically. Keep downloads in the checkout's `.cache` and temporary files in
the adjacent `<checkout>.tmp` directory, outside the repository for signing tests.

When changing cache settings, moving the checkout, or cleaning acceptance files,
read `docs/local-disk-usage.md`. Preserve reports, credentials, and application
data; clean test fixtures only after their processes exit.
