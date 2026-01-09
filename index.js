// node /Users/robmaas/Desktop/iMac/Projects/postready_handling/index
import fetch from "node-fetch";
import express from "express";
import dotenv from "dotenv";
import coconut from "coconutjs";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import fs from "fs";
import path from "path";
import { execSync, spawn } from "child_process";
import https from "https";
import http from "http";
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, CreateBucketCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import { MediaConvertClient, CreateJobCommand, GetJobCommand } from "@aws-sdk/client-mediaconvert";

dotenv.config({ quiet: true });   // <— no output

// Create luts directory if it doesn't exist
const lutsDir = "./luts";
if (!fs.existsSync(lutsDir)) {
  fs.mkdirSync(lutsDir, { recursive: true });
}

/* ==================== ENVIRONMENT VARIABLES ==================== */
const PORT = process.env.PORT || 3000;
const DEPLOYMENT_URL = process.env.DEPLOYMENT_URL || "https://postready-handling.fly.dev";
const FILEMAIL_API_KEY = process.env.FILEMAIL_API_KEY || "";
const COCONUT_API_KEY = process.env.COCONUT_API_KEY || "";
const FRAMEIO_TOKEN = process.env.FRAMEIO_TOKEN || "";
const FRAMEIO_PROJECT_ID = process.env.FRAMEIO_PROJECT_ID || "";
const CUBE_LUT_URL = process.env.CUBE_LUT_URL || "";
const COCONUT_WEBHOOK_URL = `${DEPLOYMENT_URL}/webhooks/coconut`;
const MEDIACONVERT_WEBHOOK_URL = `${DEPLOYMENT_URL}/webhooks/mediaconvert`;

// MediaConvert settings
const TRANSCODE_SERVICE = process.env.TRANSCODE_SERVICE || "coconut";  // "coconut" or "mediaconvert"
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const AWS_MEDIACONVERT_ROLE = process.env.AWS_MEDIACONVERT_ROLE || "";  // IAM role ARN for MediaConvert
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || "";
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || "";

// AWS S3 client (for MediaConvert staging and output)
const awsS3Client = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY
  }
});

// Cache for Frame.io dailies folder ID (to avoid creating it repeatedly)
let frameIODailiesFolderId = null;

// MediaConvert client (initialized if credentials available)
let mediaConvertClient = null;
if (AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY && TRANSCODE_SERVICE === "mediaconvert") {
  mediaConvertClient = new MediaConvertClient({
    region: AWS_REGION,
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY
    }
  });
  console.log(`✅ MediaConvert client initialized (region: ${AWS_REGION}, role: ${AWS_MEDIACONVERT_ROLE || 'NOT SET'})`);
} else {
  console.error(`❌ MediaConvert NOT initialized:`);
  console.error(`   AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID ? '✅ SET' : '❌ MISSING'}`);
  console.error(`   AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY ? '✅ SET' : '❌ MISSING'}`);
  console.error(`   TRANSCODE_SERVICE: ${TRANSCODE_SERVICE}`);
  console.error(`   AWS_MEDIACONVERT_ROLE: ${AWS_MEDIACONVERT_ROLE || '❌ MISSING'}`);
}

// Test AWS S3 bucket access on startup (optional - staging will try anyway)
async function testS3BucketAccess() {
  try {
    const headBucketCommand = new HeadBucketCommand({
      Bucket: "postready-staging"
    });
    await awsS3Client.send(headBucketCommand);
    console.log(`✅ AWS S3 bucket 'postready-staging' is accessible`);
  } catch (err) {
    // Don't fail startup - staging will attempt to create/use bucket anyway
    console.warn(`⚠️  S3 bucket 'postready-staging' may not be accessible: ${err.message}`);
    console.warn(`   MediaConvert staging may still work if AWS credentials are valid`);
  }
}

/* ==================== DATABASE SETUP ==================== */
let db;

// Initialize database
async function initDb() {
  db = await open({
    filename: "processed_transfers.db",
    driver: sqlite3.Database
  });

  // Create table for tracking processed transfers
  await db.exec(`
    CREATE TABLE IF NOT EXISTS processed_transfers (
      id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'processing'
    );
    
    CREATE TABLE IF NOT EXISTS coconut_jobs (
      id TEXT PRIMARY KEY,
      transfer_id TEXT,
      filename TEXT,
      status TEXT DEFAULT 'pending',
      output_url TEXT,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      error TEXT,
      FOREIGN KEY(transfer_id) REFERENCES processed_transfers(id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Add metadata column if it doesn't exist (for S3 staging key storage)
  try {
    await db.exec("ALTER TABLE coconut_jobs ADD COLUMN metadata TEXT;");
    console.log("✅ Added metadata column to coconut_jobs table");
  } catch (err) {
    if (!err.message.includes("duplicate column")) {
      console.warn(`⚠️  Migration warning: ${err.message}`);
    }
  }

  // Initialize default settings
  await db.run(
    "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
    ["cube_lut_url", CUBE_LUT_URL || ""]
  );
}

/**
 * Check if a transfer has already been processed
 */
async function isTransferProcessed(transferId) {
  const row = await db.get("SELECT id FROM processed_transfers WHERE id = ?", [transferId]);
  return row !== undefined;
}

/**
 * Mark a transfer as processed
 */
async function markTransferProcessed(transferId) {
  await db.run("INSERT OR IGNORE INTO processed_transfers (id, status) VALUES (?, ?)", [transferId, "processing"]);
}

/**
 * Check if a job already exists for this transfer and filename
 */
async function jobExists(transferId, filename) {
  const row = await db.get(
    "SELECT id FROM coconut_jobs WHERE transfer_id = ? AND filename = ?",
    [transferId, filename]
  );
  return row !== undefined;
}

// Initialize database on startup
await initDb();
await testS3BucketAccess();

const app = express();
app.use(express.json());

// Health check endpoint for deployment
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Ping endpoint for webhook verification
app.get("/webhooks/coconut", (req, res) => {
  res.status(200).json({ 
    status: "ok", 
    webhook: "coconut",
    ready: true,
    message: "POST a Coconut job webhook to this endpoint"
  });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  const isLocal = process.env.NODE_ENV !== "production";
  if (isLocal) {
    console.log("⚠️  Local mode - accessible from localhost only");
  } else {
    console.log(`🚀 Cloud deployment - accessible at ${DEPLOYMENT_URL}`);
  }
});

// Debug: Log loaded API keys on startup
console.log("🔍 Checking environment variables on startup:");
console.log(`   - FILEMAIL_API_KEY: ${FILEMAIL_API_KEY ? '✅ SET' : '❌ MISSING'}`);
console.log(`   - COCONUT_API_KEY: ${COCONUT_API_KEY ? '✅ SET' : '❌ MISSING'}`);
console.log(`   - FRAMEIO_TOKEN: ${FRAMEIO_TOKEN ? '✅ SET' : '❌ MISSING'}`);
console.log(`   - FRAMEIO_PROJECT_ID: ${FRAMEIO_PROJECT_ID ? '✅ SET' : '❌ MISSING'}`);
console.log(`   - CUBE_LUT_URL: ${CUBE_LUT_URL ? '✅ SET (color grading enabled)' : '⚪ NOT SET (optional)'}`);
console.log(`   - TRANSCODE_SERVICE: ${TRANSCODE_SERVICE}`);
console.log(`   - AWS_REGION: ${AWS_REGION}`);
console.log(`   - AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID ? '✅ SET' : '❌ MISSING'}`);
console.log(`   - AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY ? '✅ SET' : '❌ MISSING'}`);
console.log(`   - AWS_MEDIACONVERT_ROLE: ${AWS_MEDIACONVERT_ROLE ? '✅ SET' : '❌ MISSING'}`);

if (!FILEMAIL_API_KEY) {
  console.warn("⚠️  WARNING: FILEMAIL_API_KEY is not set - make sure FLY_API_TOKEN is set in GitHub Secrets!");
}
if (!COCONUT_API_KEY) {
  console.warn("⚠️  WARNING: COCONUT_API_KEY is not set!");
}

/**
 * Get all inbox transfers from Filemail
 */
export async function getInboxTransfers() {
  const url = "https://api-public.filemail.com/transfer/inbox";

  if (!FILEMAIL_API_KEY) {
    throw new Error("FILEMAIL_API_KEY environment variable is not set. Please set it via: flyctl secrets set FILEMAIL_API_KEY=your_key");
  }

  const res = await fetch(url, {
    method: "GET",
    headers: {
        "x-api-key": FILEMAIL_API_KEY,
        "x-api-version": 2.0
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Filemail API error: ${res.status} - ${text}`);
  }

  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
  return data; // array of transfers
}

