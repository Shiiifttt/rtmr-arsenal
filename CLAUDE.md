# Running commands

The owner runs long sims unattended, so commands must match the allow list in `.claude/settings.local.json` without prompting:

- No shell variables (`S=...`, `$G = "..."`, `$S/out.txt`) in Bash or PowerShell. Write values and paths out literally, even if repetitive.
- For changes shared by every row in `combat/tools/farm.ts`, pass `--base "..."` once instead of repeating them in each `--variant`.
- One `node ...` per call where possible; read output files with the Read tool rather than `tail`/`Get-Content` chains.
- Create or tweak JSON (profile variants etc.) with Write/Edit, not `node -e`.
