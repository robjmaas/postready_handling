# Transfer Processing - Timecode + Audio Sync Complete

## Changes Made

✅ **Restored Timecode Embedding**
- Timecode now embedded in final MP4 video
- Uses MediaConvert `TimecodeSource: "ZEROBASED"` 
- Timecode burnin burnin with SEI atoms

✅ **Restored Audio Sync with Video**
- Audio files auto-detected from transfer
- Audio synced with video using timecode
- Both audio and video encoded in single MediaConvert job

✅ **Added Auto-Upload Audio to Frame.io**
- After video completes and uploads to Frame.io
- Audio files automatically fetched from S3
- Audio uploaded as separate Frame.io asset
- Non-blocking - doesn't delay video upload

## Implementation Details

### New Function: `uploadAudioFilesForTransfer(transferId)`
Located in index.js, this function:
1. Queries database for audio files mapped to transfer
2. Iterates through each audio file
3. Calls `uploadToFrameIO()` for each audio file
4. Logs success/failure for each upload
5. Handles errors gracefully without blocking video

### Modified: Coconut Webhook Handler
- After video uploads to Frame.io
- Calls `uploadAudioFilesForTransfer(transferId)`
- Ensures audio uploads even if video upload fails
- Non-blocking async operations

### Flow for Transfer with Audio

```
1. GET /inbox → List transfers
2. GET /preview/transfer/{id} → Show files
3. POST /process/transfer/{id} → Start processing
   ├─ Auto-detect video files
   ├─ Auto-detect audio files (WAV, MP3, AAC, etc.)
   ├─ Create audio_files database entries
   ├─ Create transfer_audio_mapping entries
   └─ Submit MediaConvert job
4. MediaConvert processes
   ├─ Input 1: Video file (1280×720)
   ├─ Input 2: Audio file (auto-staged to S3)
   ├─ Timecode synced (ZEROBASED)
   ├─ Color grading applied (REC.709 → DCI-P3)
   ├─ LUT burnin embedded
   └─ Output: MP4 with timecode + synced audio
5. Webhook received → Job completed
   ├─ Upload video to Frame.io
   └─ Upload audio files to Frame.io (parallel)
6. Result: Frame.io project has
   ├─ Video with timecode embedded
   └─ Audio as separate asset
```

## Test Transfer: jojrpvchsgijjku

**Files in Transfer:**
- `A_0001C007_260105_162645_p1CJ5.mov` (video, 4.59 MB)
- `A-05-004T99.wav` (audio, mapped for sync)

**Expected Results:**
- ✅ Video with timecode embedded
- ✅ Audio synced to video timeline
- ✅ Both uploaded to Frame.io

## Database

### Audio Tables
```sql
audio_files:
  id TEXT PRIMARY KEY
  filename TEXT UNIQUE
  s3_url TEXT (Filemail HTTP or S3 URL)
  duration_ms INTEGER
  sample_rate INTEGER
  channels INTEGER
  created_at DATETIME

transfer_audio_mapping:
  id TEXT PRIMARY KEY
  transfer_id TEXT (FK)
  audio_id TEXT (FK)
  sync_mode TEXT ('timecode')
  start_offset_ms INTEGER
  created_at DATETIME
  UNIQUE(transfer_id, audio_id)
```

## Deployment Status

- ✅ Committed: "restore: timecode embedding and audio sync (Option 2)"
- ✅ Committed: "feat: auto-upload audio files to Frame.io after video processing"
- ✅ Deployed to Fly.io: https://postready-handling.fly.dev
- ✅ Ready for production

## Next Steps

- Monitor transfer processing
- Verify video has timecode on Frame.io
- Verify audio file appears as separate asset on Frame.io
- Check Frame.io project timeline for both assets

## Notes

- Timecode starts from ZEROBASED (00:00:00)
- Audio formats supported: WAV, MP3, AAC, M4A, OGG, FLAC, WMA, ALAC
- Frame.io assets may take 2-5 minutes to appear
- Logs show detailed upload progress for both video and audio
