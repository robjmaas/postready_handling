# MediaConvert Output Presets

Output presets are reusable MediaConvert configurations stored in S3 that include timecode settings, color grading (LUT), and codec parameters. Presets eliminate the need to specify encoding settings for each job.

## Quick Start: Using Custom Presets

### 1. Create a Custom Preset

```bash
curl -X POST https://postready-handling.fly.dev/api/presets \
  -H "Content-Type: application/json" \
  -d '{
    "name": "web-hd",
    "config": {
      "name": "web-hd",
      "description": "Web streaming optimized",
      "videoCodec": "H_264",
      "width": 1280,
      "height": 720,
      "framerateNumerator": 24,
      "framerateDenominator": 1,
      "rateControlMode": "QVBR",
      "maxBitrate": 4000000,
      "gopSize": 30,
      "subGopLength": 1,
      "timecodeInsertion": "PIC_TIMING_SEI",
      "colorConversion": "REC_709_TO_DCI_P3",
      "audioCodec": "AAC",
      "audioBitrate": 128000,
      "audioSampleRate": 48000,
      "container": "MP4"
    }
  }'
```

Response:
```json
{
  "success": true,
  "message": "✅ Preset created",
  "preset": {
    "presetName": "web-hd",
    "presetKey": "presets/web-hd.json",
    "size": 460
  }
}
```

### 2. Process a Transfer with the Custom Preset

```bash
curl -X POST https://postready-handling.fly.dev/process/transfer/{transferId} \
  -H "Content-Type: application/json" \
  -d '{"preset": "web-hd"}'
```

Example with test transfer:
```bash
curl -X POST https://postready-handling.fly.dev/process/transfer/subxciltxymhjhl \
  -H "Content-Type: application/json" \
  -d '{"preset": "web-hd"}'
```

Response:
```json
{
  "success": true,
  "message": "Transfer processing started",
  "transferId": "subxciltxymhjhl",
  "preset": "web-hd",
  "timestamp": "2026-01-10T09:10:00.000Z"
}
```

### 3. Verify Processing with Custom Preset

Check logs to see which preset was used:
```bash
flyctl logs -a postready-handling --no-tail 2>&1 | grep -E "Preset|Using preset"
```

Logs will show:
```
Using preset: web-hd
Loaded preset: web-hd
```

## API Endpoints

### List All Presets
```bash
GET /api/presets
```

Returns all available presets with metadata:
```json
{
  "success": true,
  "count": 2,
  "presets": [
    {
      "name": "default",
      "key": "presets/default.json",
      "size": 507,
      "modified": "2026-01-10T09:03:49.000Z"
    },
    {
      "name": "high-quality",
      "key": "presets/high-quality.json",
      "size": 460,
      "modified": "2026-01-10T09:04:32.000Z"
    }
  ]
}
```

### Get a Specific Preset
```bash
GET /api/presets/{name}
```

Example:
```bash
curl https://postready-handling.fly.dev/api/presets/default
```

Response:
```json
{
  "success": true,
  "name": "default",
  "preset": {
    "name": "default",
    "description": "MediaConvert preset with timecode, DCI-P3 color grading, and LUT support",
    "videoCodec": "H_264",
    "width": 1920,
    "height": 1080,
    "framerateNumerator": 30,
    "framerateDenominator": 1,
    "rateControlMode": "QVBR",
    "maxBitrate": 8000000,
    "gopSize": 30,
    "subGopLength": 1,
    "timecodeInsertion": "PIC_TIMING_SEI",
    "colorConversion": "REC_709_TO_DCI_P3",
    "audioCodec": "AAC",
    "audioBitrate": 128000,
    "audioSampleRate": 48000,
    "container": "MP4"
  }
}
```

### Create a New Preset
```bash
POST /api/presets
Content-Type: application/json
```

Request body:
```json
{
  "name": "preset-name",
  "config": {
    "name": "preset-name",
    "description": "Optional description",
    "videoCodec": "H_264",
    "width": 1920,
    "height": 1080,
    "framerateNumerator": 30,
    "framerateDenominator": 1,
    "rateControlMode": "QVBR",
    "maxBitrate": 8000000,
    "gopSize": 30,
    "subGopLength": 1,
    "timecodeInsertion": "PIC_TIMING_SEI",
    "colorConversion": "REC_709_TO_DCI_P3",
    "audioCodec": "AAC",
    "audioBitrate": 128000,
    "audioSampleRate": 48000,
    "container": "MP4"
  }
}
```

Example - Create 4K High-Quality Preset:
```bash
curl -X POST https://postready-handling.fly.dev/api/presets \
  -H "Content-Type: application/json" \
  -d '{
    "name": "4k-high-quality",
    "config": {
      "name": "4k-high-quality",
      "description": "Ultra HD with maximum quality",
      "videoCodec": "H_264",
      "width": 3840,
      "height": 2160,
      "framerateNumerator": 30,
      "framerateDenominator": 1,
      "rateControlMode": "QVBR",
      "maxBitrate": 20000000,
      "gopSize": 30,
      "subGopLength": 1,
      "timecodeInsertion": "PIC_TIMING_SEI",
      "colorConversion": "REC_709_TO_DCI_P3",
      "audioCodec": "AAC",
      "audioBitrate": 256000,
      "audioSampleRate": 48000,
      "container": "MP4"
    }
  }'
```

