// node /Users/robmaas/Desktop/iMac/Projects/postready_handling/index
import fetch from "node-fetch";
import express from "express";
import dotenv from "dotenv";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import fs from "fs";
import path from "path";
import { execSync, spawn } from "child_process";
import https from "https";
import http from "http";
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, CreateBucketCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import { MediaConvertClient, CreateJobCommand, GetJobCommand, CreateJobTemplateCommand, DeleteJobTemplateCommand, ListJobTemplatesCommand, GetJobTemplateCommand } from "@aws-sdk/client-mediaconvert";

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
const FRAMEIO_TOKEN = process.env.FRAMEIO_TOKEN || "";
const FRAMEIO_PROJECT_ID = process.env.FRAMEIO_PROJECT_ID || "";
const CUBE_LUT_URL = process.env.CUBE_LUT_URL || "";
const MEDIACONVERT_WEBHOOK_URL = `${DEPLOYMENT_URL}/webhooks/mediaconvert`;

// MediaConvert settings (only transcoding service)
const TRANSCODE_SERVICE = "mediaconvert";
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

/**
 * Verify LUT file exists in S3
 */
async function verifyLUTFile() {
  try {
    const headCommand = new HeadObjectCommand({
      Bucket: "postready-staging",
      Key: "Awsome1.cube"
    });
    const result = await awsS3Client.send(headCommand);
    const sizeMB = (result.ContentLength / 1024 / 1024).toFixed(2);
    console.log(`✅ Awsome1.cube found in S3: ${sizeMB} MB`);
    console.log(`   Color grading via ColorSpaceConversion: REC.709 → DCI-P3`);
    return true;
  } catch (err) {
    if (err.name === 'NoCredentialsError' || err.message?.includes('Unable to locate credentials')) {
      console.warn(`⚠️  AWS credentials not configured - skipping LUT file verification`);
      console.warn(`   This is normal in local development. Production deployment will verify.`);
    } else if (err.name === 'NoSuchKey' || err.Code === 'NoSuchKey') {
      console.warn(`❌ LUT file not found: s3://postready-staging/Awsome1.cube`);
      console.warn(`   Please verify the file exists in the S3 bucket`);
    } else if (err.name === 'AccessDenied' || err.Code === 'AccessDenied') {
      console.warn(`❌ Permission denied accessing LUT file: s3://postready-staging/Awsome1.cube`);
      console.warn(`   📋 Required IAM Policy for MediaConvert Role:`);
      console.warn(`   {`);
      console.warn(`     "Effect": "Allow",`);
      console.warn(`     "Action": "s3:GetObject",`);
      console.warn(`     "Resource": "arn:aws:s3:::postready-staging/Awsome1.cube"`);
      console.warn(`   }`);
    } else {
      console.warn(`⚠️  Could not verify LUT file: ${err.message}`);
    }
    console.warn(`   Videos will be processed without LUT color grading`);
    return false;
  }
}

