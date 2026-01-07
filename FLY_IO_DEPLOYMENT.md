# Fly.io Cloud Deployment Guide

## Quick Start

### 1. Install Fly CLI
```bash
brew install flyctl  # macOS
# or
curl -L https://fly.io/install.sh | sh  # Linux/macOS
```

### 2. Login to Fly.io
```bash
flyctl auth login
# Opens browser to create/login account
```

### 3. Set Up Secrets
```bash
# Navigate to project directory
cd /path/to/postready_handling

# Set API keys (will be encrypted on Fly.io)
flyctl secrets set FILEMAIL_API_KEY=your_key
flyctl secrets set COCONUT_API_KEY=your_key
flyctl secrets set FRAMEIO_TOKEN=your_token
flyctl secrets set FRAMEIO_PROJECT_ID=your_id
flyctl secrets set CUBE_LUT_URL=https://example.com/lut.cube  # Optional
```

### 4. Deploy
```bash
# Option A: Deploy locally
flyctl deploy

# Option B: Auto-deploy on git push
# (requires GitHub Actions - already set up)
git push
```

### 5. Verify Deployment
```bash
# Check app status
flyctl status

# View logs
flyctl logs

# Test endpoint
curl https://postready-handling.fly.dev/health
```

## How It Works (Cloud)

1. **Webhook receives Coconut callback** → `https://postready-handling.fly.dev/webhooks/coconut`
2. **ffmpeg processes in cloud** (Fly.io container with ffmpeg pre-installed)
   - Downloads Coconut MP4 from Wasabi
   - Burns in timecode
   - Applies cube LUT color grading
   - Re-encodes video
3. **Uploads to Wasabi** (processed video with effects)
4. **Uploads to Frame.io** (final result)

## Architecture

```
Filemail Transfer
    ↓
Coconut API (cloud transcode)
    ↓
Coconut Webhook → Fly.io App
    ↓
ffmpeg (in cloud) + LUT + Timecode
    ↓
Wasabi S3 (reupload)
    ↓
Frame.io (final delivery)
```

## Scaling

- **Min machines**: 0 (auto-stop when idle)
- **Max machines**: Unlimited (auto-scale)
- **Region**: ord (Chicago, can be changed)
- **Cost**: ~$5/month + compute time

## Monitoring

```bash
# View real-time logs
flyctl logs -f

# Check resource usage
flyctl status -a postready-handling

# SSH into container (for debugging)
flyctl ssh console
```

## Rolling Back

```bash
# View deployment history
flyctl releases

# Rollback to previous version
flyctl releases rollback
```

## Local Development

For local testing without Fly.io:
```bash
# Run locally (no cloud processing)
node index.js

# Webhook URL will be: http://127.0.0.1:3000/webhooks/coconut
# (requires ngrok or similar for external testing)
```

## Troubleshooting

**"Connection refused":**
```bash
flyctl status  # Check if app is running
flyctl restart  # Restart if needed
```

**"Out of memory":**
```bash
# Increase VM size in fly.toml
# Change memory_mb from 1024 to 2048
flyctl deploy --now
```

**"ffmpeg not found":**
```bash
# Redeploy to rebuild Docker image with ffmpeg
flyctl deploy --no-cache
```

## Cost Breakdown

- **App**: $5/month (always running)
- **Shared CPU**: Included
- **Memory**: Included (1GB)
- **ffmpeg processing**: ~$0.04/hour of CPU time
  - Example: 100 videos × 5 min average = 8 hours → ~$0.32/month

**Total**: ~$5/month (extremely cheap for professional processing!)