// Start fetching transfers asynchronously after server is ready
server.on("listening", () => {
  console.log("Server is ready");
  console.log("⚠️  Auto-processing disabled - use /api/process to manually trigger transfers");
  // Auto-processing disabled - use /api/process endpoint instead
});

/* ==================== 1. GET FILES FROM FILEMAIL ==================== */

async function getFilemailFiles(transferId) {
  const res = await fetch(
    `https://api-public.filemail.com/transfer/${transferId}`,
    {
      headers: {
        "x-api-key": FILEMAIL_API_KEY,
        "x-api-version": "2.0"
      }
    }
  );

  if (!res.ok) {
    const errorText = await res.text();
    console.error(`Filemail API error: ${res.status} ${res.statusText}`);
    console.error(`Response: ${errorText}`);
    throw new Error(`Filemail request failed: ${res.status} ${errorText}`);
  }

  const data = await res.json();
  console.log(`✅ Filemail API response: ${data.data.files.length} files found`);

  return data.data.files;
}

/* ==================== 4. PROCESS A FILEMAIL TRANSFER ==================== */

/**
 * Check if a file is a video file
 */
function isVideoFile(filename) {
  const videoExtensions = ['.mp4', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.webm', '.m4v', '.3gp', '.ogv', '.ts', '.m2ts', '.mts', '.vob', '.rm', '.rmvb', '.divx', '.xvid', '.mxf'];
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
  return videoExtensions.includes(ext);
}

async function processFilemailTransfer(transferId) {
  try {
    console.log("Processing Filemail transfer:", transferId);
    console.log(`📡 Using transcode service: ${TRANSCODE_SERVICE.toUpperCase()}`);
    console.log("Fetching Filemail files...");
    const files = await getFilemailFiles(transferId);

    // Filter to video files only
    const videoFiles = files.filter(f => isVideoFile(f.filename));
    
    // Show summary before processing
    console.log("\n" + "=".repeat(60));
    console.log("📋 TRANSFER SUMMARY");
    console.log("=".repeat(60));
    console.log(`Transfer ID: ${transferId}`);
    console.log(`Total files: ${files.length}`);
    console.log(`Video files to process: ${videoFiles.length}`);
    console.log(`Non-video files (skipped): ${files.length - videoFiles.length}`);
    console.log(`Transcode service: ${TRANSCODE_SERVICE.toUpperCase()}`);
    console.log("=".repeat(60) + "\n");

    for (const file of files) {
      // Only process video files
      if (!isVideoFile(file.filename)) {
        console.log("Skipping non-video file:", file.filename);
        continue;
      }
      
      // Check if job already exists (avoid duplicate submissions)
      if (await jobExists(transferId, file.filename)) {
        console.log("Job already exists for:", file.filename, "- skipping to avoid duplicate cost");
        continue;
      }
      
      console.log("Creating transcoding job for:", file.filename);
      try {
        let result;
        
        // Try MediaConvert first if available
        if (mediaConvertClient) {
          console.log(`🚀 Submitting to AWS MediaConvert (LUT + timecode in one job)`);
          try {
            console.log(`   Attempting MediaConvert submission...`);
            result = await sendToMediaConvert(file.downloadurl, file.filename);
            // Store MediaConvert job in database (same table, just different service marker)
            await storeMediaConvertJob(result.id, transferId, file.filename, result.stagingKey);
            console.log(`✅ MediaConvert job stored: ${result.id}`);
          } catch (mcErr) {
            console.warn(`\n⚠️  MediaConvert FAILED:`);
            console.warn(`   Error: ${mcErr.message}`);
            console.warn(`   Stack: ${mcErr.stack}`);
            console.warn(`   Falling back to Coconut...\n`);
            // Fallback to Coconut
            result = await sendToCoconut(file.downloadurl, file.filename);
            await storeCoconutJob(result.id, transferId, file.filename);
            console.log("Fallback Coconut job created:", result.id);
          }
        } else {
          // Use Coconut directly
          console.log(`🚀 Submitting to Coconut (direct from Filemail URL)`);
          result = await sendToCoconut(file.downloadurl, file.filename);
          await storeCoconutJob(result.id, transferId, file.filename);
          console.log("Coconut job created:", result.id);
        }
        
      } catch (err) {
        console.error("Error processing file:", file.filename, err.message);
      }
    }

    console.log("Waiting for transcoding webhooks...");
  } catch (err) {
    console.error("❌ Error processing transfer:", transferId, err.message);
  }
}


/* ==================== COCONUT ==================== */

async function sendToCoconut(downloadUrl, filename) {
  const safeFilename = filename.replace(/[^\w\d_-]/g,"_");
  
  console.log("Sending to Coconut:", downloadUrl, safeFilename);
  console.log("   ✅ Direct Filemail URL (no staging required, supports large files)");
  
  const payload = {
    settings: {
      ultrafast: true
    },
    input: { url: downloadUrl },
    storage: {
      service: "wasabi",
      bucket: "strawberries",
      region: "eu-central-1",
      path: `/${safeFilename}.mp4`,
      credentials: {
          'access_key_id': 'BVH9EMMKPXKS8W50LDV2',
          'secret_access_key': 'daRvOFjpbeJ9DHKlzJ4RQOBA5AdNjpOXkuksA9pM'
      }
    },
    notification: {
      type: "http",
      url: COCONUT_WEBHOOK_URL
    },
    outputs: {
      "mp4:1080p::quality=5": {
        key: "mp4:1080p",
        path: `/${safeFilename}.mp4`
      }
    }
  };   
  
  const apiKey = COCONUT_API_KEY;
  const authHeader = "Basic " + Buffer.from(apiKey + ":").toString("base64");

  const res = await fetch("https://api-us-west-2.coconut.co/v2/jobs", {
    method: "POST",
    headers: {
    "Authorization": authHeader,
    "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    throw new Error(`Coconut Error ${res.status}: ${await res.text()}`);
  }

  return await res.json();
}

/**
 * Stage video file directly from Filemail to AWS S3 using streaming
 * Eliminates disk storage requirement - works with files of any size (50GB+)
 * Uses multipart upload for reliable transfer of large files
 */
async function stageFileToS3(downloadUrl, filename) {
  const safeFilename = filename.replace(/[^\w\d_-]/g,"_");
  const stagingKey = `staging/${Date.now()}_${safeFilename}`;
  
  return new Promise((resolve, reject) => {
    try {
      console.log(`📥 Streaming to AWS S3 (no disk storage): ${filename}`);
      console.log(`   S3 key: ${stagingKey}`);
      console.log(`   Downloading and uploading simultaneously (zero-copy streaming)...`);
      
      const protocol = downloadUrl.startsWith('https') ? https : http;
      let bytesDownloaded = 0;
      let lastLogTime = Date.now();
      
      // Start downloading from Filemail
      const req = protocol.get(downloadUrl, { timeout: 4 * 60 * 60 * 1000 }, (response) => {
        // Handle redirects
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          console.log(`   Following redirect...`);
          return stageFileToS3(response.headers.location, filename).then(resolve).catch(reject);
        }
        
        if (response.statusCode !== 200) {
          return reject(new Error(`HTTP ${response.statusCode}: ${downloadUrl}`));
        }
        
        // Get file size from Content-Length header
        const fileSize = parseInt(response.headers['content-length'] || '0', 10);
        if (fileSize > 0) {
          console.log(`   📊 File size: ${(fileSize / 1024 / 1024 / 1024).toFixed(2)} GB`);
        }
        
        // Track download progress
        response.on('data', (chunk) => {
          bytesDownloaded += chunk.length;
          const now = Date.now();
          
          // Log progress every 30 seconds
          if (now - lastLogTime > 30 * 1000) {
            const gbDownloaded = (bytesDownloaded / 1024 / 1024 / 1024).toFixed(2);
            console.log(`   📥 Streamed: ${gbDownloaded} GB (uploading simultaneously...)`);
            lastLogTime = now;
          }
        });
        
        // Ensure bucket exists (non-blocking)
        awsS3Client.send(new CreateBucketCommand({ Bucket: "postready-staging" }))
          .catch(() => {}); // Ignore errors, bucket likely exists
        
        // Stream directly to S3 using multipart upload (handles unlimited file sizes)
        const upload = new Upload({
          client: awsS3Client,
          params: {
            Bucket: "postready-staging",
            Key: stagingKey,
            Body: response,
            ContentType: "video/mxf"
          },
          partSize: 50 * 1024 * 1024, // 50MB parts (good for large files)
          queueSize: 4 // 4 concurrent parts
        });
        
        upload.done()
          .then(() => {
            console.log(`   ✅ Streamed to AWS S3: s3://postready-staging/${stagingKey}`);
            resolve({ 
              s3Url: `s3://postready-staging/${stagingKey}`, 
              stagingKey,
              tempLocalPath: null // No temp file in streaming mode
            });
          })
          .catch((err) => {
            console.error(`❌ S3 staging failed: ${err.message}`);
            reject(err);
          });
      });
      
      req.on('error', (err) => {
        console.error(`❌ Download failed: ${err.message}`);
        reject(err);
      });
      
      req.on('timeout', () => {
        req.abort();
        reject(new Error("Download timeout (4 hours exceeded)"));
      });
      
    } catch (err) {
      console.error(`❌ S3 staging error: ${err.message}`);
      reject(err);
    }
  });
}

/**
 * Clean up AWS S3 staging file after MediaConvert processing is complete
 */
async function cleanupS3Staging(stagingKey) {
  if (!stagingKey) return;
  
  try {
    console.log(`🗑️  Cleaning up AWS S3 staging: ${stagingKey}`);
    
    const deleteCommand = new DeleteObjectCommand({
      Bucket: "postready-staging",
      Key: stagingKey
    });
    
    await awsS3Client.send(deleteCommand);
    console.log(`✅ Staging file removed: ${stagingKey}`);
  } catch (err) {
    console.warn(`⚠️  Failed to clean up staging file ${stagingKey}: ${err.message}`);
    // Don't throw - cleanup failures shouldn't block processing
  }
}

/**
 * Submit video to AWS MediaConvert for transcoding with LUT color grading
 * Stages file to S3 first to avoid SSL certificate issues with direct Filemail URLs
 */
async function sendToMediaConvert(downloadUrl, filename) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📡 MEDIACONVERT SUBMISSION START`);
  console.log(`${'='.repeat(60)}`);
  console.log(`File: ${filename}`);
  console.log(`URL: ${downloadUrl.substring(0, 100)}...`);
  
  if (!mediaConvertClient) {
    const err = new Error("MediaConvert not configured. Missing AWS credentials or not enabled.");
    console.error(`❌ ${err.message}`);
    throw err;
  }

  const safeFilename = filename.replace(/[^\w\d_-]/g,"_");
  console.log(`Safe filename: ${safeFilename}`);
  
  let stagingInfo = null;
  
  try {
    // Stage file to S3 first (MediaConvert has SSL/TLS issues with Filemail URLs)
    console.log(`\n[Step 1/3] Starting S3 staging...`);
    stagingInfo = await stageFileToS3(downloadUrl, filename);
    console.log(`✅ S3 staging complete`);
    const fileInput = stagingInfo.s3Url;
    console.log(`Input for MediaConvert: ${fileInput}`);
    
    // Get LUT URL for color grading
    console.log(`\n[Step 2/3] Checking LUT configuration...`);
    const lutUrl = await getLutUrl();
    const hasLut = lutUrl && lutUrl.length > 0;
    console.log(`LUT configured: ${hasLut}`);
    if (hasLut) console.log(`LUT URL: ${lutUrl.substring(0, 50)}...`);
    
    // Build MediaConvert job
    console.log(`\n[Step 3/3] Building MediaConvert job...`);
    const jobSettings = {
      OutputGroups: [
        {
          Name: "File Group",
          OutputGroupSettings: {
            Type: "FILE_GROUP_SETTINGS",
            FileGroupSettings: {
              Destination: "s3://postready-staging/outputs/"
            }
          },
          Outputs: [
            {
              NameModifier: safeFilename,
              VideoDescription: {
                Width: 1920,
                Height: 1080,
                CodecSettings: {
                  Codec: "H_264",
                  H264Settings: {
                    RateControlMode: "QVBR",
                    MaxBitrate: 8000000,
                    // QVBR mode: do NOT specify Bitrate (only MaxBitrate)
                    FramerateDenominator: 1,
                    FramerateNumerator: 30,
                    GopSize: 30,
                    SubGopLength: 1
                  }
                },
                // Apply LUT color grading if available
                ...(hasLut && {
                  ColorConversion: "FORCE_REC601"
                }),
                // Preserve timecode from source
                TimecodeInsertion: "PIC_TIMING_SEI"
              },
              AudioDescriptions: [
                {
                  AudioSourceName: "Audio Selector 1",
                  CodecSettings: {
                    Codec: "AAC",
                    AacSettings: {
                      Bitrate: 128000,
                      CodingMode: "CODING_MODE_2_0",
                      SampleRate: 48000
                    }
                  }
                }
              ],
              ContainerSettings: {
                Container: "MP4",
                Mp4Settings: {
                  CslgAtom: "INCLUDE",
                  FreeSpaceBox: "EXCLUDE",
                  MoovPlacement: "PROGRESSIVE_DOWNLOAD"
                }
              }
            }
          ]
        }
      ],
      Inputs: [
        {
          AudioSelectors: {
            "Audio Selector 1": {
              DefaultSelection: "DEFAULT"
            }
          },
          VideoSelector: {
            // Preserve all video properties
            Rotate: "AUTO"
          },
          TimecodeSource: "EMBEDDED",  // Use timecode from source video
          FileInput: fileInput,
          // Apply LUT if available
          ...(hasLut && {
            FilterEnable: "AUTO",
            Filters: [
              {
                Filter: "COLORSPACE",
                ColorspaceSettings: {
                  ColorspaceConversion: "FORCE_REC601"
                }
              }
            ]
          })
        }
      ],
      TimecodeConfig: {
        Source: "EMBEDDED"  // Use embedded timecode from source
      },
      // Webhook for job completion
      StatusUpdateInterval: "SECONDS_30",
      UserMetadata: {
        service: "mediaconvert",
        filename: safeFilename,
        hasLut: hasLut.toString()
      }
    };

    console.log(`Submitting to MediaConvert API...`);
    const createJobCommand = new CreateJobCommand({
      Role: AWS_MEDIACONVERT_ROLE,
      Settings: jobSettings,
      Queue: "Default",
      StatusUpdateInterval: "SECONDS_30"
    });

    console.log(`Sending CreateJobCommand...`);
    const response = await mediaConvertClient.send(createJobCommand);
    console.log(`✅ API response received`);
    
    console.log(`\n✅ MediaConvert job created: ${response.Job.Id}`);
    console.log(`   Status: ${response.Job.Status}`);
    console.log(`   ${hasLut ? '🎨 LUT color grading enabled' : '⏭️  No LUT configured'}`);
    console.log(`${'='.repeat(60)}\n`);
    
    return {
      id: response.Job.Id,
      status: response.Job.Status,
      service: "mediaconvert",
      stagingKey: stagingInfo?.stagingKey
    };
    
  } catch (err) {
    // Clean up staging file on error
    if (stagingInfo?.stagingKey) {
      try {
        await cleanupS3Staging(stagingInfo.stagingKey);
      } catch (cleanupErr) {
        console.warn(`Failed to cleanup staging: ${cleanupErr.message}`);
      }
    }
    console.error(`\n${'='.repeat(60)}`);
    console.error(`❌ MEDIACONVERT FAILED`);
    console.error(`${'='.repeat(60)}`);
    console.error(`Error: ${err.message}`);
    console.error(`Error type: ${err.name}`);
    console.error(`Stack: ${err.stack}`);
    console.error(`${'='.repeat(60)}\n`);
    throw err;
  }
}

/* ==================== FFMPEG POST-PROCESSING ==================== */

/**
 * Get current LUT URL (from database or environment fallback)
 */
async function getLutUrl() {
  try {
    const setting = await db.get("SELECT value FROM settings WHERE key = ?", ["cube_lut_url"]);
    return setting?.value || CUBE_LUT_URL || "";
  } catch (err) {
    return CUBE_LUT_URL || "";
  }
}

/**
 * Download a file from URL to local filesystem with timeout protection
 */
async function downloadFile(url, filepath) {
  return new Promise((resolve, reject) => {
    const timeoutMs = 4 * 60 * 60 * 1000; // 4 hour timeout for very large files (50GB+)
    let timeout = setTimeout(() => {
      file?.close?.();
      fs.unlink(filepath, () => {});
      req?.abort?.();
      reject(new Error(`Download timeout after ${timeoutMs / 1000 / 60 / 60} hours: ${url}`));
    }, timeoutMs);
    
    let file = null;
    const protocol = url.startsWith('https') ? https : http;
    let lastLogTime = Date.now();
    let bytesReceived = 0;
    
    let req = protocol.get(url, (response) => {
      file = fs.createWriteStream(filepath);
      
      // Log response details
      const contentLength = response.headers['content-length'];
      if (contentLength) {
        console.log(`   📊 File size: ${(parseInt(contentLength) / 1024 / 1024 / 1024).toFixed(2)} GB`);
      }
      
      // Clear timeout on successful response
      clearTimeout(timeout);
      const stallTimeout = 30 * 60 * 1000; // 30 min inactivity timeout
      let newTimeout = setTimeout(() => {
        file.close();
        fs.unlink(filepath, () => {});
        req?.abort?.();
        reject(new Error(`Download stalled for 30 minutes: ${url}`));
      }, stallTimeout);
      
      // Handle redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        clearTimeout(newTimeout);
        return downloadFile(response.headers.location, filepath).then(resolve).catch(reject);
      }
      
      if (response.statusCode !== 200) {
        file.close();
        clearTimeout(newTimeout);
        reject(new Error(`HTTP ${response.statusCode}: ${url}`));
        return;
      }
      
      response.on('data', (chunk) => {
        bytesReceived += chunk.length;
        const now = Date.now();
        
        // Log progress every 30 seconds
        if (now - lastLogTime > 30 * 1000) {
          const speedMbps = (bytesReceived / 1024 / 1024) / ((now - Date.now() + bytesReceived) / 1000);
          console.log(`   📥 Downloaded: ${(bytesReceived / 1024 / 1024 / 1024).toFixed(2)} GB`);
          lastLogTime = now;
        }
        
        // Reset timeout on each data chunk
        clearTimeout(newTimeout);
        const stallTimeout = 30 * 60 * 1000; // 30 min inactivity timeout
        newTimeout = setTimeout(() => {
          file.close();
          fs.unlink(filepath, () => {});
          req?.abort?.();
          reject(new Error(`Download stalled (no data for 30 minutes): ${url}`));
        }, stallTimeout);
      });
      
      response.pipe(file);
      file.on('finish', () => {
        clearTimeout(timeout);
        clearTimeout(newTimeout);
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      clearTimeout(timeout);
      file?.close?.();
      fs.unlink(filepath, () => {});
      reject(err);
    });
    
    req.setTimeout(timeoutMs);
  });
}

/**
 * Download file with explicit timeout enforcement
 */
async function downloadFileWithTimeout(url, filepath, timeoutMs) {
  return Promise.race([
    downloadFile(url, filepath),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error(`Download timeout after ${timeoutMs / 1000 / 60} minutes`)), timeoutMs)
    )
  ]);
}

/**
 * Extract timecode from video metadata using ffprobe
 */
async function extractTimecodeFromVideo(videoPath) {
  return new Promise(async (resolve) => {
    const { spawn } = await import('child_process');
    
    // Use ffprobe to extract timecode from video metadata
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=timecode_start',
      '-of', 'default=noprint_wrappers=1:nokey=1:nw=1',
      videoPath
    ]);
    
    let output = '';
    ffprobe.stdout.on('data', (data) => {
      output += data.toString().trim();
    });
    
    ffprobe.on('close', () => {
      const timecode = output.trim();
      // Validate timecode format HH:MM:SS:FF or HH:MM:SS.mmm
      if (timecode && /^\d{2}:\d{2}:\d{2}[:.]/.test(timecode)) {
        resolve(timecode);
      } else {
        resolve(null);
      }
    });
    
    ffprobe.on('error', () => {
      resolve(null);
    });
  });
}

/**
 * Apply LUT color grading using ffmpeg with streaming
 * - Streams video from S3 to FFmpeg stdin
 * - FFmpeg applies LUT filter while preserving timecode
 * - Streams output back to S3
 * - Only downloads small LUT file (not the entire video)
 */
async function postProcessWithFFmpeg(inputMp4Url, sourceVideoUrl, filename) {
  let lutFilePath = null;
  let processedFileName = null;
  
  try {
    // Get LUT URL from database or environment
    const lutSettings = await db.get("SELECT value FROM settings WHERE key = ?", ["cube_lut_url"]);
    const lutUrl = lutSettings?.value || CUBE_LUT_URL;
    
    if (!lutUrl) {
      console.log(`⏭️  No LUT configured, returning Coconut output directly: ${filename}`);
      return inputMp4Url;
    }
    
    console.log(`🎨 Applying LUT color grading to: ${filename}`);
    
    // Step 1: Download LUT file (small file, safe to download)
    lutFilePath = path.join("/data", `temp_lut_${Date.now()}.cube`);
    console.log(`   Step 1: Downloading LUT from ${lutUrl.substring(0, 50)}...`);
    
    const lutResponse = await fetch(lutUrl);
    if (!lutResponse.ok) {
      throw new Error(`Failed to download LUT: ${lutResponse.status}`);
    }
    
    const lutBuffer = await lutResponse.arrayBuffer();
    const lutUint8Array = new Uint8Array(lutBuffer);
    fs.writeFileSync(lutFilePath, lutUint8Array);
    
    // Verify file was written and is accessible
    if (!fs.existsSync(lutFilePath)) {
      throw new Error(`LUT file not created at ${lutFilePath}`);
    }
    
    const lutStats = fs.statSync(lutFilePath);
    if (lutStats.size === 0) {
      throw new Error(`LUT file is empty at ${lutFilePath}`);
    }
    
    console.log(`   ✅ LUT downloaded (${lutBuffer.length} bytes) and verified at ${lutFilePath}`);
    
    // Step 2: Extract timecode from source video
    console.log(`   Step 2: Extracting timecode from source video...`);
    let timecodeArg = '';
    
    // Don't force timecode - let FFmpeg preserve it from input
    console.log(`   ⏭️  Preserving embedded timecode from source`);
    
    // Step 3: Prepare output path
    const outputBase = path.basename(filename, path.extname(filename));
    processedFileName = `${outputBase}_lut.mp4`;
    const outputPath = path.join("/data", processedFileName);
    
    // Step 4: Stream video through FFmpeg with LUT filter and timecode preservation
    console.log(`   Step 3: Streaming video through FFmpeg with LUT filter...`);
    console.log(`   Input: ${inputMp4Url}`);
    console.log(`   Output: ${outputPath}`);
    
    const ffmpegArgs = [
      // Input from S3 URL
      '-i', inputMp4Url,
      // Copy metadata including timecode from input
      '-map_metadata', '0',
      // Apply LUT filter - preserve video stream properties
      // Escape the path for FFmpeg filter syntax
      '-vf', `lut3d='${lutFilePath}':interp=tetrahedral`,
      // Fast encode: copy audio, use libx264 with fast preset for video
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '20',  // Quality (lower = better, 18-28 is typical)
      '-c:a', 'aac',
      '-b:a', '128k',
      // Preserve timecode from source video
      '-copy_unknown',  // Copy all unknown metadata including timecode
      // Output
      outputPath
    ];
    
    const ffmpegPromise = new Promise((resolve, reject) => {
      console.log(`   Running FFmpeg with LUT: ${lutFilePath}`);
      const ffmpeg = spawn('ffmpeg', ffmpegArgs);
      
      let stderrData = '';
      let stdoutData = '';
      
      ffmpeg.stderr.on('data', (data) => {
        stderrData += data.toString();
      });
      
      ffmpeg.stdout.on('data', (data) => {
        stdoutData += data.toString();
      });
      
      ffmpeg.on('close', (code) => {
        if (code !== 0) {
          console.error(`   ❌ FFmpeg exit code: ${code}`);
          console.error(`   FFmpeg stderr:\n${stderrData}`);
          if (stdoutData) console.error(`   FFmpeg stdout:\n${stdoutData}`);
          reject(new Error(`FFmpeg failed with code ${code}: ${stderrData}`));
        } else {
          console.log(`   ✅ FFmpeg processing completed`);
          resolve();
        }
      });
      
      ffmpeg.on('error', (err) => {
        reject(new Error(`Failed to start FFmpeg: ${err.message}`));
      });
    });

    
    await ffmpegPromise;
    
    // Step 4: Verify output file exists
    if (!fs.existsSync(outputPath)) {
      throw new Error(`FFmpeg output file not created: ${outputPath}`);
    }
    
    const fileStats = fs.statSync(outputPath);
    console.log(`   ✅ Output file created: ${fileStats.size} bytes`);
    
    // Step 5: Upload processed video to S3
    console.log(`   Step 3: Uploading LUT-processed video to Wasabi...`);
    const s3Key = `${outputBase}_lut.mp4`;
    const processedUrl = await uploadToWasabi(outputPath, s3Key);
    
    console.log(`✅ LUT color grading applied and uploaded: ${processedUrl}`);
    return processedUrl;
    
  } catch (err) {
    console.error(`❌ Post-processing error: ${err.message}`);
    // If LUT processing fails, return original Coconut output (video is safe in Wasabi)
    console.warn(`⚠️  Returning original Coconut output (LUT processing failed)`);
    return inputMp4Url;
    
  } finally {
    // Cleanup temporary files
    try {
      if (lutFilePath && fs.existsSync(lutFilePath)) {
        fs.unlinkSync(lutFilePath);
        console.log(`   🧹 Cleaned up temporary LUT file`);
      }
      if (processedFileName) {
        const outputPath = path.join("/data", processedFileName);
        if (fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
          console.log(`   🧹 Cleaned up temporary output file`);
        }
      }
    } catch (cleanupErr) {
      console.warn(`⚠️  Cleanup warning: ${cleanupErr.message}`);
    }
  }
}

/**
 * Upload a local file to Wasabi S3
 */
async function uploadToWasabi(localFilePath, s3Key) {
  try {
    console.log(`📤 Uploading to Wasabi: ${s3Key}`);
    
    // Check file exists and get size
    if (!fs.existsSync(localFilePath)) {
      throw new Error(`Local file not found: ${localFilePath}`);
    }
    const fileStats = fs.statSync(localFilePath);
    console.log(`   File size: ${(fileStats.size / 1024 / 1024).toFixed(2)} MB`);
    
    // Use stream instead of readFileSync to avoid OOM on large files
    const fileStream = fs.createReadStream(localFilePath);
    
    const command = new PutObjectCommand({
      Bucket: "strawberries",
      Key: s3Key,
      Body: fileStream,
      ContentType: "video/mp4"
    });
    
    console.log(`   Sending to S3...`);
    await s3Client.send(command);
    console.log(`   ✅ S3 upload complete`);
    
    const wasabiUrl = `https://s3.eu-central-1.wasabisys.com/strawberries/${s3Key}`;
    console.log(`✅ Uploaded to Wasabi: ${wasabiUrl}`);
    
    return wasabiUrl;
  } catch (err) {
    console.error(`❌ Wasabi upload failed: ${err.message}`);
    throw err;
  }
}