async function verifyMediaConvertRolePermissions() {
  if (!process.env.AWS_MEDIACONVERT_ROLE) {
    console.warn(`⚠️  AWS_MEDIACONVERT_ROLE not set - permissions check skipped`);
    return false;
  }

  try {
    // Try to access the CUBE file as MediaConvert would
    const headCommand = new HeadObjectCommand({
      Bucket: "postready-staging",
      Key: "Awsome1.cube"
    });
    await awsS3Client.send(headCommand);
    console.log(`✅ MediaConvert role has S3:GetObject access to postready-staging/Awsome1.cube`);
    return true;
  } catch (err) {
    if (err.name === 'NoCredentialsError' || err.message?.includes('Unable to locate credentials')) {
      console.warn(`⚠️  AWS credentials not configured - permissions check skipped`);
      return false;
    } else if (err.name === 'NoSuchKey' || err.Code === 'NoSuchKey') {
      console.warn(`⚠️  CUBE LUT file does not exist: s3://postready-staging/Awsome1.cube`);
      return false;
    } else if (err.name === 'AccessDenied' || err.Code === 'AccessDenied' || err.name === 'Forbidden') {
      console.error(`❌ MediaConvert role LACKS S3:GetObject permission for postready-staging/Awsome1.cube`);
      console.error(`   Role ARN: ${process.env.AWS_MEDIACONVERT_ROLE}`);
      console.error(`   Required IAM policy:`);
      console.error(`   {`);
      console.error(`     "Effect": "Allow",`);
      console.error(`     "Action": "s3:GetObject",`);
      console.error(`     "Resource": "arn:aws:s3:::postready-staging/Awsome1.cube"`);
      console.error(`   }`);
      console.error(`   Alternatively, grant broader S3 access:`);
      console.error(`     "Resource": "arn:aws:s3:::postready-staging/*"`);
      return false;
    } else {
      console.warn(`⚠️  Could not verify MediaConvert role permissions: ${err.message}`);
      return false;
    }
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

    CREATE TABLE IF NOT EXISTS audio_files (
      id TEXT PRIMARY KEY,
      filename TEXT UNIQUE,
      s3_url TEXT,
      duration_ms INTEGER,
      sample_rate INTEGER,
      channels INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS transfer_audio_mapping (
      id TEXT PRIMARY KEY,
      transfer_id TEXT,
      audio_id TEXT,
      sync_mode TEXT DEFAULT 'timecode',
      start_offset_ms INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(transfer_id) REFERENCES processed_transfers(id),
      FOREIGN KEY(audio_id) REFERENCES audio_files(id),
      UNIQUE(transfer_id, audio_id)
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
await verifyLUTFile();
await verifyMediaConvertRolePermissions();

// Initialize AWS Job Templates
try {
  await initializePostreadyTemplate();
  const templates = await listJobTemplates();
  console.log(`✅ Found ${templates.length} AWS job template(s)`);
} catch (err) {
  console.warn(`⚠️  Could not initialize job templates: ${err.message}`);
}

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

function isAudioFile(filename) {
  const audioExtensions = ['.wav', '.mp3', '.aac', '.m4a', '.flac', '.ogg', '.wma', '.alac'];
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
  return audioExtensions.includes(ext);
}

async function processFilemailTransfer(transferId, templateName = "Postready") {
  try {
    console.log("Processing Filemail transfer:", transferId);
    console.log(`📡 Using transcode service: ${TRANSCODE_SERVICE.toUpperCase()}`);
    console.log(`🎬 Using job template: ${templateName}`);
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
    console.log(`Job Template: ${templateName}`);
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
        
        // Use MediaConvert with job template
        console.log(`🚀 Submitting to AWS MediaConvert with template: ${templateName}`);
        try {
          console.log(`   Attempting MediaConvert submission...`);
          result = await sendToMediaConvert(file.downloadurl, file.filename, templateName, transferId);
          // Store MediaConvert job in database
          await storeMediaConvertJob(result.id, transferId, file.filename, result.stagingKey);
          console.log(`✅ MediaConvert job stored: ${result.id}`);
        } catch (mcErr) {
          console.error(`\n❌ MediaConvert FAILED - NO FALLBACK`);
          console.error(`   Error: ${mcErr.message}`);
          throw mcErr;
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
  // Use simple random ID to avoid MediaConvert appending input filename to output
  const stagingId = Math.random().toString(36).substring(2, 10);
  const stagingKey = `staging/tmp_${stagingId}`;
  
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
 * Create and store a MediaConvert output preset in S3
 * Presets include timecode, color grading, and codec settings
 */
/**
 * Create an AWS MediaConvert Job Template
 */
async function createJobTemplate(templateName, templateConfig) {
  try {
    const command = new CreateJobTemplateCommand({
      Name: templateName,
      Settings: templateConfig.Settings,
      AccelerationSettings: templateConfig.AccelerationSettings || { Mode: "DISABLED" },
      StatusUpdateInterval: templateConfig.StatusUpdateInterval || "SECONDS_60",
      Priority: templateConfig.Priority || 0,
      HopDestinations: templateConfig.HopDestinations || []
    });

    const response = await mediaConvertClient.send(command);
    console.log(`✅ Job template created: ${templateName}`);
    return response;
  } catch (err) {
    console.error(`Error creating job template: ${err.message}`);
    throw err;
  }
}

/**
 * List all AWS MediaConvert Job Templates
 */
async function listJobTemplates() {
  try {
    const command = new ListJobTemplatesCommand({});
    const response = await mediaConvertClient.send(command);
    
    const templates = (response.JobTemplates || []).map(t => ({
      name: t.Name,
      arn: t.Arn,
      createdAt: t.CreatedAt,
      lastModified: t.LastModified,
      category: t.Category
    }));
    
    return templates;
  } catch (err) {
    console.warn(`Error listing job templates: ${err.message}`);
    return [];
  }
}

/**
 * Get a specific AWS MediaConvert Job Template
 */
async function getJobTemplate(templateName) {
  try {
    const command = new GetJobTemplateCommand({
      Name: templateName
    });
    const response = await mediaConvertClient.send(command);
    console.log(`✅ Loaded job template: ${templateName}`);
    return response.JobTemplate;
  } catch (err) {
    console.warn(`Job template not found: ${templateName}`);
    return null;
  }
}

/**
 * Delete an AWS MediaConvert Job Template
 */
async function deleteJobTemplate(templateName) {
  try {
    const command = new DeleteJobTemplateCommand({
      Name: templateName
    });
    const response = await mediaConvertClient.send(command);
    console.log(`✅ Job template deleted: ${templateName}`);
    return response;
  } catch (err) {
    console.error(`Error deleting job template: ${err.message}`);
    throw err;
  }
}

// Postready Job Template Configuration
const POSTREADY_TEMPLATE = {
  "Name": "Postready",
  "Settings": {
    "TimecodeConfig": {},
    "ColorConversion3DLUTSettings": [
      {
        "FileInput": "s3://postready-staging/Awsome1.cube",
        "InputColorSpace": "REC_709",
        "OutputColorSpace": "P3DCI"
      }
    ],
    "OutputGroups": [
      {
        "Name": "File Group",
        "Outputs": [
          {
            "ContainerSettings": {
              "Container": "MP4",
              "Mp4Settings": {}
            },
            "VideoDescription": {
              "Width": 1280,
              "Height": 720,
              "VideoPreprocessors": {
                "TimecodeBurnin": {
                  "FontSize": 32,
                  "Position": "TOP_LEFT"
                }
              },
              "TimecodeInsertion": "PIC_TIMING_SEI",
              "TimecodeTrack": "ENABLED",
              "CodecSettings": {
                "Codec": "H_264",
                "H264Settings": {
                  "MaxBitrate": 2000000,
                  "RateControlMode": "QVBR",
                  "SceneChangeDetect": "TRANSITION_DETECTION"
                }
              }
            },
            "AudioDescriptions": [
              {
                "CodecSettings": {
                  "Codec": "AAC",
                  "AacSettings": {
                    "Bitrate": 96000,
                    "CodingMode": "CODING_MODE_2_0",
                    "SampleRate": 48000
                  }
                }
              }
            ]
          }
        ],
        "OutputGroupSettings": {
          "Type": "FILE_GROUP_SETTINGS",
          "FileGroupSettings": {
            "Destination": "s3://postready-staging/outputs/"
          }
        }
      }
    ],
    "Inputs": [
      {
        "AudioSelectors": {
          "Audio Selector 1": {
            "DefaultSelection": "DEFAULT"
          }
        },
        "VideoSelector": {},
        "TimecodeSource": "ZEROBASED"
      }
    ]
  },
  "AccelerationSettings": {
    "Mode": "DISABLED"
  },
  "StatusUpdateInterval": "SECONDS_60",
  "Priority": 0,
  "HopDestinations": []
};

/**
 * Initialize Postready Job Template on startup
 */
async function initializePostreadyTemplate() {
  try {
    // Check if template exists
    const existing = await getJobTemplate("Postready");
    if (existing) {
      console.log(`✅ Postready template already exists`);
      console.log(`   Created: ${existing.CreatedAt}`);
      console.log(`   Updated: ${existing.LastUpdated}`);
      return existing;
    }
    
    // Create template if it doesn't exist
    console.log(`📝 Creating Postready job template...`);
    const result = await createJobTemplate("Postready", POSTREADY_TEMPLATE);
    console.log(`✅ Postready template created successfully`);
    return result;
  } catch (err) {
    console.error(`⚠️  Error initializing Postready template: ${err.message}`);
  }
}

async function createMediaConvertPreset(presetName = "default", presetConfig = null) {
  try {
    const defaultPreset = {
      name: presetName,
      description: "MediaConvert preset with timecode, DCI-P3 color grading, and LUT support",
      videoCodec: "H_264",
      width: 1920,
      height: 1080,
      framerateNumerator: 30,
      framerateDenominator: 1,
      rateControlMode: "QVBR",
      maxBitrate: 8000000,
      gopSize: 30,
      subGopLength: 1,
      timecodeInsertion: "PIC_TIMING_SEI",
      colorConversion: "REC_709_TO_DCI_P3",
      audioCodec: "AAC",
      audioBitrate: 128000,
      audioSampleRate: 48000,
      container: "MP4"
    };

    const finalConfig = presetConfig || defaultPreset;
    
    const presetKey = `presets/${presetName}.json`;
    const presetJson = JSON.stringify(finalConfig, null, 2);
    
    await awsS3Client.send(new PutObjectCommand({
      Bucket: "postready-staging",
      Key: presetKey,
      Body: presetJson,
      ContentType: "application/json"
    }));
    
    console.log(`✅ Preset stored: s3://postready-staging/${presetKey}`);
    return { presetName, presetKey, size: presetJson.length };
  } catch (err) {
    console.error(`Error creating preset: ${err.message}`);
    throw err;
  }
}

/**
 * Load a MediaConvert preset from S3
 */
async function loadMediaConvertPreset(presetName = "default") {
  try {
    const presetKey = `presets/${presetName}.json`;
    
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const result = await awsS3Client.send(new GetObjectCommand({
      Bucket: "postready-staging",
      Key: presetKey
    }));
    
    const presetJson = await result.Body.transformToString();
    const preset = JSON.parse(presetJson);
    
    console.log(`✅ Loaded preset: ${presetName}`);
    return preset;
  } catch (err) {
    console.warn(`Preset not found: ${presetName}, using defaults`);
    return null;
  }
}

/**
 * List available MediaConvert presets from S3
 */
async function listMediaConvertPresets() {
  try {
    const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
    const result = await awsS3Client.send(new ListObjectsV2Command({
      Bucket: "postready-staging",
      Prefix: "presets/"
    }));
    
    const presets = (result.Contents || [])
      .filter(obj => obj.Key.endsWith('.json'))
      .map(obj => ({
        name: obj.Key.replace('presets/', '').replace('.json', ''),
        key: obj.Key,
        size: obj.Size,
        modified: obj.LastModified
      }));
    
    return presets;
  } catch (err) {
    console.warn(`Error listing presets: ${err.message}`);
    return [];
  }
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
 * Submit video to AWS MediaConvert using a job template
 * Stages file to S3 first, then creates job from template
 */
async function sendToMediaConvert(downloadUrl, filename, templateName = "Postready", transferId = null) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📡 MEDIACONVERT SUBMISSION START`);
  console.log(`${'='.repeat(60)}`);
  console.log(`File: ${filename}`);
  console.log(`Template: ${templateName}`);
  console.log(`URL: ${downloadUrl.substring(0, 100)}...`);
  
  if (!mediaConvertClient) {
    const err = new Error("MediaConvert not configured. Missing AWS credentials or not enabled.");
    console.error(`❌ ${err.message}`);
    throw err;
  }

  const safeFilename = filename.replace(/[^\w\d_-]/g,"_");
  const nameModifier = safeFilename.replace(/\.\w+$/, "");
  console.log(`Safe filename: ${safeFilename}, NameModifier: ${nameModifier}`);
  
  let stagingInfo = null;
  
  try {
    // Stage file to S3
    console.log(`\n[Step 1/3] Staging video to S3...`);
    stagingInfo = await stageFileToS3(downloadUrl, filename);
    console.log(`✅ S3 staging complete`);
    const fileInput = stagingInfo.s3Url;
    console.log(`   Input: ${fileInput}`);
    
    // Fetch audio mappings if transfer is specified
    let audioInputs = [];
    let audioMappings = [];
    if (transferId) {
      console.log(`\n[Step 2/3] Checking for mapped audio files...`);
      audioMappings = await db.all(
        "SELECT tm.id, tm.audio_id, tm.start_offset_ms, af.s3_url, af.filename FROM transfer_audio_mapping tm JOIN audio_files af ON tm.audio_id = af.id WHERE tm.transfer_id = ?",
        [transferId]
      );
      if (audioMappings.length > 0) {
        console.log(`✅ Found ${audioMappings.length} audio file(s)`);
        
        // Process each audio file (stage Filemail URLs to S3 if needed)
        for (let i = 0; i < audioMappings.length; i++) {
          const mapping = audioMappings[i];
          console.log(`   [${i + 1}] ${mapping.filename} (offset: ${mapping.start_offset_ms}ms)`);
          
          // If URL is Filemail (http), stage it to S3 first
          if (mapping.s3_url.startsWith('http')) {
            console.log(`      🌐 Filemail URL detected, staging to S3...`);
            try {
              const stagedInfo = await stageFileToS3(mapping.s3_url, mapping.filename);
              audioMappings[i].s3_url = stagedInfo.s3Url;
              console.log(`      ✅ Staged to S3: ${audioMappings[i].s3_url}`);
            } catch (err) {
              console.warn(`      ⚠️  Failed to stage audio: ${err.message}`);
              throw err;
            }
          }
        }
      } else {
        console.log(`ℹ️  No audio mappings found`);
      }
    }
    
    // Create job with 3D LUT at Settings level (correct structure)
    console.log(`\n[Step 3/3] Creating MediaConvert job...`);
    
    // Build inputs array (video + audio)
    const inputs = [
      {
        FileInput: fileInput,
        AudioSelectors: {
          "Audio Selector 1": {
            DefaultSelection: "DEFAULT"
          }
        },
        VideoSelector: {},
        TimecodeSource: "ZEROBASED"
      }
    ];

    // Add external audio inputs
    audioMappings.forEach((mapping, idx) => {
      inputs.push({
        FileInput: mapping.s3_url,
        AudioSelectors: {
          [`Audio Selector ${idx + 2}`]: {
            DefaultSelection: "DEFAULT"
          }
        },
        TimecodeSource: "ZEROBASED"
      });
    });

    // Build audio descriptions (use first external audio if available, else use video audio)
    const audioDescriptions = [];
    if (audioMappings.length > 0) {
      // Use first external audio (from input index 1) with codec settings
      audioDescriptions.push({
        AudioSourceName: "1:Audio Selector 2",
        CodecSettings: {
          Codec: "AAC",
          AacSettings: {
            Bitrate: 96000,
            CodingMode: "CODING_MODE_2_0",
            SampleRate: 48000
          }
        }
      });
      console.log(`🔊 Using external audio: ${audioMappings[0].filename} (input index 1, Audio Selector 2)`);
    } else {
      // Use video's original audio (from input index 0, Audio Selector 1)
      audioDescriptions.push({
        AudioSourceName: "Audio Selector 1",
        CodecSettings: {
          Codec: "AAC",
          AacSettings: {
            Bitrate: 96000,
            CodingMode: "CODING_MODE_2_0",
            SampleRate: 48000
          }
        }
      });
    }

    const createJobCommand = new CreateJobCommand({
      Role: AWS_MEDIACONVERT_ROLE,
      Settings: {
        TimecodeConfig: {},
        ColorConversion3DLUTSettings: [
          {
            FileInput: "s3://postready-staging/Awsome1.cube",
            InputColorSpace: "REC_709",
            OutputColorSpace: "P3DCI"
          }
        ],
        OutputGroups: [
          {
            Name: "File Group",
            Outputs: [
              {
                ContainerSettings: {
                  Container: "MP4",
                  Mp4Settings: {}
                },
                VideoDescription: {
                  Width: 1280,
                  Height: 720,
                  VideoPreprocessors: {
                    TimecodeBurnin: {
                      FontSize: 32,
                      Position: "TOP_LEFT"
                    }
                  },
                  TimecodeInsertion: "PIC_TIMING_SEI",
                  TimecodeTrack: "ENABLED",
                  CodecSettings: {
                    Codec: "H_264",
                    H264Settings: {
                      MaxBitrate: 2000000,
                      RateControlMode: "QVBR",
                      SceneChangeDetect: "TRANSITION_DETECTION"
                    }
                  }
                },
                AudioDescriptions: audioDescriptions
              }
            ],
            OutputGroupSettings: {
              Type: "FILE_GROUP_SETTINGS",
              FileGroupSettings: {
                Destination: "s3://postready-staging/outputs/"
              }
            }
          }
        ],
        Inputs: inputs
      },
      AccelerationSettings: {
        Mode: "DISABLED"
      },
      StatusUpdateInterval: "SECONDS_60",
      Priority: 0
    });

    console.log(`Sending job creation request...`);
    const response = await mediaConvertClient.send(createJobCommand);
    console.log(`✅ API response received`);
    
    console.log(`\n✅ MediaConvert job created: ${response.Job.Id}`);
    console.log(`   Status: ${response.Job.Status}`);
    console.log(`   Template: ${templateName}`);
    console.log(`   Output: s3://postready-staging/outputs/`);
    console.log(`   🎨 3D LUT: s3://postready-staging/Awsome1.cube (ColorConversion3DLUTSettings)`);
    if (audioMappings.length > 0) {
      console.log(`   🔊 Audio: ${audioMappings[0].filename} (timecode synced)`);
    }
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
 * Download LUT from URL and upload to S3 for MediaConvert to use
 */
async function downloadAndUploadLutToS3(lutUrl) {
  try {
    // Download LUT to temporary file
    const tempLutPath = `/tmp/lut_${Date.now()}.cube`;
    await downloadFile(lutUrl, tempLutPath);
    
    // Read the file
    const lutBuffer = fs.readFileSync(tempLutPath);
    console.log(`   📊 File size: ${(lutBuffer.length / (1024 * 1024)).toFixed(2)} MB`);
    
    if (lutBuffer.length === 0) {
      throw new Error("Downloaded LUT file is empty");
    }
    
    // Upload to S3
    const s3Key = "luts/color_grade.cube";
    await awsS3Client.send(new PutObjectCommand({
      Bucket: "postready-staging",
      Key: s3Key,
      Body: lutBuffer,
      ContentType: "application/octet-stream"
    }));
    
    // Clean up temp file
    fs.unlinkSync(tempLutPath);
    
    console.log(`   ✅ LUT uploaded to S3: s3://postready-staging/${s3Key}`);
    return `s3://postready-staging/${s3Key}`;
  } catch (err) {
    console.error(`Error uploading LUT: ${err.message}`);
    throw err;
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
    console.log(`   Project ID: ${FRAMEIO_PROJECT_ID}`);
    console.log(`   Source URL: ${videoUrl.substring(0, 100)}...`);
    
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
    
    // Step 2: Create asset directly in root folder (no subfolder)
    console.log(`   Step 2: Creating asset in project root...`);
    
    // Create asset with source pointing to presigned URL
    // Frame.io will asynchronously download the file from this URL
    const requestBody = {
      name: filename,
      type: "file",
      source: {
        type: "url",
        url: videoUrl
      }
    };
    
    const createRes = await fetch(
      `https://api.frame.io/v2/assets/${rootAssetId}/children`,
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
      console.error(`   Request body was: ${JSON.stringify(requestBody)}`);
      throw new Error(`Frame.io API error ${createRes.status}: ${createResponseText}`);
    }

    const assetData = JSON.parse(createResponseText);
    console.log(`✅ Asset created in Frame.io root: ${assetData.id}`);
    console.log(`   Asset name: ${assetData.name}`);
    console.log(`   Status: Frame.io will download from presigned S3 URL`);
    console.log(`   ⏱️  File may take 2-5 minutes to appear on Frame.io`);
    
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
    const audioFiles = files.filter(f => isAudioFile(f.filename));
    const otherFiles = files.filter(f => !isVideoFile(f.filename) && !isAudioFile(f.filename));
    
    res.json({
      transferId,
      summary: {
        totalFiles: files.length,
        videoFiles: videoFiles.length,
        audioFiles: audioFiles.length,
        otherFiles: otherFiles.length
      },
      videos: videoFiles.map(f => ({
        filename: f.filename,
        downloadurl: f.downloadurl,
        size: f.filesize
      })),
      audio: audioFiles.map(f => ({
        filename: f.filename,
        downloadurl: f.downloadurl,
        size: f.filesize
      })),
      skipped: otherFiles.map(f => f.filename)
    });
  } catch (err) {
    console.error("Preview error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Auto-detect and map audio files from transfer
 * POST /transfer/{transferId}/auto-detect-audio
 * Scans Filemail transfer for .wav/.mp3/etc files and auto-maps them
 */
app.post("/transfer/:transferId/auto-detect-audio", async (req, res) => {
  try {
    const { transferId } = req.params;
    console.log(`Auto-detecting audio files for transfer: ${transferId}`);

    // Verify transfer exists
    const transfer = await db.get("SELECT id FROM processed_transfers WHERE id = ?", [transferId]);
    if (!transfer) {
      return res.status(404).json({ error: "Transfer not found" });
    }

    // Fetch files from Filemail
    const files = await getFilemailFiles(transferId);
    const audioFiles = files.filter(f => isAudioFile(f.filename));

    if (audioFiles.length === 0) {
      return res.json({
        success: true,
        transferId,
        audioFilesFound: 0,
        message: "No audio files found in transfer",
        mappings: []
      });
    }

    console.log(`✅ Found ${audioFiles.length} audio file(s) in transfer`);

    // Auto-map each audio file
    const mappings = [];
    for (const audioFile of audioFiles) {
      const audioId = `audio_filemail_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const mappingId = `mapping_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      try {
        // Store Filemail audio as downloadable audio reference
        await db.run(
          "INSERT INTO audio_files (id, filename, s3_url, duration_ms) VALUES (?, ?, ?, ?)",
          [audioId, audioFile.filename, audioFile.downloadurl, null]
        );

        // Create mapping
        await db.run(
          "INSERT OR REPLACE INTO transfer_audio_mapping (id, transfer_id, audio_id, sync_mode, start_offset_ms) VALUES (?, ?, ?, ?, ?)",
          [mappingId, transferId, audioId, "timecode", 0]
        );

        console.log(`   ✅ Mapped: ${audioFile.filename} (${audioId})`);
        mappings.push({
          audioId,
          mappingId,
          filename: audioFile.filename,
          size: audioFile.filesize
        });
      } catch (err) {
        console.warn(`   ⚠️  Failed to map ${audioFile.filename}: ${err.message}`);
      }
    }

    res.json({
      success: true,
      transferId,
      audioFilesFound: audioFiles.length,
      audioFilesMapped: mappings.length,
      message: `Auto-mapped ${mappings.length} audio file(s)`,
      mappings
    });
  } catch (err) {
    console.error("Auto-detect audio error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Confirm and process a transfer - requires manual approval
 */
app.post("/process/transfer/:transferId", async (req, res) => {
  try {
    const { transferId } = req.params;
    const { templateName = "Postready" } = req.body; // Allow specifying job template
    
    console.log(`\n📌 PROCESSING STARTED FOR TRANSFER: ${transferId}`);
    console.log(`   Job Template: ${templateName}`);
    
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
    
    // Start processing with selected job template
    processFilemailTransfer(transferId, templateName);
    
    res.json({ 
      success: true, 
      message: "Transfer processing started",
      transferId,
      templateName,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error("Process error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Audio Management Endpoints
 */

/**
 * List available audio files
 */
app.get("/audio/list", async (req, res) => {
  try {
    const audioFiles = await db.all("SELECT id, filename, duration_ms, sample_rate, channels, created_at FROM audio_files ORDER BY created_at DESC");
    res.json({
      success: true,
      count: audioFiles.length,
      audioFiles
    });
  } catch (err) {
    console.error("Audio list error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Upload audio file (binary)
 * POST /audio/upload
 * Headers: x-filename, x-duration-ms (optional), x-sample-rate (optional), x-channels (optional)
 */
app.post("/audio/upload", async (req, res) => {
  try {
    const filename = req.headers["x-filename"];
    const durationMs = parseInt(req.headers["x-duration-ms"]) || null;
    const sampleRate = parseInt(req.headers["x-sample-rate"]) || null;
    const channels = parseInt(req.headers["x-channels"]) || null;

    if (!filename) {
      return res.status(400).json({ error: "x-filename header required" });
    }

    // Collect binary data
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    
    req.on("end", async () => {
      try {
        const buffer = Buffer.concat(chunks);
        const audioId = `audio_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const s3Key = `audio/${filename}`;

        // Upload to S3
        const uploadCommand = new PutObjectCommand({
          Bucket: "postready-staging",
          Key: s3Key,
          Body: buffer,
          ContentType: "audio/wav"
        });
        await awsS3Client.send(uploadCommand);

        const s3Url = `s3://postready-staging/${s3Key}`;

        // Save to database
        await db.run(
          "INSERT INTO audio_files (id, filename, s3_url, duration_ms, sample_rate, channels) VALUES (?, ?, ?, ?, ?, ?)",
          [audioId, filename, s3Url, durationMs, sampleRate, channels]
        );

        console.log(`✅ Audio uploaded: ${filename} (${buffer.length} bytes)`);
        res.json({
          success: true,
          audioId,
          filename,
          s3Url,
          durationMs,
          sampleRate,
          channels
        });
      } catch (err) {
        console.error("Audio upload error:", err);
        res.status(500).json({ error: err.message });
      }
    });
  } catch (err) {
    console.error("Audio upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Map audio to transfer (for timecode-based sync)
 * POST /transfer/{transferId}/audio
 */
app.post("/transfer/:transferId/audio", async (req, res) => {
  try {
    const { transferId } = req.params;
    const { audioId, startOffsetMs } = req.body;

    if (!audioId) {
      return res.status(400).json({ error: "audioId required in body" });
    }

    // Verify audio exists
    const audio = await db.get("SELECT id FROM audio_files WHERE id = ?", [audioId]);
    if (!audio) {
      return res.status(404).json({ error: "Audio file not found" });
    }

    // Verify transfer exists
    const transfer = await db.get("SELECT id FROM processed_transfers WHERE id = ?", [transferId]);
    if (!transfer) {
      return res.status(404).json({ error: "Transfer not found" });
    }

    const mappingId = `mapping_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Create mapping
    await db.run(
      "INSERT OR REPLACE INTO transfer_audio_mapping (id, transfer_id, audio_id, sync_mode, start_offset_ms) VALUES (?, ?, ?, ?, ?)",
      [mappingId, transferId, audioId, "timecode", startOffsetMs || 0]
    );

    console.log(`✅ Audio mapped to transfer: ${transferId} <- ${audioId}`);
    res.json({
      success: true,
      message: "Audio mapped to transfer",
      mappingId,
      transferId,
      audioId,
      startOffsetMs: startOffsetMs || 0
    });
  } catch (err) {
    console.error("Audio mapping error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get audio mapping for transfer
 * GET /transfer/{transferId}/audio
 */
app.get("/transfer/:transferId/audio", async (req, res) => {
  try {
    const { transferId } = req.params;
    const mappings = await db.all(
      "SELECT tm.id, tm.transfer_id, tm.audio_id, tm.sync_mode, tm.start_offset_ms, af.filename, af.s3_url, af.duration_ms FROM transfer_audio_mapping tm LEFT JOIN audio_files af ON tm.audio_id = af.id WHERE tm.transfer_id = ?",
      [transferId]
    );

    res.json({
      success: true,
      transferId,
      audioMappings: mappings
    });
  } catch (err) {
    console.error("Audio mapping query error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Remove audio mapping
 * DELETE /transfer/{transferId}/audio/{audioId}
 */
app.delete("/transfer/:transferId/audio/:audioId", async (req, res) => {
  try {
    const { transferId, audioId } = req.params;
    
    const result = await db.run(
      "DELETE FROM transfer_audio_mapping WHERE transfer_id = ? AND audio_id = ?",
      [transferId, audioId]
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: "Audio mapping not found" });
    }

    console.log(`✅ Audio removed from transfer: ${transferId}`);
    res.json({
      success: true,
      message: "Audio mapping removed",
      transferId,
      audioId
    });
  } catch (err) {
    console.error("Audio removal error:", err);
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
 * GET /db/permissions - Verify AWS role permissions for CUBE LUT
 */
app.get("/db/permissions", async (req, res) => {
  try {
    const hasAccess = await verifyMediaConvertRolePermissions();
    const lutFileExists = await verifyLUTFile();
    
    res.json({
      success: true,
      mediaConvertRole: process.env.AWS_MEDIACONVERT_ROLE || "not set",
      cubeFile: {
        path: "s3://postready-staging/Awsome1.cube",
        exists: lutFileExists,
        accessible: hasAccess
      },
      requiredPolicy: {
        Effect: "Allow",
        Action: "s3:GetObject",
        Resource: "arn:aws:s3:::postready-staging/Awsome1.cube"
      },
      status: hasAccess && lutFileExists ? "✅ Ready for LUT color grading" : "⚠️ LUT color grading not available"
    });
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
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
      // Get the original filename from the database (not from the S3 URL which has temp prefix)
      const jobRow = await db.get("SELECT filename FROM coconut_jobs WHERE id = ?", [jobId]);
      let originalFilename = jobRow?.filename || `${jobId}.mp4`;
      
      // Remove [MC] marker if present
      originalFilename = originalFilename.replace(/^\[MC\]\s/, '');
      
      // Check if this is a MediaConvert job
      const isMediaConvertJob = jobRow?.filename?.startsWith("[MC]");
      
      if (isMediaConvertJob) {
        console.log(`🎬 MediaConvert job detected - skipping FFmpeg (already has LUT + timecode)`);
        console.log(`📤 Video is ready in Wasabi: ${outputUrl}`);
        
        // Go directly to Frame.io upload for MediaConvert jobs
        uploadToFrameIO(outputUrl, originalFilename)
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
        
        postProcessWithFFmpeg(outputUrl, outputUrl, originalFilename)
          .then((processedUrl) => {
            console.log(`✅ Post-processing complete: ${processedUrl}`);
            console.log(`📤 Video is ready: ${processedUrl}`);
            
            // Try to upload to Frame.io after post-processing
            // This is non-blocking - video is already safely stored
            uploadToFrameIO(processedUrl, originalFilename)
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
      
      console.log(`🔍 Looking for output in webhook message...`);
      console.log(`   - Has outputGroupDetails? ${!!message.detail?.outputGroupDetails}`);
      console.log(`   - OutputGroupDetails count: ${message.detail?.outputGroupDetails?.length || 0}`);
      if (message.detail?.outputGroupDetails?.[0]) {
        console.log(`   - First group has outputDetails? ${!!message.detail.outputGroupDetails[0].outputDetails}`);
        console.log(`   - First group outputDetails count: ${message.detail.outputGroupDetails[0].outputDetails?.length || 0}`);
        if (message.detail.outputGroupDetails[0].outputDetails?.[0]) {
          console.log(`   - First detail has outputFilePaths? ${!!message.detail.outputGroupDetails[0].outputDetails[0].outputFilePaths}`);
          console.log(`   - First detail outputFilePaths count: ${message.detail.outputGroupDetails[0].outputDetails[0].outputFilePaths?.length || 0}`);
        }
      }
      
      // Try multiple paths to find the output
      let outputPath = null;
      
      // Path 1: Standard webhook response structure
      if (message.detail?.outputGroupDetails?.[0]?.outputDetails?.[0]?.outputFilePaths?.[0]) {
        outputPath = message.detail.outputGroupDetails[0].outputDetails[0].outputFilePaths[0];
        console.log(`✅ Found output via Path 1 (outputGroupDetails): ${outputPath}`);
      }
      
      // Path 2: Try alternative structure
      if (!outputPath && message.detail?.job?.Settings?.OutputGroups?.[0]?.Outputs?.[0]?.OutputSettings?.S3OutputSettings) {
        const s3Settings = message.detail.job.Settings.OutputGroups[0].Outputs[0].OutputSettings.S3OutputSettings;
        outputPath = `${s3Settings.S3Bucket}/${s3Settings.S3Prefix || ''}`;
        console.log(`✅ Found output via Path 2 (Settings): ${outputPath}`);
      }
      
      // If still not found, try to construct from job details
      if (!outputPath && message.detail?.outputGroupDetails?.[0]) {
        console.log(`   Webhook structure keys:`, Object.keys(message.detail?.outputGroupDetails?.[0] || {}));
      }
      
      if (outputPath) {
        // Extract just the filename
        const outputKey = outputPath.replace("s3://postready-staging/outputs/", "").replace("postready-staging/outputs/", "");
        
        console.log(`   Extracted output key: ${outputKey}`);
        
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
        console.error(`   Full detail object keys:`, Object.keys(message.detail || {}));
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

/* ==================== MEDIACONVERT PRESETS ==================== */

/**
 * POST /api/presets - Create a new MediaConvert preset
 */
/**
 * POST /api/job-templates - Create a new job template
 */
app.post("/api/job-templates", async (req, res) => {
  try {
    const { name = "custom", config } = req.body;
    
    if (!name || !config || !config.Settings) {
      return res.status(400).json({ error: "name and config with Settings required" });
    }
    
    const result = await createJobTemplate(name, config);
    res.json({
      success: true,
      message: `✅ Job template created: ${name}`,
      template: {
        name: result.JobTemplate?.Name,
        arn: result.JobTemplate?.Arn,
        createdAt: result.JobTemplate?.CreatedAt
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/job-templates - List all available job templates
 */
app.get("/api/job-templates", async (req, res) => {
  try {
    const templates = await listJobTemplates();
    res.json({
      success: true,
      count: templates.length,
      templates
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/job-templates/:name - Get a specific job template
 */
app.get("/api/job-templates/:name", async (req, res) => {
  try {
    const template = await getJobTemplate(req.params.name);
    if (!template) {
      return res.status(404).json({ error: "Job template not found" });
    }
    res.json({
      success: true,
      name: req.params.name,
      template
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/job-templates/:name - Delete a job template
 */
app.delete("/api/job-templates/:name", async (req, res) => {
  try {
    await deleteJobTemplate(req.params.name);
    res.json({
      success: true,
      message: `✅ Job template deleted: ${req.params.name}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
    console.log(`Job error (if any): ${job.ErrorMessage || 'None'}`);
    console.log(`Job has outputs: ${job.OutputGroupDetails?.length > 0}`);
    
    if (job.Status === "COMPLETE") {
      console.log(`✅ Job complete! Extracting output...`);
      
      // Extract output filename from MediaConvert settings
      const outputGroup = job.Settings?.OutputGroups?.[0];
      if (!outputGroup) {
        console.error(`❌ No OutputGroup found in job settings`);
        return res.status(200).json({ success: false, status: "failed", jobId, error: "No output group in settings" });
      }

      const output = outputGroup.Outputs?.[0];
      const destination = outputGroup.OutputGroupSettings?.FileGroupSettings?.Destination;
      
      if (!output || !destination) {
        console.error(`❌ Missing output or destination in OutputGroup`);
        return res.status(200).json({ success: false, status: "failed", jobId, error: "Missing output/destination" });
      }

      // Get the actual output filename from MediaConvert job details
      // Since MediaConvert may modify the NameModifier with timestamps, we need to list S3 and find it
      const nameModifier = output.NameModifier || "";
      const container = output.ContainerSettings?.Container || "MP4";
      const fileExtension = container === "MP4" ? ".mp4" : ".mov";
      
      console.log(`   Destination: ${destination}`);
      console.log(`   NameModifier: ${nameModifier}`);
      
      // List objects in outputs folder to find the actual file
      let actualOutputKey = null;
      try {
        console.log(`   🔄 About to list S3 outputs folder...`);
        const listCommand = new ListObjectsV2Command({
          Bucket: "postready-staging",
          Prefix: "outputs/"
        });
        console.log(`   📡 ListObjectsV2Command created, sending to S3...`);
        const listResult = await awsS3Client.send(listCommand);
        console.log(`   ✅ ListObjectsV2 succeeded, result:`, JSON.stringify({
          ContentsCount: listResult.Contents?.length || 0,
          IsTruncated: listResult.IsTruncated,
          ContinuationToken: !!listResult.ContinuationToken
        }));
        
        console.log(`   📂 S3 outputs folder contents:`);
        if (listResult.Contents && listResult.Contents.length > 0) {
          console.log(`       Found ${listResult.Contents.length} files:`);
          listResult.Contents.forEach(obj => {
            const sizeInMB = (obj.Size / 1024 / 1024).toFixed(2);
            console.log(`       - ${obj.Key} (${sizeInMB} MB, modified: ${obj.LastModified})`);
          });
          
          // Find the most recent file (ordered by modification time)
          // This avoids matching old files with duplicate nameModifiers
          const sortedByTime = listResult.Contents
            .filter(obj => obj.Key.endsWith(fileExtension))
            .sort((a, b) => (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0));
          
          if (sortedByTime.length > 0) {
            // Get the most recently modified file
            actualOutputKey = sortedByTime[0].Key.replace("outputs/", "");
            console.log(`   📊 Found ${sortedByTime.length} output files (${fileExtension}), using most recent: ${actualOutputKey}`);
          } else {
            console.warn(`   ⚠️  No files matching extension ${fileExtension} found`);
          }
        } else {
          console.warn(`   ⚠️  outputs folder is empty!`);
        }
      } catch (err) {
        console.error(`❌ Error listing S3 objects:`, err.message);
        console.error(`   Full error:`, err);
      }
      
      if (!actualOutputKey) {
        console.error(`❌ Could not find output file matching: ${nameModifier}${fileExtension}`);
        return res.status(200).json({ success: false, status: "processing", jobId, error: "Output file not found in S3" });
      }
      
      const outputPath = `s3://postready-staging/outputs/${actualOutputKey}`;
      console.log(`   ✅ Found output file: ${actualOutputKey}`);
      console.log(`   Full S3 path: ${outputPath}`);
      
      // Verify file size
      try {
        const headObject = await awsS3Client.send(new HeadObjectCommand({
          Bucket: "postready-staging",
          Key: `outputs/${actualOutputKey}`
        }));
        console.log(`   File size: ${(headObject.ContentLength / 1024 / 1024).toFixed(2)} MB`);
      } catch (err) {
        console.error(`❌ Error getting file details: ${err.message}`);
        return res.status(200).json({ success: false, status: "processing", jobId, error: "Could not verify output file" });
      }
      
      // Get signed URL for Frame.io
      const signedUrl = await getSignedS3Url(actualOutputKey);
      console.log(`✅ Generated signed S3 URL for Frame.io`);
      
      // Extract clean filename for Frame.io (remove S3 staging temp prefixes)
      // S3 key format: tmp_<prefix>_<originalname>.<ext> → extract just <originalname>.<ext>
      let frameioFilename = actualOutputKey;
      const tempPrefixMatch = actualOutputKey.match(/^tmp_[^_]+_(.+)$/);
      if (tempPrefixMatch) {
        frameioFilename = tempPrefixMatch[1];
        console.log(`   Cleaned filename for Frame.io: ${frameioFilename}`);
      }
      
      // Update job in database with AWS S3 URL
      await updateCoconutJob(jobId, "completed", outputPath);
      
      // Upload to Frame.io using signed URL
      uploadToFrameIO(signedUrl, frameioFilename)
        .catch(err => console.warn(`Frame.io upload failed: ${err.message}`));
      
      return res.status(200).json({ 
        success: true, 
        status: "completed",
        jobId,
        s3Url: outputPath,
        outputKey: actualOutputKey
      });
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

/**
 * Poll pending MediaConvert jobs and complete them when ready
 * This is called periodically to check for job completion
 */
async function pollPendingMediaConvertJobs() {
  try {
    // Get all pending MediaConvert jobs (marked with [MC] in filename)
    const pendingJobs = await db.all(
      "SELECT * FROM coconut_jobs WHERE status = ? AND filename LIKE ?",
      ["pending", "[MC]%"]
    );

    if (pendingJobs.length === 0) return;

    console.log(`\n🔍 Polling ${pendingJobs.length} pending MediaConvert job(s)...`);

    for (const job of pendingJobs) {
      try {
        const getJobCommand = new GetJobCommand({ Id: job.id });
        const response = await mediaConvertClient.send(getJobCommand);
        const mcJob = response.Job;

        console.log(`   Job ${job.id.substring(0, 12)}... Status: ${mcJob.Status}`);

        if (mcJob.Status === "COMPLETE") {
          console.log(`✅ MediaConvert job completed: ${job.id}`);
          
          // Log any warnings or messages from MediaConvert
          if (mcJob.Messages && mcJob.Messages.length > 0) {
            console.log(`⚠️  MediaConvert Messages:`);
            mcJob.Messages.forEach(msg => console.log(`   - ${msg}`));
          }
          if (mcJob.Warnings && mcJob.Warnings.length > 0) {
            console.log(`⚠️  MediaConvert Warnings:`);
            mcJob.Warnings.forEach(warn => console.log(`   - ${JSON.stringify(warn)}`));
          }

          // Extract output URL from MediaConvert response
          let outputUrl = null;
          
          // Try multiple possible response formats
          if (mcJob.OutputGroupDetails && mcJob.OutputGroupDetails.length > 0) {
            const outputGroup = mcJob.OutputGroupDetails[0];
            if (outputGroup.OutputDetails && outputGroup.OutputDetails.length > 0) {
              const outputDetail = outputGroup.OutputDetails[0];
              if (outputDetail.OutputFilePaths && outputDetail.OutputFilePaths.length > 0) {
                outputUrl = outputDetail.OutputFilePaths[0];
                console.log(`   Found output via OutputGroupDetails: ${outputUrl}`);
              }
            }
          }
          
          // Alternative: check if output is in the Settings
          if (!outputUrl && mcJob.Settings?.OutputGroups?.[0]) {
            const outputGroup = mcJob.Settings.OutputGroups[0];
            const destination = outputGroup.OutputGroupSettings?.FileGroupSettings?.Destination;
            if (destination) {
              // Construct output URL from destination + output name modifier
              const outputSettings = outputGroup.Outputs?.[0];
              const nameModifier = outputSettings?.NameModifier || "output.mp4";
              outputUrl = `${destination}${nameModifier}`;
              console.log(`   Found output via Settings: ${outputUrl}`);
            }
          }

          console.log(`   Response keys: ${Object.keys(mcJob).join(", ")}`);
          console.log(`   OutputGroupDetails: ${mcJob.OutputGroupDetails ? "✓" : "✗"}`);
          console.log(`   Settings.OutputGroups: ${mcJob.Settings?.OutputGroups ? "✓" : "✗"}`);
          
          // Debug: Show full output paths if they exist
          if (mcJob.OutputGroupDetails?.[0]?.OutputDetails?.[0]) {
            console.log(`   OutputDetail keys: ${Object.keys(mcJob.OutputGroupDetails[0].OutputDetails[0]).join(", ")}`);
            console.log(`   Full OutputDetail: ${JSON.stringify(mcJob.OutputGroupDetails[0].OutputDetails[0]).substring(0, 300)}`);
          }
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
                } else {
                  console.warn(`   ⚠️  No .mp4 files found in outputs/`);
                }
              } else {
                console.warn(`   ⚠️  outputs/ folder is empty!`);
              }
            } catch (listErr) {
              console.error(`❌ Error listing S3:`, listErr.message);
            }
            
            // If we found an actual file, use that; otherwise try the reported path
            if (actualS3Key) {
              console.log(`   ✅ Using actual S3 file: outputs/${actualS3Key}`);
              outputUrl = `s3://postready-staging/outputs/${actualS3Key}`;
              
              // Verify file size
              try {
                const headCommand = new HeadObjectCommand({
                  Bucket: "postready-staging",
                  Key: `outputs/${actualS3Key}`
                });
                const s3FileInfo = await awsS3Client.send(headCommand);
                console.log(`   📦 S3 file size: ${(s3FileInfo.ContentLength / 1024 / 1024).toFixed(2)} MB`);
                if (s3FileInfo.ContentLength < 100000) {
                  console.warn(`⚠️  WARNING: Output file is very small (${s3FileInfo.ContentLength} bytes)!`);
                  console.warn(`   This suggests MediaConvert may not have encoded the video properly.`);
                }
              } catch (sizeErr) {
                console.error(`❌ Could not verify file:`, sizeErr.message);
              }
            } else {
              // Fallback: try to verify the reported path
              console.log(`   🔄 File not found via listing, trying reported path...`);
              try {
                const s3Key = outputUrl.includes("outputs/") ? outputUrl.split("outputs/")[1] : outputUrl.split("postready-staging/")[1];
                console.log(`   🔍 S3 HeadObject check for: ${s3Key}`);
                const headCommand = new HeadObjectCommand({
                  Bucket: "postready-staging",
                  Key: s3Key
                });
                const s3FileInfo = await awsS3Client.send(headCommand);
                console.log(`   📦 S3 file size: ${(s3FileInfo.ContentLength / 1024 / 1024).toFixed(2)} MB`);
              } catch (sizeErr) {
                console.warn(`Could not verify reported file:`, sizeErr.message);
                console.warn(`   ⚠️  File does not exist in S3 - skipping for now`);
                return; // Skip this job, try again later
              }
            }
            
            // Convert S3 path to presigned HTTPS URL for Frame.io
            let frameioUrl = outputUrl;
            if (outputUrl.startsWith("s3://")) {
              try {
                let s3Path = outputUrl;
                if (outputUrl.includes("s3://")) {
                  s3Path = outputUrl.split("s3://postready-staging/")[1] || outputUrl.split("postready-staging/")[1];
                }
                
                // Remove leading slash if present
                if (s3Path.startsWith("/")) {
                  s3Path = s3Path.substring(1);
                }
                
                console.log(`   Original S3 URL: ${outputUrl}`);
                console.log(`   Extracted S3 path: ${s3Path}`);
                
                // Generate presigned URL with 24-hour expiration for Frame.io download
                const { GetObjectCommand } = await import("@aws-sdk/client-s3");
                const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
                
                const awsS3Client = new S3Client({
                  region: AWS_REGION,
                  credentials: {
                    accessKeyId: AWS_ACCESS_KEY_ID,
                    secretAccessKey: AWS_SECRET_ACCESS_KEY
                  }
                });
                
                const getCommand = new GetObjectCommand({
                  Bucket: "postready-staging",
                  Key: s3Path
                });
                
                // Use 24-hour expiration (86400 seconds) to ensure Frame.io can download fully
                const presignedUrl = await getSignedUrl(awsS3Client, getCommand, { expiresIn: 86400 });
                console.log(`   ✅ Presigned URL created (expires in 24 hours)`);
                console.log(`   Full presigned URL length: ${presignedUrl.length} chars`);
                
                frameioUrl = presignedUrl;
                console.log(`   Using presigned S3 URL for Frame.io: ${frameioUrl.substring(0, 100)}...`);
              } catch (urlErr) {
                console.warn(`⚠️  Failed to create presigned URL: ${urlErr.message}`);
                // Fallback: use S3 URL with path-style access
                let s3Path = outputUrl.split("s3://postready-staging/")[1] || outputUrl.split("postready-staging/")[1];
                if (s3Path.startsWith("/")) s3Path = s3Path.substring(1);
                frameioUrl = `https://s3.us-east-1.amazonaws.com/postready-staging/${s3Path}`;
                console.log(`   Fallback to path-style S3 URL: ${frameioUrl.substring(0, 100)}...`);
              }
            }
            
            // Simulate webhook completion
            const originalFilename = job.filename.replace(/^\[MC\]\s/, '');
            console.log(`\n🎬 MediaConvert job detected - skipping FFmpeg (already has LUT + timecode)`);
            console.log(`📤 Video is ready in Wasabi: ${outputUrl}`);
            console.log(`📎 Frame.io URL: ${frameioUrl.substring(0, 100)}...`);

            // Upload to Frame.io with presigned URL
            uploadToFrameIO(frameioUrl, originalFilename)
              .then((frameioResult) => {
                if (frameioResult) {
                  console.log(`✅ Uploaded to Frame.io: ${frameioResult.id}`);
                } else {
                  console.warn(`⚠️  Frame.io upload skipped or failed`);
                }
              })
              .catch((err) => {
                console.error(`⚠️  Frame.io upload failed: ${err.message}`);
              });

            // Update job status in database
            await updateCoconutJob(job.id, "completed", outputUrl, null);
            console.log(`✅ Job status updated to completed`);

            // Clean up S3 staging
            if (job.metadata) {
              try {
                const metadata = JSON.parse(job.metadata);
                if (metadata.stagingKey) {
                  await cleanupS3Staging(metadata.stagingKey);
                }
              } catch (parseErr) {
                console.warn(`Could not parse metadata: ${parseErr.message}`);
              }
            }
          } else {
            console.warn(`❌ No output URL found in MediaConvert job response`);
            await updateCoconutJob(job.id, "failed", null, "No output URL in MediaConvert response");
          }
        } else if (mcJob.Status === "ERROR" || mcJob.Status === "CANCELED") {
          console.error(`❌ MediaConvert job failed: ${job.id}`);
          const errorMsg = mcJob.ErrorMessage || mcJob.Status;
          await updateCoconutJob(job.id, "failed", null, errorMsg);

          // Clean up S3 staging on error
          if (job.metadata) {
            try {
              const metadata = JSON.parse(job.metadata);
              if (metadata.stagingKey) {
                await cleanupS3Staging(metadata.stagingKey);
              }
            } catch (parseErr) {
              console.warn(`Could not parse metadata: ${parseErr.message}`);
            }
          }
        }
      } catch (err) {
        console.error(`   Error checking job ${job.id}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`❌ Error polling jobs: ${err.message}`);
  }
}

/**
 * Start polling pending jobs every 30 seconds
 */
if (mediaConvertClient) {
  setInterval(() => pollPendingMediaConvertJobs(), 30 * 1000);
  console.log(`✅ MediaConvert job polling started (every 30 seconds)`);
}