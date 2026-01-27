# Happy Scribe Integration Plan

## Overview
Add transcription/translation service to video processing pipeline using Happy Scribe API.

## Integration Architecture

```
Current Pipeline:
  Filemail → S3 (stage) → MediaConvert → S3 (output) → Frame.io

New Pipeline:
  Filemail → S3 (stage) → MediaConvert → S3 (output) → Frame.io
                                              ↓
                                       Happy Scribe
                                       (async, parallel)
                                              ↓
                                       Download transcripts
                                       (VTT, SRT, JSON, etc)
```

## Implementation Options

### Option 1: Auto-Transcribe After MediaConvert (Recommended)
- **When:** After MediaConvert job completes
- **Trigger:** MediaConvert webhook handler
- **Files:** Generated MP4 from S3
- **Benefits:**
  - Clean encoded MP4 for transcription
  - Natural placement in workflow
  - Easy webhook integration
- **Cost:** Per-minute transcription cost

### Option 2: Parallel Transcription (Original File)
- **When:** Same time as MediaConvert (in parallel)
- **Trigger:** Transfer processing starts
- **Files:** Original MXF/MOV from Filemail
- **Benefits:**
  - Faster overall (runs simultaneously)
  - Get transcripts sooner
- **Drawbacks:**
  - Transcribes original audio (may have background noise)
  - Doesn't benefit from MediaConvert normalization

### Option 3: Manual/Optional (Per-Transfer)
- **When:** Manually requested via API
- **Trigger:** `/transcribe/transfer/{id}` endpoint
- **Benefits:**
  - Flexible, no automatic costs
  - Only transcribe when needed
  - Can choose file version

## Recommended: Option 1 + Option 3
- **Auto-transcribe** after MediaConvert for standard workflow
- **Manual endpoint** for flexibility and cost control
- **Configurable** via environment variable (enable/disable)

## Database Schema

```sql
-- Store transcription orders and status
CREATE TABLE happy_scribe_orders (
  id TEXT PRIMARY KEY,
  transfer_id TEXT,
  job_id TEXT,           -- MediaConvert job ID
  organization_id TEXT,  -- Happy Scribe org
  order_id TEXT,         -- Happy Scribe order ID
  source_type TEXT,      -- 'mediaconvert' or 'filemail'
  source_url TEXT,       -- S3 or Filemail URL
  language TEXT,         -- Source language (en, es, etc)
  state TEXT,            -- pending, working, done, failed
  exported_formats TEXT, -- JSON: {vtt, srt, docx, ...}
  transcript_json_url TEXT,
  transcript_vtt_url TEXT,
  transcript_srt_url TEXT,
  error TEXT,
  created_at DATETIME,
  completed_at DATETIME,
  FOREIGN KEY(transfer_id) REFERENCES processed_transfers(id),
  FOREIGN KEY(job_id) REFERENCES coconut_jobs(id)
);

-- Store translations
CREATE TABLE happy_scribe_translations (
  id TEXT PRIMARY KEY,
  order_id TEXT,         -- Happy Scribe order ID
  source_transcription_id TEXT,
  target_language TEXT,  -- es, fr, de, etc
  state TEXT,            -- pending, working, done, failed
  translated_transcription_id TEXT,
  error TEXT,
  created_at DATETIME,
  completed_at DATETIME,
  FOREIGN KEY(order_id) REFERENCES happy_scribe_orders(id)
);
```

## Environment Variables

```env
# Happy Scribe Integration
HAPPYSCRIBE_API_KEY=your_api_key_here
HAPPYSCRIBE_ORG_ID=your_org_id_here
HAPPYSCRIBE_AUTO_TRANSCRIBE=true          # Enable auto-transcription
HAPPYSCRIBE_TRANSCRIBE_SERVICE=auto       # auto or pro
HAPPYSCRIBE_TRANSCRIBE_LANGUAGE=en        # Source language
HAPPYSCRIBE_EXPORT_FORMATS=vtt,srt,json   # Formats to download
HAPPYSCRIBE_WEBHOOK_URL=https://...       # For HS webhooks
```

## API Endpoints to Add

### 1. Create Transcription Order
```
POST /transcribe/transfer/{transferId}
Body: {
  "service": "auto|pro",      # auto (fast, cheaper) or pro (human)
  "language": "en",           # Source language
  "sourceType": "mediaconvert|filemail"
}
Response: { orderId, state, ... }
```

### 2. Create Translation Order
```
POST /translate/order/{orderId}
Body: {
  "targetLanguages": ["es", "fr", "de"],
  "service": "auto|pro"
}
Response: { taskId, state, ... }
```

### 3. Get Transcription Status
```
GET /transcribe/order/{orderId}
Response: { id, state, progress, transcript_urls, ... }
```

### 4. Download Transcript
```
GET /transcribe/download/{orderId}?format=vtt|srt|json|docx
Response: File download or redirect to S3
```