## Preset Configuration Options

| Parameter | Default | Description |
|-----------|---------|-------------|
| `videoCodec` | `H_264` | Video codec (H_264 or HEVC) |
| `width` | `1920` | Output width in pixels |
| `height` | `1080` | Output height in pixels |
| `framerateNumerator` | `30` | Framerate numerator (30/1 = 30fps) |
| `framerateDenominator` | `1` | Framerate denominator |
| `rateControlMode` | `QVBR` | Rate control (QVBR, CBR, VBR) |
| `maxBitrate` | `8000000` | Maximum bitrate in bits/second |
| `gopSize` | `30` | GOP size (keyframe interval) |
| `subGopLength` | `1` | Sub-GOP length |
| `timecodeInsertion` | `PIC_TIMING_SEI` | Timecode mode (DISABLED, PIC_TIMING_SEI) |
| `colorConversion` | `REC_709_TO_DCI_P3` | Color space conversion |
| `audioCodec` | `AAC` | Audio codec |
| `audioBitrate` | `128000` | Audio bitrate in bits/second |
| `audioSampleRate` | `48000` | Audio sample rate in Hz |
| `container` | `MP4` | Output container (MP4, MOV, MXF) |

## Preset Storage

All presets are stored in S3 at:
```
s3://postready-staging/presets/{preset-name}.json
```

Each preset file contains the full configuration as JSON.

## Example Presets

### Web Streaming (HD)
```json
{
  "name": "web-hd",
  "description": "Optimized for web streaming",
  "videoCodec": "H_264",
  "width": 1280,
  "height": 720,
  "framerateNumerator": 24,
  "framerateDenominator": 1,
  "rateControlMode": "QVBR",
  "maxBitrate": 4000000,
  "timecodeInsertion": "PIC_TIMING_SEI",
  "colorConversion": "REC_709_TO_DCI_P3",
  "audioCodec": "AAC",
  "audioBitrate": 128000,
  "audioSampleRate": 48000,
  "container": "MP4"
}
```

### Archive (Full Quality)
```json
{
  "name": "archive-4k",
  "description": "Archive-quality 4K with highest bitrate",
  "videoCodec": "HEVC",
  "width": 3840,
  "height": 2160,
  "framerateNumerator": 30,
  "framerateDenominator": 1,
  "rateControlMode": "QVBR",
  "maxBitrate": 25000000,
  "timecodeInsertion": "PIC_TIMING_SEI",
  "colorConversion": "REC_709_TO_DCI_P3",
  "audioCodec": "AAC",
  "audioBitrate": 320000,
  "audioSampleRate": 48000,
  "container": "MP4"
}
```

### Frame.io Default (1080p)
```json
{
  "name": "frameio-standard",
  "description": "Default Frame.io delivery preset",
  "videoCodec": "H_264",
  "width": 1920,
  "height": 1080,
  "framerateNumerator": 30,
  "framerateDenominator": 1,
  "rateControlMode": "QVBR",
  "maxBitrate": 8000000,
  "timecodeInsertion": "PIC_TIMING_SEI",
  "colorConversion": "REC_709_TO_DCI_P3",
  "audioCodec": "AAC",
  "audioBitrate": 128000,
  "audioSampleRate": 48000,
  "container": "MP4"
}
```

## Timecode Preservation

All presets include `"timecodeInsertion": "PIC_TIMING_SEI"` which:
- Preserves timecode from source video
- Embeds timecode in MP4 SEI (Supplemental Enhancement Information) atoms
- Allows Frame.io and other tools to read timecode metadata

## Color Grading (LUT)

All presets include `"colorConversion": "REC_709_TO_DCI_P3"` which:
- Converts color space from Rec.709 (broadcast) to DCI-P3 (cinema)
- Works with LUT files stored in S3
- Can be disabled by setting to empty string or "DISABLED"

## Usage in Production

1. **Create presets** for your different output scenarios:
   ```bash
   # Web delivery
   curl -X POST /api/presets -d '{"name":"web","config":{...}}'
   
   # Archive
   curl -X POST /api/presets -d '{"name":"archive","config":{...}}'
   ```

2. **Reference presets** when processing transfers (future enhancement)

3. **Modify presets** by creating new versions:
   ```bash
   curl -X POST /api/presets -d '{"name":"web-v2","config":{...}}'
   ```

4. **List all presets** to see available options:
   ```bash
   curl /api/presets
   ```

## Future Enhancement: Using Presets in Jobs

Presets will be integrated into the transfer processing workflow to allow specifying which preset to use for each transfer.
