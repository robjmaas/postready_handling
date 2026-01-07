# Fly.io Deployment Checklist

## Prerequisites
- [ ] Fly.io account (free tier available at fly.io)
- [ ] `flyctl` CLI installed locally
- [ ] GitHub account with repository access

## Step-by-Step Deployment

### 1. Local Setup
```bash
# Install flyctl
brew install flyctl

# Login
flyctl auth login

# Verify
flyctl version
```

### 2. Set Environment Secrets
Run these commands from project directory:
```bash
flyctl secrets set \
  FILEMAIL_API_KEY=your_filemail_key \
  COCONUT_API_KEY=your_coconut_key \
  FRAMEIO_TOKEN=your_frameio_token \
  FRAMEIO_PROJECT_ID=your_frameio_project_id \
  CUBE_LUT_URL=your_lut_url  # Optional
```

### 3. Deploy App
```bash
# Option A: Deploy from local machine
flyctl deploy

# Option B: Let GitHub Actions deploy
git push origin main
# (Deployment happens automatically via workflow)
```

### 4. Verify Deployment
```bash
# Check status
flyctl status

# View recent logs
flyctl logs -n 50

# Test health endpoint
curl https://postready-handling.fly.dev/health

# Test webhook endpoint
curl https://postready-handling.fly.dev/webhooks/coconut
```

## After Deployment

### Update Coconut Webhook
Update Coconut configuration to point to cloud:
- Old: `http://127.0.0.1:3000/webhooks/coconut`
- New: `https://postready-handling.fly.dev/webhooks/coconut`

Or just restart and let it auto-update via the `COCONUT_WEBHOOK_URL` environment variable.

### Test Full Pipeline
1. Send test video via Filemail to Strawberries portal
2. Use `/preview/transfer/{id}` to preview
3. Use `/process/transfer/{id}` to start processing
4. Monitor via `flyctl logs -f`
5. Video should appear in Frame.io when complete

## Troubleshooting

**Error: "postready-handling already exists"**
```bash
# Use different app name
flyctl deploy --app postready-handling-prod
```

**Error: "ffmpeg not found"**
```bash
# Rebuild Docker image
flyctl deploy --no-cache
```

**Out of memory**
```bash
# Edit fly.toml, increase memory_mb, then:
flyctl deploy
```

**Need to view live logs**
```bash
flyctl logs -f
```

**Need to SSH into container**
```bash
flyctl ssh console
```

## Costs

- **App server**: $5/month (minimum, always running)
- **CPU/Memory**: Included in $5
- **ffmpeg processing**: ~$0.04/hour
  - Example: 100 × 5-min videos = 8 hours = ~$0.32/month
- **Total**: ~$5/month

## Rollback if Needed

```bash
# View deployment history
flyctl releases

# Rollback to previous version
flyctl releases rollback
```

## Next Steps

1. Deploy with `flyctl deploy`
2. Set API secrets with `flyctl secrets set ...`
3. Test with a sample video
4. Monitor logs with `flyctl logs -f`
5. Enjoy cloud processing! ☁️