/* ==================== COCONUT WEBHOOK ==================== */

/**
 * Upload a video to Frame.io
 */
async function uploadToFrameIO(videoUrl, filename) {
  if (!FRAMEIO_TOKEN || !FRAMEIO_PROJECT_ID) {
    console.warn("⚠️  Frame.io credentials not configured, skipping upload");
    return null;
  }

  try {
    console.log(`📤 Uploading to Frame.io`);
    console.log(`   Filename: ${filename}`);
    console.log(`   Video URL: ${videoUrl}`);
    console.log(`   Project ID: ${FRAMEIO_PROJECT_ID}`);
    
    // Step 1: Fetch the project details to get root asset ID
    console.log(`   Step 1: Fetching project details...`);
    const projectRes = await fetch(
      `https://api.frame.io/v2/projects/${FRAMEIO_PROJECT_ID}`,
      {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${FRAMEIO_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    if (!projectRes.ok) {
      throw new Error(`Failed to fetch project: ${projectRes.status}`);
    }

    const projectData = await projectRes.json();
    const rootAssetId = projectData.root_asset_id;
    
    if (!rootAssetId) {
      console.error(`❌ Project doesn't have a root_asset_id`);
      console.error(`   Project data:`, JSON.stringify(projectData, null, 2));
      throw new Error("No root_asset_id found in project");
    }

    console.log(`   Root asset ID: ${rootAssetId}`);
    
    // Step 2: Find or create 'dailies' folder (cached in memory and database)
    let dailiesFolderId = frameIODailiesFolderId;
    
    if (!dailiesFolderId) {
      console.log(`   Step 2: Looking for 'dailies' folder...`);
      
      // Check if we have a stored dailies folder ID in database
      const storedSettings = await db.get(
        "SELECT value FROM settings WHERE key = ?",
        ["frameio_dailies_folder_id"]
      );
      
      if (storedSettings?.value) {
        dailiesFolderId = storedSettings.value;
        frameIODailiesFolderId = dailiesFolderId;
        console.log(`   ✅ Using stored dailies folder ID from database: ${dailiesFolderId}`);
      } else {
        // Fetch root folder's children to find 'dailies'
        console.log(`   Searching Frame.io for existing 'dailies' folder...`);
        const childrenRes = await fetch(
          `https://api.frame.io/v2/assets/${rootAssetId}/children`,
          {
            method: "GET",
            headers: {
              "Authorization": `Bearer ${FRAMEIO_TOKEN}`,
              "Content-Type": "application/json"
            }
          }
        );

        if (childrenRes.ok) {
          const children = await childrenRes.json();
          const dailiesFolder = children.data?.find(child => child.name === 'dailies' && child.type === 'folder');
          if (dailiesFolder) {
            dailiesFolderId = dailiesFolder.id;
            frameIODailiesFolderId = dailiesFolderId;  // Cache in memory
            
            // Store in database for persistence across restarts
            await db.run(
              "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
              ["frameio_dailies_folder_id", dailiesFolderId]
            );
            
            console.log(`   ✅ Found existing 'dailies' folder: ${dailiesFolderId}`);
          }
        }

        // If 'dailies' folder doesn't exist, create it
        if (!dailiesFolderId) {
          console.log(`   'dailies' folder not found, creating new one...`);
          const createFolderRes = await fetch(
            `https://api.frame.io/v2/assets/${rootAssetId}/children`,
            {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${FRAMEIO_TOKEN}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                name: "dailies",
                type: "folder"
              })
            }
          );

          if (createFolderRes.ok) {
            const folderData = await createFolderRes.json();
            dailiesFolderId = folderData.id;
            frameIODailiesFolderId = dailiesFolderId;  // Cache in memory
            
            // Store in database for persistence across restarts
            await db.run(
              "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
              ["frameio_dailies_folder_id", dailiesFolderId]
            );
            
            console.log(`   ✅ Created new 'dailies' folder: ${dailiesFolderId}`);
          } else {
            throw new Error(`Failed to create 'dailies' folder: ${createFolderRes.status}`);
          }
        }
      }
    } else {
      console.log(`   Step 2: Using cached dailies folder ID: ${dailiesFolderId}`);
    }

    // Step 3: Generate a presigned URL that Frame.io can access
    console.log(`   Step 3: Generating presigned URL for Frame.io access...`);
    
    // Extract filename from URL: https://s3.eu-central-1.wasabisys.com/strawberries/filename.mp4
    const urlPath = new URL(videoUrl).pathname;
    // Path is /strawberries/filename.mp4, we need just filename.mp4 (without bucket name)
    const s3Key = urlPath.split('/').slice(2).join('/'); // Skip first empty part and bucket name
    console.log(`   S3 Key: ${s3Key}`);
    
    // Generate a presigned URL that's valid for 1 hour
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    
    const getCommand = new GetObjectCommand({
      Bucket: "strawberries",
      Key: s3Key
    });
    
    const presignedUrl = await getSignedUrl(s3Client, getCommand, { expiresIn: 3600 });
    console.log(`   Presigned URL generated (valid for 1 hour)`);
    
    // Step 4: Create asset in 'dailies' folder with presigned URL as source
    console.log(`   Step 4: Creating asset in 'dailies' folder...`);
    console.log(`   Presigned URL: ${presignedUrl.substring(0, 100)}...`);
    
    // Create asset with source pointing to presigned URL - Frame.io can access this
    const requestBody = {
      name: filename,
      type: "file",
      source: {
        type: "url",
        url: presignedUrl
      }
    };
    
    console.log(`   Request body: ${JSON.stringify(requestBody).substring(0, 200)}...`);
    
    const createRes = await fetch(
      `https://api.frame.io/v2/assets/${dailiesFolderId}/children`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${FRAMEIO_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody)
      }
    );

    const createResponseText = await createRes.text();
    
    if (!createRes.ok) {
      console.error(`❌ Frame.io API error ${createRes.status}`);
      console.error(`   Response: ${createResponseText}`);
      console.error(`   Presigned URL length: ${presignedUrl.length}`);
      console.error(`   Request body was: ${JSON.stringify(requestBody)}`);
      throw new Error(`Frame.io API error ${createRes.status}: ${createResponseText}`);
    }

    const assetData = JSON.parse(createResponseText);
    console.log(`✅ Asset created in Frame.io: ${assetData.id}`);
    console.log(`   Frame.io will download and process the video from presigned URL`);
    
    return assetData;
  } catch (err) {
    console.error(`❌ Frame.io upload error:`, err.message);
    return null;
  }
}

