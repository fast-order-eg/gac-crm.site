param (
    [string]$msg = "Update codebase"
)

Write-Host "🚀 [1/3] Adding changes to Git..." -ForegroundColor Cyan
git add .
$status = git status --porcelain
if ($status) {
    git commit -m "$msg"
} else {
    Write-Host "No changes to commit, continuing..." -ForegroundColor Yellow
}

Write-Host "⬆️ [2/3] Pushing changes to GitHub..." -ForegroundColor Cyan
git push origin main

Write-Host "🌐 [3/3] Triggering Zero-Downtime Deployment on Server..." -ForegroundColor Cyan
ssh my-cyberpanel "/home/gac-crm.site/deploy.sh"

Write-Host "🎉 Deployment finished successfully without downtime!" -ForegroundColor Green