### 5. Happy Scribe Webhook Handler
```
POST /webhooks/happyscribe
Headers: Authorization: Bearer <signature>
Body: { orderId, state, ... }
```

## Implementation Steps

1. **Add database schema** for orders and translations
2. **Add environment variables** to fly.toml and .env
3. **Create Happy Scribe service module**
   - Order creation
   - Status polling
   - Transcript export
   - Webhook handling
4. **Integrate with MediaConvert webhook**
   - After job completes, create HS order
5. **Add API endpoints**
   - Manual transcription trigger
   - Translation trigger
   - Status checking
   - Transcript download
6. **Add Frame.io integration** (optional)
   - Upload transcripts as annotations
   - Embed SRT subtitles in video metadata
7. **Testing**
   - Test with sample video
   - Verify webhook delivery
   - Check transcript quality

## Cost Considerations

### Happy Scribe Pricing (Typical)
- **Auto Transcription:** $0.10-0.25 per minute
- **Pro (Human):** $1-3 per minute
- **Translation:** $0.05-0.50 per minute translated text

### Example Costs
- 60-min video auto-transcription: ~$6-15
- 60-min video pro-transcription: ~$60-180
- Translation to 3 languages: ~$5-20 (depending on transcript length)

### Optimization
- Use "auto" service by default (fast, cheap)
- Offer "pro" service as upgrade option
- Implement optional translations only
- Cache transcripts to avoid re-processing

## Workflow Examples

### Scenario 1: Auto-Transcribe Standard Video
```
1. User uploads 30-min video via Filemail
2. User hits /process/transfer/{id}
3. MediaConvert job starts
4. MediaConvert completes (10 min later)
5. Webhook → Happy Scribe order created (auto service)
6. Happy Scribe transcribes (2-5 min)
7. Webhook → Transcript downloaded, stored
8. Frame.io receives video + optional subtitle track
```

### Scenario 2: Pro Transcription + Multi-Language
```
1. Video processed as above
2. Admin request: /translate/order/{hs_order_id}
   - targetLanguages: ["es", "fr"]
   - service: "pro"
3. Happy Scribe generates translations (24-48 hours)
4. Webhooks notify when ready
5. Download all transcripts and translations
6. Create subtitle tracks for Frame.io
```

### Scenario 3: Manual Transcription Only
```
1. Video processed without auto-transcription
2. Later, user requests: /transcribe/transfer/{id}?service=pro
3. Pro transcription starts (24-48 hours)
4. Admin notified when complete
5. Download and review transcript
```

## Frame.io Integration (Optional Future)

### Subtitle Track Upload
```javascript
// After HS transcript ready
const srtTranscript = await downloadTranscript(orderId, 'srt');
await uploadToFrameIO(projectId, assetId, srtTranscript, {
  language: 'en',
  label: 'English (Auto)',
  embedded: true
});
```

### Transcript as Comments/Annotations
- Import transcript as timeline comments
- Link timestamps to video scrubbing
- Enable searchable transcript UI in Frame.io

## Monitoring & Logging

```javascript
// Log transcription events
console.log(`✅ Happy Scribe order created: ${orderId}`);
console.log(`⏳ Transcribing: ${sourceUrl}`);
console.log(`💾 Memory: heap X.XXGB`);
console.log(`✅ Transcription ready: ${state}`);
```

## Security Considerations

1. **API Key:** Store in environment, never in code
2. **Signed URLs:** Verify Happy Scribe webhook signatures
3. **S3 Access:** Use pre-signed URLs for transcript downloads
4. **Rate Limiting:** Implement backoff for API calls
5. **Error Handling:** Graceful fallback if Happy Scribe unavailable

## Success Criteria

- [ ] Database schema created
- [ ] Happy Scribe API module implemented
- [ ] MediaConvert webhook integration working
- [ ] Manual transcription endpoint functional
- [ ] Transcript downloading and storage working
- [ ] Webhook handler receiving notifications
- [ ] Error handling and retries in place
- [ ] Translation creation and tracking working
- [ ] Tested with real video file
- [ ] Documented and ready for production

## Timeline

- **Phase 1 (Week 1):** Core integration + database + API endpoints
- **Phase 2 (Week 2):** MediaConvert webhook integration + testing
- **Phase 3 (Week 3):** Translations + Frame.io subtitle integration
- **Phase 4 (Week 4):** Monitoring, documentation, production ready

## Questions to Clarify

1. Should transcription be automatic or optional per transfer?
2. Which transcript formats do you need? (VTT, SRT, JSON, DOCX)
3. Should we offer pro (human) transcription as option?
4. Do you want multilingual transcription/translation?
5. Should transcripts be attached to Frame.io?
6. What webhook authentication method for Happy Scribe?

---

**Next Steps:** Review this plan and let me know which option you prefer, then I'll implement the core integration.
