# Happy Scribe Integration - Implementation Guide

## Quick Start

### 1. Get Happy Scribe Credentials
1. Go to https://www.happyscribe.com
2. Sign up and create account
3. Navigate to Account → API Settings
4. Copy your API Key
5. Get your Organization ID (visible in workspace settings)

### 2. Set Environment Variables

**Local (.env):**
```bash
HAPPYSCRIBE_API_KEY=your_api_key_here
HAPPYSCRIBE_ORG_ID=your_org_id_here
HAPPYSCRIBE_AUTO_TRANSCRIBE=false          # Start with false for testing
HAPPYSCRIBE_TRANSCRIBE_SERVICE=auto        # auto = fast/cheap, pro = human
HAPPYSCRIBE_TRANSCRIBE_LANGUAGE=en         # Source language
HAPPYSCRIBE_EXPORT_FORMATS=vtt,srt,json    # Formats to download
HAPPYSCRIBE_WEBHOOK_URL=https://postready-handling.fly.dev/webhooks/happyscribe
```

**Production (fly.toml):**
```toml
[env]
  HAPPYSCRIBE_API_KEY = "your_api_key"
  HAPPYSCRIBE_ORG_ID = "your_org_id"
  HAPPYSCRIBE_AUTO_TRANSCRIBE = "false"
  HAPPYSCRIBE_WEBHOOK_URL = "https://postready-handling.fly.dev/webhooks/happyscribe"
```

Or use `flyctl secrets`:
```bash
flyctl secrets set HAPPYSCRIBE_API_KEY="your_key" HAPPYSCRIBE_ORG_ID="123"
```

### 3. Add Database Schema

Add to `initDb()` in index.js:

```javascript
await db.exec(`
  CREATE TABLE IF NOT EXISTS happy_scribe_orders (
    id TEXT PRIMARY KEY,
    transfer_id TEXT,
    job_id TEXT,
    organization_id TEXT,
    order_id TEXT,
    source_type TEXT,
    source_url TEXT,
    language TEXT,
    state TEXT DEFAULT 'pending',
    exported_formats TEXT,
    transcript_json_url TEXT,
    transcript_vtt_url TEXT,
    transcript_srt_url TEXT,
    error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    updated_at DATETIME,
    FOREIGN KEY(transfer_id) REFERENCES processed_transfers(id)
  );

  CREATE TABLE IF NOT EXISTS happy_scribe_translations (
    id TEXT PRIMARY KEY,
    order_id TEXT,
    source_transcription_id TEXT,
    target_language TEXT,
    state TEXT DEFAULT 'pending',
    translated_transcription_id TEXT,
    error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY(order_id) REFERENCES happy_scribe_orders(id)
  );
`);
```

### 4. Import Happy Scribe Service

At top of index.js:
```javascript
import happyscribeService from './happyscribe-service.js';
```

### 5. Add API Endpoints

Copy all endpoints from `happyscribe-endpoints.js` into index.js after other routes.

### 6. Integrate with MediaConvert Webhook (Optional)

In your MediaConvert webhook handler, after job completes:

```javascript
app.post('/webhooks/mediaconvert', async (req, res) => {
  // ... existing code ...

  if (HAPPYSCRIBE_AUTO_TRANSCRIBE && job.Status === 'COMPLETE') {
    try {
      console.log(`🚀 Auto-creating Happy Scribe order...`);
      const mediaFileUrl = `s3://postready-staging/outputs/${job.Settings.OutputGroups[0].Outputs[0].NameModifier || filename}.mp4`;
      
      const result = await happyscribeService.createTranscriptionOrder(
        mediaFileUrl,
        filename,
        { 
          service: process.env.HAPPYSCRIBE_TRANSCRIBE_SERVICE || 'auto',
          language: process.env.HAPPYSCRIBE_TRANSCRIBE_LANGUAGE || 'en',
          transferId,
          jobId: job.Id
        }
      );
      
      console.log(`✅ Happy Scribe order created: ${result.orderId}`);
    } catch (err) {
      console.error(`⚠️  Happy Scribe order failed: ${err.message}`);
      // Don't fail the entire webhook - continue
    }
  }

  return res.json({ success: true });
});
```

## Usage Examples

### 1. Create Manual Transcription
```bash
# After MediaConvert completes
curl -X POST https://postready-handling.fly.dev/transcribe/transfer/YOUR_TRANSFER_ID \
  -H "Content-Type: application/json" \
  -d '{
    "service": "auto",
    "language": "en"
  }'

