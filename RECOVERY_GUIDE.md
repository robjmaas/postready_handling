# Recovery Guide: MediaConvert Output File Discovery Fix

## Problem
Frame.io was receiving 317-byte files instead of full transcoded videos because:
- MediaConvert jobs were completing successfully
- But output files were NOT being found in S3
- HeadObject returned 404 NotFound for expected filename
- Presigned URLs generated but pointed to non-existent files

## Root Cause
1. **MediaConvert naming issue**: The output file naming was different than expected
   - Expected: `outputs/A_0001C016_260106_175203_p1CJ5_mxf.mp4`
   - Actual: `outputs/tmp_v1ebm7aoA_0001C016_260106_175203_p1CJ5_mxf.mp4`
   - The staging temp prefix was being prepended to the filename

2. **Code not listing S3 folder**: The polling function was only trying HeadObject on the reported path, not dynamically discovering actual files

3. **Missing import**: `ListObjectsV2Command` was not imported from `@aws-sdk/client-s3`

## Solution (Applied Commits)

### 1. Add Missing Import
**File**: `index.js` line 13

Change:
```javascript
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, CreateBucketCommand } from "@aws-sdk/client-s3";
```

To:
```javascript
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, CreateBucketCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
```

### 2. Update Polling Function to List S3
**File**: `index.js` in `pollPendingMediaConvertJobs()` function (~line 2430)

Replace the simple HeadObject check with dynamic S3 folder listing:

```javascript
if (outputUrl) {
  console.log(`   Output: ${outputUrl}`);
  console.log(`   Output URL type: ${outputUrl.startsWith("s3://") ? "S3 path" : "HTTPS URL"}`);
  
  // Don't trust MediaConvert's reported output path - list S3 folder to find actual file
  let actualS3Key = null;
  try {
    console.log(`   🔄 Listing S3 outputs folder to find actual file...`);
    const listCommand = new ListObjectsV2Command({
      Bucket: "postready-staging",
      Prefix: "outputs/"
    });
    const listResult = await awsS3Client.send(listCommand);
    console.log(`   ✅ Found ${listResult.Contents?.length || 0} files in S3 outputs/`);
    
    if (listResult.Contents && listResult.Contents.length > 0) {
      // Get the most recently modified file
      const sortedByTime = listResult.Contents
        .filter(obj => obj.Key.endsWith(".mp4"))
        .sort((a, b) => (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0));
      
      if (sortedByTime.length > 0) {
        actualS3Key = sortedByTime[0].Key.replace("outputs/", "");
        const sizeInMB = (sortedByTime[0].Size / 1024 / 1024).toFixed(2);
        console.log(`   📊 Most recent file: ${actualS3Key} (${sizeInMB} MB, modified: ${sortedByTime[0].LastModified})`);
      }
    }
  } catch (listErr) {
    console.error(`❌ Error listing S3:`, listErr.message);
  }
  
  // Use actual file if found, otherwise try reported path
  if (actualS3Key) {
    console.log(`   ✅ Using actual S3 file: outputs/${actualS3Key}`);
    outputUrl = `s3://postready-staging/outputs/${actualS3Key}`;
    // [verify file size code...]
  } else {
    // [fallback code...]
  }
}
```

## Testing Recovery

1. **Process a test transfer**:
```bash
curl -s -X DELETE "https://postready-handling.fly.dev/db/transfer/subxciltxymhjhl" 
sleep 2
curl -s -X POST "https://postready-handling.fly.dev/process/transfer/subxciltxymhjhl"
```

2. **Monitor logs for S3 discovery**:
```bash
sleep 180  # Wait for MediaConvert to complete
flyctl logs -a postready-handling --no-tail 2>&1 | grep -E "Most recent file|Found.*files in S3"
```

3. **Expected output**:
```
   ✅ Found 35 files in S3 outputs/
   📊 Most recent file: tmp_v1ebm7aoA_0001C016_260106_175203_p1CJ5_mxf.mp4 (4.67 MB, ...)
   ✅ Using actual S3 file: outputs/tmp_v1ebm7aoA_0001C016_260106_175203_p1CJ5_mxf.mp4
```

4. **Verify Frame.io received full video**:
   - Check Frame.io project for asset with correct file size (should be ~4.67 MB)
   - NOT 317 bytes

## Key Commits
- `c2e9336`: Add missing ListObjectsV2Command import
- `9a01933`: Add S3 folder listing to polling function
- `1b77db6`: Add detailed logging to MediaConvert webhook

## Why This Works

1. **Dynamic discovery**: Lists all files in `outputs/` folder instead of guessing filename
2. **Most recent file**: Sorts by modification time to find the newly completed file
3. **Resilient**: Falls back to reported path if listing fails
4. **Debugging**: Shows actual files found and sizes, so we can see if MediaConvert created anything

## If It Breaks Again

Check these things in order:
1. Does `ListObjectsV2Command` appear in the logs? If not, check the import
2. Are files appearing in S3 at all? Look for "📂 S3 outputs folder" logs
3. Is the file size > 100KB? If < 100KB, MediaConvert may have failed
4. Is the presigned URL being created? Look for "✅ Presigned URL created"
5. Is Frame.io receiving the file? Check Frame.io asset properties in the web UI

## Debug Commands

```bash
# Check what files are in S3 outputs folder
flyctl logs -a postready-handling --no-tail 2>&1 | grep "Most recent file" | tail -3

# Check if MediaConvert completed
flyctl logs -a postready-handling --no-tail 2>&1 | grep "MediaConvert job completed" | tail -3

# Check for S3 listing errors
flyctl logs -a postready-handling --no-tail 2>&1 | grep "Error listing S3" | tail -3

# Check Frame.io upload status
flyctl logs -a postready-handling --no-tail 2>&1 | grep "Frame.io" | tail -10
```
