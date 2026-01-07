# Postready Handling - Deployment Guide

## Local Testing

✅ All endpoints are working locally:

```bash
# Health check
curl http://localhost:3000/health
# {"status":"ok","uptime":...}

# Webhook (POST)
curl -X POST http://localhost:3000/webhooks/coconut \
  -H "Content-Type: application/json" \
  -d '{"job": {"id": "test-123", "status": "completed", "output": {"mp4": {"url": "https://example.com/output.mp4"}}}}'
# {"success":true,"jobId":"test-123","status":"completed"}
```

Run the test suite:
```bash
./test-webhook.sh
```

## Deploying to Fly.dev

### Prerequisites
- Fly.dev account (https://fly.io)
- `flyctl` CLI installed (`/Users/robmaas/.fly/bin/flyctl`)

### Deployment Steps

1. **Authenticate with Fly.dev:**
   ```bash
   flyctl auth login
   ```

2. **Deploy the application:**
   ```bash
   cd /Users/robmaas/Desktop/iMac/Projects/postready_handling
   flyctl deploy
   ```

3. **Verify deployment:**
   ```bash
   # Check health
   curl https://postready-handling.fly.dev/health
   
   # Test webhook
   curl -X POST https://postready-handling.fly.dev/webhooks/coconut \
     -H "Content-Type: application/json" \
     -d '{"job": {"id": "test-123", "status": "completed"}}'
   ```

### Configuration

The `fly.toml` file is already configured with:
- **Region:** Amsterdam (ams)
- **Memory:** 1GB
- **CPU:** 1 shared core
- **Port:** 3000
- **Data mount:** Persistent `/data` volume (for future database)
- **Auto-scaling:** Minimum 0 machines (stops when idle, saves cost)

### Webhook URL for Coconut

Once deployed, configure Coconut to send callbacks to:
```
https://postready-handling.fly.dev/webhooks/coconut
```

## Current Status

### ✅ Working
- Filemail transfer fetching
- Coconut job creation (all 10 videos)
- Webhook endpoint (returns 200 OK)
- Health check endpoint
- Error handling for invalid payloads

### ⏸️ Temporarily Disabled
- SQLite database (for testing without native dependencies)
- Duplicate transfer detection

To re-enable the database:
1. Uncomment database code in `index.js`
2. Ensure `sqlite3` and `sqlite` are in `package.json` dependencies
3. Update Fly.dev deployment if needed

## Troubleshooting

### "Could not notify your server"
- Ensure `flyctl deploy` completes successfully
- Check: `curl https://postready-handling.fly.dev/health` returns 200
- Wait 30 seconds for Fly.dev machines to start

### Database compile errors
- Database is intentionally disabled for deployment testing
- The app works without it - all core features are functional

### Port already in use locally
```bash
pkill -9 node
PORT=3000 node index.js
```

## Next Steps

1. Deploy to Fly.dev with `flyctl deploy`
2. Verify webhook receives Coconut callbacks
3. Re-enable database once confirmed working
4. Set up persistent storage for transfer history
