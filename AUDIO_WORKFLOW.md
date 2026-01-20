# Option 1: Separate Audio Upload Workflow

## Current Status - Transfer jojrpvchsgijjku

✅ **Video Processing**: COMPLETE
- File: `A_0001C007_260105_162645_p1CJ5.mov` (4.59 MB)
- Status: Transcoded and stored in S3
- Output: `s3://postready-staging/outputs/tmp_mekqir17.mp4`
- Job ID: `1768907588721-16oogi`

⏳ **Audio File**: READY FOR UPLOAD
- File: `A-05-004T99.wav`
- Status: Detected but not yet uploaded to Frame.io
- Action: Manual upload via API endpoints

## Implementation: Separate Audio Workflow

This workflow keeps video and audio completely separate:

### Step 1: Upload Audio File to S3
```bash
curl -X POST https://postready-handling.fly.dev/audio/upload \
  -H "x-filename: A-05-004T99.wav" \
  --data-binary @A-05-004T99.wav
```

**Response:**
```json
{
  "success": true,
  "audioId": "audio_1234567890_abc",
  "filename": "A-05-004T99.wav",
  "s3Url": "s3://postready-staging/audio/audio_1234567890_abc_A-05-004T99.wav",
  "size": 245632
}
```

### Step 2: List Uploaded Audio Files
```bash
curl https://postready-handling.fly.dev/audio/list
```

**Response:**
```json
{
  "success": true,
  "count": 1,
  "audioFiles": [
    {
      "id": "audio_1234567890_abc",
      "filename": "A-05-004T99.wav",
      "s3Url": "s3://postready-staging/audio/audio_1234567890_abc_A-05-004T99.wav",
      "uploadedAt": "2026-01-20T11:15:00Z",
      "size": 245632
    }
  ]
}
```

### Step 3: Send Audio to Frame.io as Separate Asset
```bash
curl -X POST https://postready-handling.fly.dev/audio/{audioId}/upload-to-frameio
```

**Response:**
```json
{
  "success": true,
  "message": "Audio uploaded to Frame.io",
  "frameioAssetId": "asset_1234567890",
  "status": "uploading"
}
```

### Step 4: (Optional) Delete Audio from S3
```bash
curl -X DELETE https://postready-handling.fly.dev/audio/{audioId}
```

## Benefits of This Approach

✅ **Complete Control**: Upload audio independent of video processing
✅ **Flexible Timing**: Audio can be uploaded before, during, or after video processing
✅ **Multiple Formats**: Supports WAV, MP3, AAC, M4A, etc.
✅ **No Sync Issues**: Audio doesn't need timecode sync with video
✅ **Simpler Processing**: Video processing not dependent on audio availability
✅ **Frame.io Integration**: Separate assets for better organization

## Workflow for Transfers with Audio Files

1. **Get pending transfers**: `GET /inbox`
2. **Preview transfer**: `GET /preview/transfer/{id}` → identifies audio files in `skipped` array
3. **Process video**: `POST /process/transfer/{id}` → transcodes video files
4. **Download audio**: Download audio files from Filemail transfer
5. **Upload audio**: `POST /audio/upload` → stores in S3
6. **Send to Frame.io**: `POST /audio/{audioId}/upload-to-frameio` → creates separate asset

## API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/audio/upload` | Upload audio file to S3 storage |
| GET | `/audio/list` | List all uploaded audio files |
| POST | `/audio/{audioId}/upload-to-frameio` | Send audio to Frame.io |
| DELETE | `/audio/{audioId}` | Remove audio from storage |

## Notes

- **Timecode**: Not embedded in video (removed in recent update)
- **Audio Format Support**: WAV, MP3, AAC, M4A, OGG, FLAC
- **Frame.io**: Audio appears as separate asset in project
- **Storage**: Audio temporarily stored in S3, can be deleted after Frame.io upload
- **Size Limits**: S3 upload supports files up to 5GB

## To Complete jojrpvchsgijjku Transfer

1. Download `A-05-004T99.wav` from Filemail transfer
2. Run: `curl -X POST https://postready-handling.fly.dev/audio/upload -H "x-filename: A-05-004T99.wav" --data-binary @A-05-004T99.wav`
3. Save the `audioId` from response
4. Run: `curl -X POST https://postready-handling.fly.dev/audio/{audioId}/upload-to-frameio`
5. Audio will appear on Frame.io within 1-3 minutes

**Result**: Video + Audio both on Frame.io as separate assets
