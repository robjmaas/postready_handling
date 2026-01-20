## Postready — Copilot / AI agent instructions

Complete video processing pipeline: Filemail → Filemail (manual preview) → Coconut (transcoding) → Webhook → Frame.io (upload) + Wasabi (storage).

### Quick Start
```bash
node index.js  # Starts local-only server on http://127.0.0.1:3000
```

### Architecture Overview
- **Express.js** server (local-only, port 3000)
- **SQLite database** - tracks processed transfers and Coconut jobs
- **Filemail API** - fetches inbox transfers from "Strawberries" portal
- **Coconut API** - submits video transcoding jobs, receives webhooks
- **Frame.io API** - uploads completed videos to project
- **Wasabi S3** - stores transcoded MP4 files

### API Workflows

#### 1. View Pending Transfers
```bash
GET /inbox
```
Returns all pending Strawberries transfers ready for processing with file counts.
Response shows which are already processed vs pending.

#### 2. Preview Transfer Before Processing
```bash
GET /preview/transfer/{transferId}
```
Shows:
- Total files in transfer
- Video files to process (MP4, MOV, AVI, MKV, etc.)
- Non-video files to skip
- Download URLs for each video

Example:
```bash
curl http://127.0.0.1:3000/preview/transfer/erzvqthocijquce
```

#### 3. Manually Confirm & Process Transfer
```bash
POST /process/transfer/{transferId}
```
Marks transfer as processing, creates Coconut jobs for all video files.
Prevents duplicate Coconut submissions per file.

Example:
```bash
curl -X POST http://127.0.0.1:3000/process/transfer/erzvqthocijquce
```

