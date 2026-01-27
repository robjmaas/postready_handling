# Testing 12GB File Upload - Stream Backpressure Fix

## Deployment Status ✅

**App:** https://postready-handling.fly.dev  
**Status:** Running  
**Last Deploy:** 2026-01-26 19:31:35  
**Commit:** b048abe (Stream backpressure fix for large files)

## Testing Plan

### Option 1: Test with Actual Strawberries Transfer (Recommended)

**If you have a pending 12GB file in Filemail:**

```bash
# 1. View pending transfers
curl https://postready-handling.fly.dev/inbox

# 2. Find a transfer with 12GB+ video file
# Look for transfer ID with large fileSize

# 3. Preview the transfer
TRANSFER_ID="your_transfer_id_here"
curl https://postready-handling.fly.dev/preview/transfer/$TRANSFER_ID

# 4. Start processing (this triggers the streaming upload)
curl -X POST https://postready-handling.fly.dev/process/transfer/$TRANSFER_ID

# 5. Monitor in real-time
# Watch logs for:
#   - "📥 Download progress: X.XXGB / 12.00GB"
#   - "💾 Memory: heap X.XGB / Y.YGB, external ZZZM, queue size: N"
#   - "✅ S3 UPLOAD COMPLETE"
flyctl logs --no-tail
```

### Option 2: Simulate 12GB Upload Locally (Testing)

Create a 12GB dummy file and test locally:

```bash
# Create a 12GB sparse file (instant creation, doesn't use actual disk space initially)
dd if=/dev/zero of=/tmp/test_12gb.bin bs=1G count=12

# Test stageFileToS3 with local HTTP server
# (This would require more setup - see Option 1 instead)
```

### Option 3: Test Specific Transfer from Command Line

```bash
# Get list of transfers in database
curl https://postready-handling.fly.dev/db/transfers

# Process a specific transfer
curl -X POST https://postready-handling.fly.dev/process/transfer/YOUR_TRANSFER_ID

# Check job status
curl https://postready-handling.fly.dev/db/jobs/YOUR_TRANSFER_ID
```

## What to Monitor During Upload

### Real-time Logs
```bash
# Terminal 1: Stream logs
flyctl logs

# You should see:
# ✅ [Step 1/3] Staging video to S3...
# 📊 File size: 12.00 GB
# 💾 Memory: heap 0.45GB / 4.00GB, external 125MB, queue size: 8
# 💾 Memory: heap 0.48GB / 4.00GB, external 128MB, queue size: 12
# 📥 Download progress: 2.50GB / 12.00GB (20.8%)
# 📥 Download progress: 5.00GB / 12.00GB (41.7%)
# 📥 Download progress: 7.50GB / 12.00GB (62.5%)
# ✅ Downloaded: 12.00 GB in 15.3 min
# 📤 Completing S3 upload... (2400 parts)
# ✅ S3 UPLOAD COMPLETE: s3://postready-staging/staging/tmp_xyz...
# ✅ API response received
# ✅ MediaConvert job created: 1234567890
```

### Key Success Indicators

1. **Memory stays bounded** (~0.5-1GB even for 12GB files)
2. **Queue size stays manageable** (5-20 chunks, not thousands)
3. **Steady progress** (logs every 10-30 seconds, no freezing)
4. **No errors** (Part upload retries work if network hiccups)
5. **Completes successfully** (S3 upload completes, MediaConvert job created)

### Performance Metrics

Expected timing for 12GB file:
- Download: 10-30 minutes (depends on Filemail CDN speed)
- S3 upload: Parallel with download (streaming multipart)
- Total: 10-30 minutes for complete S3 staging
- MediaConvert job: ~5-15 minutes (1280x720 QVBR)

## Troubleshooting

### If memory usage grows too high (> 2GB heap)
- Check `queue size` in logs - should stay < 30
- If queue grows unbounded, backpressure isn't working
- Contact support with logs

### If upload times out
- Check network connectivity to Filemail and AWS S3
- Timeout is set to 2 hours (120 min) - plenty for large files
- If still timing out, may indicate network issue

### If part uploads fail
- Code retries 3x automatically
- If all 3 retries fail, entire upload aborts
- Check AWS credentials and S3 permissions
- Check logs for error messages

### If S3 completion fails
- Multipart upload is aborted
- No orphaned parts left in S3
- Can retry the transfer

## Testing Checklist

- [ ] App deployed and responding to health checks
- [ ] Can view inbox transfers (`GET /inbox`)
- [ ] Can preview transfers (`GET /preview/transfer/{id}`)
- [ ] Can start processing (`POST /process/transfer/{id}`)
- [ ] Process starts in background (returns immediately)
- [ ] Monitor memory usage stays < 2GB
- [ ] Queue size stays < 30
- [ ] S3 upload completes successfully
- [ ] MediaConvert job created and processing
- [ ] Progress logs visible every 10-30 seconds

## Expected Behavior

1. **Immediate Response** (< 1 second)
   - API returns 200 with message "Transfer processing started in background"
   
2. **Download Phase** (10-30 minutes)
   - File downloads from Filemail in chunks
   - Chunks queued and uploaded to S3 as multipart upload
   - Progress logs every 10 seconds
   
3. **S3 Upload Completion** (automatic)
   - Final chunks uploaded
   - Multipart upload completed
   - Returns s3://postready-staging/staging/tmp_xyz
   
4. **MediaConvert Job** (automatic)
   - Job created immediately after S3 staging
   - Processing starts (5-15 minutes typical)
   - Webhook notification when complete
   - Auto-uploaded to Frame.io

## Real-Time Monitoring

```bash
# Open multiple terminals:

# Terminal 1: Tail logs (follows new entries)
flyctl logs

# Terminal 2: Poll job status every 5 seconds
watch -n 5 'curl -s https://postready-handling.fly.dev/db/jobs/YOUR_TRANSFER_ID | jq .'

# Terminal 3: Check S3 staging status
while true; do
  aws s3 ls s3://postready-staging/staging/ --recursive --human-readable | tail -5
  sleep 10
done
```

## Next Steps After Successful Test

1. **Performance Tuning** (if needed)
   - Adjust chunk queue size (currently 20 chunks = ~10MB)
   - Adjust part size (currently 5MB per S3 part)
   - Monitor real-world performance

2. **Production Validation**
   - Test with various file sizes (1GB, 5GB, 12GB, 50GB)
   - Monitor memory under sustained load
   - Verify Frame.io uploads work correctly

3. **Error Recovery**
   - Test network interruption during upload
   - Test part retry logic
   - Test abort/cleanup on error

---

**Questions or issues?** Check [LARGE_FILE_FIX.md](LARGE_FILE_FIX.md) for technical details.
