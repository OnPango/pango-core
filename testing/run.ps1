# Run from any directory; no database migrations or production writes.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$out = Join-Path $PWD 'validation-results'
New-Item -ItemType Directory -Force $out | Out-Null
git rev-parse HEAD | Set-Content "$out/commit.txt"
git status --short | Set-Content "$out/worktree.txt"
$failed = @()
function Run-Step($name, [scriptblock]$command) {
    & $command 2>&1 | Tee-Object "$out/$name.txt"
    if ($LASTEXITCODE -ne 0) { $script:failed += $name }
}
Run-Step 'install' { pnpm install --frozen-lockfile }
if ($failed.Count) { throw 'Dependency installation failed' }
Run-Step 'prisma' { pnpm prisma:generate }
if ($failed.Count) { throw 'Prisma generation failed; configure local environment first' }
Run-Step 'unit-coverage' { pnpm test:cov }
Run-Step 'lint' { pnpm lint }
Run-Step 'build' { pnpm build }
if ($env:RUN_E2E -eq '1') { Run-Step 'root-e2e' { pnpm test:e2e } }
$failed | Set-Content "$out/failed-steps.txt"
if ($failed.Count) { throw "Failed: $($failed -join ', ')" }