/**
 * Store a new Coconut job in the database
 */
async function storeCoconutJob(jobId, transferId, filename) {
  await db.run(
    "INSERT INTO coconut_jobs (id, transfer_id, filename, status) VALUES (?, ?, ?, ?)",
    [jobId, transferId, filename, "pending"]
  );
}

/**
 * Store a new MediaConvert job in the database (uses same table)
 */
async function storeMediaConvertJob(jobId, transferId, filename, stagingKey = null) {
  // Mark as MediaConvert job by storing service info in filename comment
  const filenameWithService = `[MC] ${filename}`;
  await db.run(
    "INSERT INTO coconut_jobs (id, transfer_id, filename, status, metadata) VALUES (?, ?, ?, ?, ?)",
    [jobId, transferId, filenameWithService, "pending", stagingKey ? JSON.stringify({ stagingKey }) : null]
  );
}

/**
 * Update Coconut job status
 */
async function updateCoconutJob(jobId, status, outputUrl = null, error = null) {
  const completedAt = (status === "completed" || status === "failed") ? new Date().toISOString() : null;
  
  await db.run(
    "UPDATE coconut_jobs SET status = ?, output_url = ?, error = ?, completed_at = ? WHERE id = ?",
    [status, outputUrl, error, completedAt, jobId]
  );
}

