// node /Users/robmaas/Desktop/iMac/Projects/postready_handling/index
import fetch from "node-fetch";
import express from "express";
import dotenv from "dotenv";
import coconut from "coconutjs";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import fs from "fs";
import path from "path";
import { execSync, spawnSync } from "child_process";
import https from "https";
import http from "http";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

// Wasabi S3 client
const s3Client = new S3Client({
  endpoint: "https://s3.eu-central-1.wasabisys.com",
  region: "eu-central-1",
  credentials: {
    accessKeyId: "BVH9EMMKPXKS8W50LDV2",
    secretAccessKey: "daRvOFjpbeJ9DHKlzJ4RQOBA5AdNjpOXkuksA9pM"
  }
});

// Cache for Frame.io dailies folder ID (to avoid creating it repeatedly)
let frameIODailiesFolderId = null;

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
  console.log("Filemail transfer data:", JSON.stringify(data, null, 2));

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
    console.log("Fetching Filemail files...");
    const files = await getFilemailFiles(transferId);
    console.log("Found files:", files);

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
    console.log("=".repeat(60) + "\n");

    for (const file of files) {
      // Only process video files
      if (!isVideoFile(file.filename)) {
        console.log("Skipping non-video file:", file.filename);
        continue;
      }
      
      // Check if job already exists (avoid duplicate Coconut submissions)
      if (await jobExists(transferId, file.filename)) {
        console.log("Job already exists for:", file.filename, "- skipping to avoid duplicate cost");
        continue;
      }
      
      console.log("Creating Coconut job for:", file.filename);
      try {
        // Submit directly to Coconut with Filemail URL (no staging needed)
        console.log(`🚀 Submitting to Coconut (direct from Filemail URL)`);
        const result = await sendToCoconut(file.downloadurl, file.filename);
        console.log("Coconut job created:", result.id);
        
        // Store job in database
        await storeCoconutJob(result.id, transferId, file.filename);
        console.log("Job stored in database:", result.id);
      } catch (err) {
        console.error("Coconut error for file:", file.filename, err.message);
      }
    }

    console.log("Waiting for Coconut webhooks...");
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
 * Download a file from URL to local filesystem
 */
async function downloadFile(url, filepath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filepath);
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (response) => {
      // Handle redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        return downloadFile(response.headers.location, filepath).then(resolve).catch(reject);
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(filepath, () => {}); // Delete file on error
      reject(err);
    });
  });
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
 * Apply timecode and LUT color grading using ffmpeg
 * ⚠️  DISABLED: Complex post-processing caused OOM kills on Fly.io
 * For now, return Coconut output directly without further processing
 * 
 * TODO: Re-enable with streaming approach:
 * - Stream video from S3 directly to FFmpeg stdin
 * - Stream FFmpeg output directly to S3
 * - Only download small files (LUT, metadata)
 */
async function postProcessWithFFmpeg(inputMp4Url, sourceVideoUrl, filename) {
  try {
    console.log(`⏭️  Skipping post-processing (OOM mitigation): ${filename}`);
    console.log(`📌 Returning Coconut output directly: ${inputMp4Url}`);
    
    // For now, simply return the Coconut URL without additional processing
    // This avoids downloading and re-encoding large video files
    return inputMp4Url;
    
  } catch (err) {
    console.error(`❌ Post-processing error: ${err.message}`);
    throw err;
  } finally {
    // No cleanup needed since we're not downloading files
    // (Old code left below for reference when re-enabling)
  }
}

/**
 * Upload a local file to Wasabi S3
 */
async function uploadToWasabi(localFilePath, s3Key) {
  console.log(`📤 Uploading to Wasabi: ${s3Key}`);
  
  // Use stream instead of readFileSync to avoid OOM on large files
  const fileStream = fs.createReadStream(localFilePath);
  
  const command = new PutObjectCommand({
    Bucket: "strawberries",
    Key: s3Key,
    Body: fileStream,
    ContentType: "video/mp4"
  });
  
  await s3Client.send(command);
  
  const wasabiUrl = `https://s3.eu-central-1.wasabisys.com/strawberries/${s3Key}`;
  console.log(`✅ Uploaded to Wasabi: ${wasabiUrl}`);
  
  return wasabiUrl;
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
    
    // Step 2: Find or create 'dailies' folder (only once, cached globally)
    let dailiesFolderId = frameIODailiesFolderId;
    
    if (!dailiesFolderId) {
      console.log(`   Step 2: Looking for 'dailies' folder (first time)...`);
      
      // Fetch root folder's children to find 'dailies'
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
          frameIODailiesFolderId = dailiesFolderId;  // Cache it
          console.log(`   Found existing 'dailies' folder: ${dailiesFolderId}`);
        }
      }

      // If 'dailies' folder doesn't exist, create it
      if (!dailiesFolderId) {
        console.log(`   'dailies' folder not found, creating...`);
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
          frameIODailiesFolderId = dailiesFolderId;  // Cache it
          console.log(`   Created 'dailies' folder: ${dailiesFolderId}`);
        } else {
          throw new Error(`Failed to create 'dailies' folder: ${createFolderRes.status}`);
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
    
    // Create asset with source pointing to presigned URL - Frame.io can access this
    const createRes = await fetch(
      `https://api.frame.io/v2/assets/${dailiesFolderId}/children`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${FRAMEIO_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          name: filename,
          type: "file",
          filetype: "video/mp4",
          source: {
            type: "url",
            url: presignedUrl
          }
        })
      }
    );

    const createResponseText = await createRes.text();
    
    if (!createRes.ok) {
      console.error(`❌ Frame.io API error ${createRes.status}`);
      console.error(`   Response: ${createResponseText}`);
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
    
    // If completed, run ffmpeg post-processing then upload to Frame.io
    if (status === "completed" && outputUrl) {
      // Extract filename from the output URL or use job ID
      const urlParts = outputUrl.split("/");
      const filename = urlParts[urlParts.length - 1] || `${jobId}.mp4`;
      
      console.log(`🎬 Starting ffmpeg post-processing for: ${filename}`);
      
      postProcessWithFFmpeg(outputUrl, outputUrl, filename)
        .then((processedUrl) => {
          console.log(`✅ Post-processing complete: ${processedUrl}`);
          console.log(`📤 Video is ready in Wasabi: ${processedUrl}`);
          
          // Try to upload to Frame.io after post-processing
          // This is non-blocking - video is already safely stored in Wasabi
          uploadToFrameIO(processedUrl, filename)
            .then((frameioResult) => {
              if (frameioResult) {
                console.log(`✅ Also uploaded to Frame.io: ${frameioResult.id}`);
              } else {
                console.warn(`⚠️  Frame.io upload skipped or failed (video is safe in Wasabi)`);
              }
            })
            .catch((err) => {
              console.error(`⚠️  Frame.io upload failed (non-blocking): ${err.message}`);
              console.log(`   Video is safely stored in Wasabi - Frame.io is optional`);
            });
        })
        .catch((err) => {
          console.error(`❌ Post-processing failed:`, err.message);
        });
    } else if (status === "completed" && !outputUrl) {
      console.error(`❌ Job ${jobId} completed but no output URL found - cannot process`);
      console.error(`   Expected output in: job.outputs[].url, job.output.mp4.url, or job.output`);
      console.error(`   Check the full job object logged above`);
    }
    
    // Return 200 success immediately
    res.status(200).json({ success: true, jobId, status });
  } catch (err) {
    console.error("Webhook error:", err);
    // Still return 200 so Coconut doesn't retry endlessly
    res.status(200).json({ success: false, error: err.message });
  }
});