#### 4. Monitor Coconut Jobs
Coconut automatically POSTs to:
```
POST /webhooks/coconut
```
- Receives job completion notifications
- Updates database with status/output URL
- Auto-uploads to Frame.io when complete
- Always returns 200 (won't retry)

#### 5. Manual Sync Wasabi → Frame.io
```bash
POST /sync/wasabi-frameio
```
Uploads all completed Coconut jobs (in Wasabi) to Frame.io.
Useful for re-syncing after Frame.io issues.

#### 6. Upload Audio Files to Frame.io (Separately)
```bash
POST /audio/upload
```
Upload audio files (WAV, MP3, AAC, etc.) to storage.
Headers: `x-filename: audiofile.wav`
Body: binary audio file data

Returns: `{ audioId, filename, s3Url, size }`

Then upload to Frame.io:
```bash
POST /audio/{audioId}/upload-to-frameio
```
Uploads the audio file as a separate Frame.io asset.

List uploaded audio:
```bash
GET /audio/list
```

Delete audio:
```bash
DELETE /audio/{audioId}
```

### Database Management

#### View Stats
```bash
GET /db/stats
```
Shows: processed_transfers, total_jobs, completed_jobs, failed_jobs, processing_jobs

#### View All Processed Transfers
```bash
GET /db/transfers
```

#### View All Coconut Jobs
```bash
GET /db/jobs
```

#### View Jobs for Specific Transfer
```bash
GET /db/jobs/{transferId}
```

#### Remove Transfer (Allow Reprocessing)
```bash
DELETE /db/transfer/{transferId}
```
Deletes transfer from processed list, allows re-processing.

#### Remove Specific Job
```bash
DELETE /db/job/{jobId}
```

#### Clear All Database
```bash
DELETE /db/clear
```
⚠️ Dangerous - clears all processed transfers and jobs

#### Remove Cube LUT (Disable Color Grading)
```bash
DELETE /db/settings/lut
```
Removes the LUT - subsequent videos will be processed without color grading.

### Environment Variables (.env)
```
FILEMAIL_API_KEY=your_filemail_key
COCONUT_API_KEY=your_coconut_key
FRAMEIO_TOKEN=your_frameio_token
FRAMEIO_PROJECT_ID=your_project_id
PORT=3000
DEPLOYMENT_URL=https://postready-handling.fly.dev

# Optional: Cube LUT for color grading
CUBE_LUT_URL=https://example.com/path/to/your_lut.cube
```

### Color Grading with Cube LUT

To apply a cube LUT (color grade) to all processed videos:

**Option 1: Use Remote URL**

1. Upload your `.cube` LUT file to a web-accessible URL
2. Set the `CUBE_LUT_URL` environment variable:
   ```
   CUBE_LUT_URL=https://example.com/my_color_grade.cube
   ```
3. All videos will now be processed with the LUT applied

**Option 2: Upload Local Cube File**

1. Upload a `.cube` file via API:
   ```bash
   curl -X POST http://127.0.0.1:3000/lut/upload \
     -H "x-filename: my_color_grade.cube" \
     --data-binary @my_color_grade.cube
   ```

2. List available cube files:
   ```bash
   curl http://127.0.0.1:3000/lut/list
   ```

3. Delete a cube file:
   ```bash
   curl -X DELETE http://127.0.0.1:3000/lut/my_color_grade.cube
   ```

**Supported LUT formats:** `.cube` files (3D LUT format)

**Example LUT files:**
- Rec.709 to DCI-P3
- Log to Rec.709 color space conversions
- Creative color grades (vintage, cinema, etc.)

### Processing Flow

1. **Check Inbox**: `GET /inbox` → see pending Strawberries transfers
2. **Preview**: `GET /preview/transfer/{id}` → review video files and count
3. **Confirm**: `POST /process/transfer/{id}` → submit to MediaConvert
4. **Wait**: MediaConvert transcodes and POSTs webhook when done
5. **Auto-Upload**: Frame.io receives video from S3 via webhook
6. **Verify**: `GET /db/jobs/{transferId}` → check job status

### Key Features

- ✅ **Portal Filtering**: Only processes "Strawberries" portal transfers
- ✅ **Video-Only**: Skips non-video files (docs, images, etc.)
- ✅ **Deduplication**: Prevents duplicate job submission per file
- ✅ **Manual Approval**: No auto-processing, explicit `/process` endpoint required
- ✅ **Database Tracking**: SQLite persists all transfers and job statuses
- ✅ **Frame.io Integration**: Auto-uploads transcoded videos with clean filenames
- ✅ **AWS MediaConvert**: Direct job submission with full encoding control
- ✅ **Color Grading**: REC.709 → DCI-P3 color space conversion for professional output
- ✅ **Timecode Support**: Embeds timecode in video + visual burnin overlay
- ✅ **S3 Cleanup**: Removes temp prefixes from filenames before Frame.io upload
- ✅ **Local-Only**: Server bound to 0.0.0.0:3000 for cloud deployment

### File Extensions Supported
`.mp4` `.mov` `.avi` `.mkv` `.flv` `.wmv` `.webm` `.m4v` `.3gp` `.ogv` `.ts` `.m2ts` `.mts` `.vob` `.rm` `.rmvb` `.divx` `.xvid` `.mxf`

### Database Schema

**processed_transfers**
```
id TEXT PRIMARY KEY
created_at DATETIME
status TEXT ('processing', 'completed', etc.)
```

**coconut_jobs**
```
id TEXT PRIMARY KEY
transfer_id TEXT (foreign key)
filename TEXT
status TEXT ('pending', 'completed', 'failed')
output_url TEXT (Wasabi MP4 URL)
created_at DATETIME
completed_at DATETIME
error TEXT
```

### Code Patterns

- **ES Modules**: `import`/`export` (no CommonJS)
- **Async/Await**: All async operations use async/await
- **Error Handling**: Functions throw on API errors, catch at endpoint level
- **Logging**: Console.log for debugging, includes emoji prefixes for clarity
- **Database**: Use `await db.get()`, `db.all()`, `db.run()` from `sqlite` package

### Integration Details

**Filemail API**
- Endpoint: `https://api-public.filemail.com/transfer/{transferId}`
- Header: `x-api-key: {key}`, `x-api-version: 2.0`
- Returns: `{ data: { files: [...] } }`

**Coconut API**
- Endpoint: `https://api-us-west-2.coconut.co/v2/jobs`
- Auth: Basic auth with `{apiKey}:`
- Outputs: `{ output: { mp4: { url: "..." } } }`

**Frame.io API**
- Endpoint: `https://api.frame.io/v2/projects/{projectId}/assets`
- Auth: Bearer token
- Accepts: JSON with `{ name, source: { type: "url", url: "..." } }`

**Wasabi S3**
- Bucket: `strawberries`
- Region: `eu-central-1`
- Files uploaded by Coconut as: `/{filename}.mp4`

### Extending the Code

To add features:
1. Add new Express route with `app.get()`, `app.post()`, etc.
2. Update database schema in `initDb()` if needed
3. Follow existing error handling pattern: try/catch, return 200 on errors when appropriate
4. Add descriptive console.log with emoji prefix
5. Commit and push to trigger GitHub Actions deployment

### Recent Fixes & Enhancements

**Frame.io Filename Cleanup**
- Removes S3 staging temp prefixes (`tmp_<prefix>_`) from filenames before uploading to Frame.io
- Results in clean, readable filenames in Frame.io instead of `tmp_abc123_originalname.mp4`
- Applied in webhook handler before Frame.io upload

**LUT File Verification**
- Checks on startup that `Awsome1.cube` exists in `s3://postready-staging/Awsome1.cube`
- Logs file size if found
- Warns if missing and notes videos will process without color grading
- Prevents silent LUT failures during job execution

**AWS Job Templates**
- Switched from custom S3-stored presets to AWS MediaConvert Job Templates
- Postready template includes: 1280×720, 2 Mbps QVBR, MP4, AAC 96kbps, REC_709→DCI-P3 LUT
- Templates managed via `/api/job-templates` endpoints
- Auto-recreated on deployment to ensure latest settings

### Audio Upload to Frame.io (Separate Assets)

Upload audio files independently and send them to Frame.io as separate assets (no timecode sync):

```bash
# 1. Upload audio file
curl -X POST http://127.0.0.1:3000/audio/upload \
  -H "x-filename: interview.wav" \
  --data-binary @interview.wav

# Get audioId from response (e.g., audio_1234567890_abc)

# 2. Send audio to Frame.io as separate asset
curl -X POST http://127.0.0.1:3000/audio/audio_1234567890_abc/upload-to-frameio

# 3. List uploaded audio files
curl http://127.0.0.1:3000/audio/list

# 4. Delete audio file
curl -X DELETE http://127.0.0.1:3000/audio/audio_1234567890_abc
```

Audio files are stored in S3 and can be sent to Frame.io individually. Each audio file appears as a separate asset in the Frame.io project.

### When to Ask for Help

- Coconut API response format changes
- Filemail portal names/custom field structure
- Frame.io project configuration
- Wasabi bucket credentials or region
- Adding new external integrations