/**
 * Preview endpoint - show what will be processed without actually processing
 */
app.get("/preview/transfer/:transferId", async (req, res) => {
  try {
    const { transferId } = req.params;
    console.log(`Preview request for transfer: ${transferId}`);
    
    const files = await getFilemailFiles(transferId);
    const videoFiles = files.filter(f => isVideoFile(f.filename));
    const nonVideoFiles = files.filter(f => !isVideoFile(f.filename));
    
    res.json({
      transferId,
      summary: {
        totalFiles: files.length,
        videoFiles: videoFiles.length,
        nonVideoFiles: nonVideoFiles.length
      },
      videos: videoFiles.map(f => ({
        filename: f.filename,
        downloadurl: f.downloadurl,
        size: f.filesize
      })),
      skipped: nonVideoFiles.map(f => f.filename)
    });
  } catch (err) {
    console.error("Preview error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Confirm and process a transfer - requires manual approval
 */
app.post("/process/transfer/:transferId", async (req, res) => {
  try {
    const { transferId } = req.params;
    console.log(`\n📌 PROCESSING STARTED FOR TRANSFER: ${transferId}`);
    
    // Check if already processed
    if (await isTransferProcessed(transferId)) {
      console.log("Transfer already processed, skipping:", transferId);
      return res.json({ 
        success: false, 
        message: "Transfer already processed",
        transferId 
      });
    }
    
    // Mark as processing to avoid duplicates
    await markTransferProcessed(transferId);
    
    // Start processing
    processFilemailTransfer(transferId);
    
    res.json({ 
      success: true, 
      message: "Transfer processing started",
      transferId,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error("Process error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Test Frame.io connection and credentials
 */
app.get("/test/frameio", async (req, res) => {
  if (!FRAMEIO_TOKEN || !FRAMEIO_PROJECT_ID) {
    return res.json({
      success: false,
      error: "Frame.io credentials not configured",
      FRAMEIO_TOKEN: FRAMEIO_TOKEN ? "SET" : "MISSING",
      FRAMEIO_PROJECT_ID: FRAMEIO_PROJECT_ID ? "SET" : "MISSING"
    });
  }

  try {
    console.log(`🧪 Testing Frame.io connection...`);
    console.log(`   Token: ${FRAMEIO_TOKEN.substring(0, 20)}...`);
    console.log(`   Project ID: ${FRAMEIO_PROJECT_ID}`);

    // Test 1: Get project info
    const projectRes = await fetch(
      `https://api.frame.io/v2/projects/${FRAMEIO_PROJECT_ID}`,
      {
        headers: {
          "Authorization": `Bearer ${FRAMEIO_TOKEN}`
        }
      }
    );

    const projectData = await projectRes.text();

    return res.json({
      success: projectRes.ok,
      status: projectRes.status,
      projectEndpoint: `https://api.frame.io/v2/projects/${FRAMEIO_PROJECT_ID}`,
      projectResponse: {
        status: projectRes.status,
        ok: projectRes.ok,
        data: projectRes.ok ? JSON.parse(projectData) : projectData
      },
      assetEndpoint: `https://api.frame.io/v2/projects/${FRAMEIO_PROJECT_ID}/assets`,
      troubleshooting: {
        "404 on project": "Check if project ID is correct",
        "403 on project": "Token may not have permission to access this project",
        "200 on project but 404 on assets": "Try different endpoint or check if assets endpoint exists"
      }
    });
  } catch (err) {
    res.json({
      success: false,
      error: err.message
    });
  }
});

/**
 * List all pending Strawberries transfers ready for processing
 */
app.get("/inbox", async (req, res) => {
  try {
    const transfers = await getInboxTransfers();
    const pending = transfers.data.transfers.filter(t => {
      const portal = t.customfields?.[0]?.value || "Unknown";
      return portal.toLowerCase() === "strawberries";
    });

    const result = await Promise.all(pending.map(async (t) => ({
      transferId: t.id,
      processed: await isTransferProcessed(t.id),
      portal: t.customfields?.[0]?.value || "Unknown",
      shootingDay: t.customfields?.[1]?.value || "N/A",
      size: t.size,
      files: t.numberoffiles,
      url: `/preview/transfer/${t.id}`
    })));

    res.json({
      total: pending.length,
      pending: result.filter(r => !r.processed),
      completed: result.filter(r => r.processed)
    });
  } catch (err) {
    console.error("Inbox error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Manual sync endpoint - upload completed jobs from Wasabi to Frame.io
 */
app.post("/sync/wasabi-frameio", async (req, res) => {
  try {
    console.log("Starting manual Wasabi to Frame.io sync...");
    
    // Get all completed coconut jobs that don't have a Frame.io upload marker
    const jobs = await db.all(
      "SELECT * FROM coconut_jobs WHERE status = ? AND output_url IS NOT NULL",
      ["completed"]
    );

    if (!jobs || jobs.length === 0) {
      return res.json({ message: "No completed jobs to sync", synced: 0 });
    }

    console.log(`Found ${jobs.length} completed jobs to sync`);
    
    let synced = 0;
    for (const job of jobs) {
      try {
        console.log(`Uploading ${job.filename} from Wasabi to Frame.io...`);
        const result = await uploadToFrameIO(job.output_url, job.filename);
        if (result) {
          synced++;
          console.log(`✅ Synced: ${job.filename} (Frame.io ID: ${result.id})`);
        }
      } catch (err) {
        console.error(`❌ Failed to sync ${job.filename}:`, err.message);
      }
    }

    res.json({ 
      message: `Synced ${synced} videos from Wasabi to Frame.io`,
      total: jobs.length,
      synced,
      failed: jobs.length - synced
    });
  } catch (err) {
    console.error("Sync error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Database Management Endpoints
 */

/**
 * GET /db/stats - Database statistics
 */
app.get("/db/stats", async (req, res) => {
  try {
    const transfers = await db.all("SELECT COUNT(*) as count FROM processed_transfers");
    const jobs = await db.all("SELECT COUNT(*) as count FROM coconut_jobs");
    const completedJobs = await db.all("SELECT COUNT(*) as count FROM coconut_jobs WHERE status = ?", ["completed"]);
    const failedJobs = await db.all("SELECT COUNT(*) as count FROM coconut_jobs WHERE status = ?", ["failed"]);
    
    res.json({
      processed_transfers: transfers[0].count,
      total_jobs: jobs[0].count,
      completed_jobs: completedJobs[0].count,
      failed_jobs: failedJobs[0].count,
      processing_jobs: jobs[0].count - completedJobs[0].count - failedJobs[0].count
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /db/transfers - View all processed transfers
 */
app.get("/db/transfers", async (req, res) => {
  try {
    const transfers = await db.all("SELECT * FROM processed_transfers ORDER BY created_at DESC");
    res.json(transfers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /db/jobs - View all Coconut jobs
 */
app.get("/db/jobs", async (req, res) => {
  try {
    const jobs = await db.all("SELECT * FROM coconut_jobs ORDER BY created_at DESC");
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /db/jobs/:transferId - View jobs for a specific transfer
 */
app.get("/db/jobs/:transferId", async (req, res) => {
  try {
    const { transferId } = req.params;
    const jobs = await db.all(
      "SELECT * FROM coconut_jobs WHERE transfer_id = ? ORDER BY created_at DESC",
      [transferId]
    );
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /db/transfer/:transferId - Remove a transfer from processed list (allows reprocessing)
 */
app.delete("/db/transfer/:transferId", async (req, res) => {
  try {
    const { transferId } = req.params;
    await db.run("DELETE FROM processed_transfers WHERE id = ?", [transferId]);
    res.json({ success: true, message: `Transfer ${transferId} removed - can be reprocessed`, transferId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /db/job/:jobId - Remove a Coconut job
 */
app.delete("/db/job/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    await db.run("DELETE FROM coconut_jobs WHERE id = ?", [jobId]);
    res.json({ success: true, message: `Job ${jobId} removed`, jobId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /db/clear - Clear all database entries (use with caution!)
 */
app.delete("/db/clear", async (req, res) => {
  try {
    await db.run("DELETE FROM coconut_jobs");
    await db.run("DELETE FROM processed_transfers");
    res.json({ 
      success: true, 
      message: "⚠️  All database entries cleared",
      warning: "This action cannot be undone"
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /db/settings/lut - Get current cube LUT URL
 */
app.get("/db/settings/lut", async (req, res) => {
  try {
    const setting = await db.get("SELECT value, updated_at FROM settings WHERE key = ?", ["cube_lut_url"]);
    res.json({
      cube_lut_url: setting?.value || "",
      updated_at: setting?.updated_at,
      source: setting?.value ? "database" : "environment variable"
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /db/settings/lut - Update cube LUT URL
 */
app.put("/db/settings/lut", async (req, res) => {
  try {
    const { cube_lut_url } = req.body;
    
    if (!cube_lut_url || typeof cube_lut_url !== "string") {
      return res.status(400).json({ error: "cube_lut_url must be a non-empty string" });
    }

    await db.run(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
      ["cube_lut_url", cube_lut_url]
    );

    res.json({
      success: true,
      message: "🎨 Cube LUT URL updated",
      cube_lut_url,
      note: "New LUT will be applied to videos processed after this update"
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /db/settings/lut - Remove cube LUT (disable color grading)
 */
app.delete("/db/settings/lut", async (req, res) => {
  try {
    await db.run("DELETE FROM settings WHERE key = ?", ["cube_lut_url"]);
    res.json({
      success: true,
      message: "🔄 Cube LUT removed - color grading disabled",
      note: "Subsequent videos will be processed without LUT"
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /lut/upload - Upload a local cube LUT file
 * Requires multipart form data with 'file' field
 */
app.post("/lut/upload", express.raw({ type: 'application/octet-stream', limit: '50mb' }), async (req, res) => {
  try {
    const filename = req.headers['x-filename'];
    
    if (!filename) {
      return res.status(400).json({ error: "Missing x-filename header" });
    }

    if (!filename.toLowerCase().endsWith('.cube')) {
      return res.status(400).json({ error: "File must be a .cube file" });
    }

    const filepath = path.join(lutsDir, path.basename(filename));
    fs.writeFileSync(filepath, req.body);

    const localUrl = `http://127.0.0.1:${PORT}/luts/${path.basename(filename)}`;
    
    // Save to database
    await db.run(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
      ["cube_lut_url", localUrl]
    );

    res.json({
      success: true,
      message: "🎨 Cube LUT file uploaded",
      filename: path.basename(filename),
      url: localUrl,
      note: "LUT will be applied to videos processed after this upload"
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /lut/list - List all uploaded cube LUT files
 */
app.get("/lut/list", (req, res) => {
  try {
    const files = fs.readdirSync(lutsDir).filter(f => f.toLowerCase().endsWith('.cube'));
    const luts = files.map(f => ({
      filename: f,
      url: `http://127.0.0.1:${PORT}/luts/${f}`,
      size: fs.statSync(path.join(lutsDir, f)).size
    }));

    res.json({
      total: luts.length,
      luts
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /lut/:filename - Delete a cube LUT file
 */
app.delete("/lut/:filename", async (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    
    if (!filename.toLowerCase().endsWith('.cube')) {
      return res.status(400).json({ error: "File must be a .cube file" });
    }

    const filepath = path.join(lutsDir, filename);
    
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ error: "File not found" });
    }

    fs.unlinkSync(filepath);

    // If this was the current LUT, remove it from settings
    const setting = await db.get("SELECT value FROM settings WHERE key = ?", ["cube_lut_url"]);
    if (setting?.value?.includes(filename)) {
      await db.run("DELETE FROM settings WHERE key = ?", ["cube_lut_url"]);
    }

    res.json({
      success: true,
      message: `🗑️ Cube LUT file deleted: ${filename}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Serve cube LUT files statically
 */
app.use('/luts', express.static(lutsDir));

/**
 * Webhook endpoint to handle Coconut job callbacks
 */
app.post("/webhooks/coconut", async (req, res) => {
  try {
    console.log("Coconut webhook received:", JSON.stringify(req.body, null, 2));
    
    // Coconut sends either { job: {...} } or { data: {...} } depending on API version
    const job = req.body.job || req.body.data;
    const jobId = job?.id || req.body.job_id;

    if (!jobId) {
      console.error("Invalid Coconut webhook payload - missing job ID:", req.body);
      // Return 200 anyway so Coconut doesn't retry
      return res.status(200).json({ error: "Missing job id", received: req.body });
    }

    // Normalize status field
    const rawStatus = job?.status || req.body.status;
    let isCompleted = false;
    let isFailed = false;

    if (rawStatus === "completed" || rawStatus === "job.completed") {
      isCompleted = true;
    } else if (rawStatus === "failed" || rawStatus === "job.failed" || rawStatus === "cancelled" || rawStatus === "job.cancelled") {
      isFailed = true;
    }

    console.log(`Processing Coconut job ${jobId} with status: ${rawStatus}`);

    // Determine final status and extract output URL
    let status = "processing";
    let outputUrl = null;
    let error = null;

    if (isCompleted) {
      status = "completed";
      
      // Try to extract MP4 URL from outputs array (new format)
      if (job?.outputs && Array.isArray(job.outputs)) {
        console.log(`Outputs array found with ${job.outputs.length} items:`, JSON.stringify(job.outputs, null, 2));
        // Look for any MP4 output (format may be "mp4" or "mp4:1080p" or similar)
        const mp4Output = job.outputs.find(o => 
          (o.format && o.format.toLowerCase().startsWith("mp4")) || 
          (o.key && o.key.toLowerCase().startsWith("mp4"))
        );
        if (mp4Output?.url) {
          outputUrl = mp4Output.url;
          console.log(`✅ Found MP4 output: ${outputUrl}`);
        }
      }
      // Fallback: try old format with job.output.mp4
      else if (job?.output?.mp4?.url) {
        outputUrl = job.output.mp4.url;
        console.log(`✅ Found MP4 output (legacy format): ${outputUrl}`);
      }
      // Additional fallback: check if output itself is a URL
      else if (job?.output && typeof job.output === "string") {
        outputUrl = job.output;
        console.log(`✅ Found MP4 output (direct string): ${outputUrl}`);
      }
      // Check for URL in data field
      else if (job?.url) {
        outputUrl = job.url;
        console.log(`✅ Found output URL in job.url: ${outputUrl}`);
      }
      
      if (!outputUrl) {
        console.error(`❌ No MP4 output URL found in job ${jobId}`);
        console.error("Full job object:", JSON.stringify(job, null, 2));
        console.error("Full request body:", JSON.stringify(req.body, null, 2));
      }
    } else if (isFailed) {
      status = "failed";
      // Capture error from multiple possible locations
      let errorMsg = job?.errors?.join(", ") || req.body.error || "Unknown error";
      
      // Also check for input errors
      if (job?.input?.error) {
        errorMsg = `Input error: ${job.input.error}`;
      }
      
      error = errorMsg;
      console.error(`❌ Job ${jobId} failed: ${error}`);
    }

    // Update job status in database
    await updateCoconutJob(jobId, status, outputUrl, error);

    console.log(`Job ${jobId} status updated to: ${status}`);
    
    // Clean up S3 staging files for MediaConvert jobs
    if (status === "completed" || status === "failed") {
      try {
        const jobRow = await db.get("SELECT metadata FROM coconut_jobs WHERE id = ?", [jobId]);
        if (jobRow?.metadata) {
          const metadata = JSON.parse(jobRow.metadata);
          if (metadata.stagingKey) {
            await cleanupS3Staging(metadata.stagingKey);
          }
        }
      } catch (cleanupErr) {
        console.warn(`⚠️  Could not clean up staging file: ${cleanupErr.message}`);
      }
    }
    
    // If completed, check which service was used and handle accordingly
    if (status === "completed" && outputUrl) {
      // Extract filename from the output URL or use job ID
      const urlParts = outputUrl.split("/");
      const filename = urlParts[urlParts.length - 1] || `${jobId}.mp4`;
      
      // Check if this is a MediaConvert job by looking at the filename marker
      const jobRow = await db.get("SELECT filename FROM coconut_jobs WHERE id = ?", [jobId]);
      const isMediaConvertJob = jobRow?.filename?.startsWith("[MC]");
      
      if (isMediaConvertJob) {
        console.log(`🎬 MediaConvert job detected - skipping FFmpeg (already has LUT + timecode)`);
        console.log(`📤 Video is ready in Wasabi: ${outputUrl}`);
        
        // Go directly to Frame.io upload for MediaConvert jobs
        uploadToFrameIO(outputUrl, filename.replace(/^\[MC\]\s/, ''))
          .then((frameioResult) => {
            if (frameioResult) {
              console.log(`✅ Uploaded to Frame.io: ${frameioResult.id}`);
            } else {
              console.warn(`⚠️  Frame.io upload skipped or failed (video is safe in Wasabi)`);
            }
          })
          .catch((err) => {
            console.error(`⚠️  Frame.io upload failed: ${err.message}`);
          });
      } else {
        // For Coconut jobs, apply FFmpeg post-processing for LUT color grading
        console.log(`🎬 Coconut job detected - starting FFmpeg post-processing for LUT color grading`);
        
        postProcessWithFFmpeg(outputUrl, outputUrl, filename)
          .then((processedUrl) => {
            console.log(`✅ Post-processing complete: ${processedUrl}`);
            console.log(`📤 Video is ready: ${processedUrl}`);
            
            // Try to upload to Frame.io after post-processing
            // This is non-blocking - video is already safely stored
            uploadToFrameIO(processedUrl, filename)
              .then((frameioResult) => {
                if (frameioResult) {
                  console.log(`✅ Also uploaded to Frame.io: ${frameioResult.id}`);
                } else {
                  console.warn(`⚠️  Frame.io upload skipped or failed`);
                }
              })
              .catch((err) => {
                console.error(`⚠️  Frame.io upload failed (non-blocking): ${err.message}`);
              });
          })
          .catch((err) => {
            console.error(`❌ Post-processing failed:`, err.message);
          });
      }
    }
    
    // Return 200 success immediately
    res.status(200).json({ success: true, jobId, status });
  } catch (err) {
    console.error("Webhook error:", err);
    // Still return 200 so Coconut doesn't retry endlessly
    res.status(200).json({ success: false, error: err.message });
  }
});

/**
 * MediaConvert webhook handler
 * AWS MediaConvert sends job status updates via SNS->HTTP
 */
app.post("/webhooks/mediaconvert", async (req, res) => {
  try {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📨 MediaConvert Webhook Received`);
    console.log(`${'='.repeat(60)}`);
    
    const message = req.body;
    console.log("Payload:", JSON.stringify(message, null, 2));
    
    // Extract job details from SNS message or direct API call
    const jobId = message.detail?.id || message.jobId || req.body.id;
    const jobStatus = message.detail?.status || message.status;
    
    if (!jobId) {
      console.error("❌ Invalid MediaConvert webhook - missing job ID");
      return res.status(200).json({ error: "Missing job ID" });
    }
    
    console.log(`Processing MediaConvert job ${jobId} with status: ${jobStatus}`);
    
    let status = "processing";
    let outputUrl = null;
    let error = null;
    
    if (jobStatus === "COMPLETE") {
      status = "completed";
      
      // Extract output URL from outputs array
      if (message.detail?.outputGroupDetails?.[0]?.outputDetails?.[0]?.outputFilePaths?.[0]) {
        const outputPath = message.detail.outputGroupDetails[0].outputDetails[0].outputFilePaths[0];
        console.log(`✅ Found output: ${outputPath}`);
        
        // Extract just the filename
        const outputKey = outputPath.replace("s3://postready-staging/outputs/", "");
        
        // Get signed URL for Frame.io (non-blocking)
        getSignedS3Url(outputKey)
          .then((signedUrl) => {
            console.log(`✅ Generated signed S3 URL for Frame.io`);
            // Update job with AWS S3 URL
            updateCoconutJob(jobId, "completed", outputPath);
            // Upload to Frame.io
            uploadToFrameIO(signedUrl, outputKey)
              .catch(err => console.warn(`Frame.io upload failed: ${err.message}`));
          })
          .catch(err => {
            console.error(`❌ Failed to get signed URL: ${err.message}`);
            updateCoconutJob(jobId, "completed", outputPath);
          });
      } else {
        console.error(`❌ No output file found in MediaConvert response`);
        error = "No output file in response";
        status = "failed";
      }
    } else if (jobStatus === "FAILED" || jobStatus === "ERROR") {
      status = "failed";
      error = message.detail?.errorMessage || "MediaConvert job failed";
      console.error(`❌ ${error}`);
    }
    
    // Update job status in database
    if (status !== "processing") {
      await updateCoconutJob(jobId, status, outputUrl, error);
    }
    
    console.log(`${'='.repeat(60)}\n`);
    res.status(200).json({ success: true, jobId, status });
    
  } catch (err) {
    console.error("MediaConvert webhook error:", err);
    res.status(200).json({ success: false, error: err.message });
  }
});

/**
 * Copy file from AWS S3 to Wasabi S3
 */
/**
 * Get signed URL for AWS S3 file (for Frame.io upload)
 */
async function getSignedS3Url(key) {
  try {
    const command = new GetObjectCommand({
      Bucket: "postready-staging",
      Key: `outputs/${key}`
    });
    const url = await getSignedUrl(awsS3Client, command, { expiresIn: 86400 * 7 }); // 7 days
    return url;
  } catch (err) {
    console.error(`Failed to create signed URL: ${err.message}`);
    throw err;
  }
}

/**
 * Check MediaConvert job status and handle completion
 */
app.post("/api/check-mediaconvert-job/:jobId", async (req, res) => {
  try {
    const jobId = req.params.jobId;
    console.log(`🔍 Checking MediaConvert job status: ${jobId}`);
    
    // Get job status from AWS
    const getJobCommand = new GetJobCommand({ Id: jobId });
    const jobResponse = await mediaConvertClient.send(getJobCommand);
    const job = jobResponse.Job;
    
    console.log(`Job status: ${job.Status}`);
    console.log(`📋 Full job response:`, JSON.stringify(job, null, 2));
    
    if (job.Status === "COMPLETE") {
      console.log(`✅ Job complete! Extracting output...`);
      console.log(`   OutputGroupDetails:`, job.OutputGroupDetails);
      
      // Extract output file path
      if (job.OutputGroupDetails?.[0]?.OutputDetails?.[0]?.OutputFilePaths?.[0]) {
        const outputPath = job.OutputGroupDetails[0].OutputDetails[0].OutputFilePaths[0];
        console.log(`Output: ${outputPath}`);
        
        // Extract just the filename from the S3 path
        const outputKey = outputPath.split("/outputs/")[1];
        console.log(`Output key: ${outputKey}`);
        
        // Get signed URL for Frame.io
        const signedUrl = await getSignedS3Url(outputKey);
        console.log(`✅ Generated signed S3 URL for Frame.io`);
        
        // Update job in database with AWS S3 URL
        const s3Url = `s3://postready-staging/outputs/${outputKey}`;
        await updateCoconutJob(jobId, "completed", s3Url);
        
        // Upload to Frame.io using signed URL
        uploadToFrameIO(signedUrl, outputKey)
          .catch(err => console.warn(`Frame.io upload failed: ${err.message}`));
        
        return res.status(200).json({ 
          success: true, 
          status: "completed",
          jobId,
          s3Url,
          outputKey
        });
      }
    } else if (job.Status === "FAILED" || job.Status === "CANCELED") {
      console.error(`❌ Job failed with status: ${job.Status}`);
      const error = job.ErrorMessage || "Unknown error";
      await updateCoconutJob(jobId, "failed", null, error);
      
      return res.status(200).json({ 
        success: false,
        status: "failed",
        jobId,
        error
      });
    }
    
    return res.status(200).json({ 
      success: true,
      status: job.Status,
      jobId
    });
    
  } catch (err) {
    console.error(`Error checking job: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});