# Response:
{
  "success": true,
  "orderId": "order_123xyz",
  "state": "submitted",
  "estimatedCompletionMs": 60000,
  "transferId": "YOUR_TRANSFER_ID"
}
```

### 2. Check Transcription Status
```bash
curl https://postready-handling.fly.dev/transcribe/order/order_123xyz
```

### 3. Download Transcript
```bash
# Get VTT (auto-redirect to download)
curl https://postready-handling.fly.dev/transcribe/download/order_123xyz?format=vtt

# Get JSON (get URL only, don't redirect)
curl https://postready-handling.fly.dev/transcribe/download/order_123xyz?format=json&redirect=false
```

### 4. Create Translation
```bash
curl -X POST https://postready-handling.fly.dev/translate/order/order_123xyz \
  -H "Content-Type: application/json" \
  -d '{
    "targetLanguages": ["es", "fr", "de"],
    "service": "auto"
  }'
```

### 5. List All Transcriptions for Transfer
```bash
curl https://postready-handling.fly.dev/transcribe/list/YOUR_TRANSFER_ID
```

### 6. View Statistics
```bash
curl https://postready-handling.fly.dev/transcribe/stats
```

## Database Tables

### happy_scribe_orders
Tracks transcription orders:
- `id` - Internal ID
- `order_id` - Happy Scribe order ID
- `transfer_id` - Postready transfer ID
- `job_id` - MediaConvert job ID
- `state` - pending, submitted, fulfilled, failed
- `exported_formats` - JSON of available formats
- `created_at` / `completed_at` - Timestamps

### happy_scribe_translations
Tracks translation requests:
- `id` - Internal ID
- `order_id` - Source transcription order
- `target_language` - Language code (es, fr, etc)
- `state` - pending, working, done, failed
- `translated_transcription_id` - Happy Scribe transcript ID

## Monitoring

### Check Pending Transcriptions
```bash
sqlite3 processed_transfers.db "SELECT order_id, state, created_at FROM happy_scribe_orders WHERE state != 'fulfilled';"
```

### Check Costs
```bash
# In Happy Scribe dashboard - navigate to Billing
```

## Troubleshooting

### "Happy Scribe not configured"
- Check HAPPYSCRIBE_API_KEY is set
- Check HAPPYSCRIBE_ORG_ID is set
- Verify credentials in Happy Scribe dashboard

### "Transcription failed"
- Check file URL is publicly accessible
- Verify S3 bucket permissions
- Check Happy Scribe API status page

### Slow transcriptions
- Use "auto" service (fast, ~1-5 min)
- "pro" service takes 24-48+ hours
- Use HAPPYSCRIBE_EXPORT_FORMATS to limit downloads

### Webhook not receiving
- Verify webhook URL is publicly accessible
- Check firewall/security group allows inbound
- Test with: `curl -X POST https://yourapp/webhooks/happyscribe -d '{"id":"test"}'`

## Cost Examples

### Typical Pricing
- **Auto Transcription:** $0.10-0.25 per minute
- **Pro (Human):** $1-3 per minute
- **Translation:** $0.05-0.50 per minute

### Example: 1-hour video
- Auto transcription: $3-15
- Pro transcription: $60-180
- Translation to 3 languages: $5-25

## Best Practices

1. **Start with "auto" service** - Fast and cheap
2. **Use webhooks** - Don't rely on polling
3. **Batch translations** - Request multiple languages at once
4. **Monitor costs** - Check Happy Scribe billing regularly
5. **Clean up exports** - Delete old exports to save space
6. **Test with small files first** - Verify setup before production

## Security Notes

1. **API Key:** Never commit to git, always use environment variables
2. **Webhooks:** Implement signature verification once HS provides details
3. **S3 URLs:** Use pre-signed URLs or public URLs only
4. **Storage:** Downloaded transcripts stored in database/S3, not transmitted

## Next Steps

1. ✅ Get Happy Scribe credentials
2. ✅ Set environment variables
3. ✅ Add database schema
4. ✅ Import service module
5. ✅ Add API endpoints
6. ✅ Test manual transcription
7. ✅ (Optional) Enable auto-transcription
8. ✅ (Optional) Add translations
9. ✅ Monitor usage and costs

---

**Questions?** Refer to:
- Happy Scribe API: https://dev.happyscribe.com/
- Implementation Plan: HAPPYSCRIBE_INTEGRATION_PLAN.md
- Service Module: happyscribe-service.js
- API Endpoints: happyscribe-endpoints.js
