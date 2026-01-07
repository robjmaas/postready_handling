// node /Users/robmaas/Desktop/iMac/Projects/postready_handling/index
import fetch from "node-fetch";
import express from "express";
import dotenv from "dotenv";
import coconut from "coconutjs";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

dotenv.config({ quiet: true });   // <— no output

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
  `);
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

const PORT = process.env.PORT || 3000;
const DEPLOYMENT_URL = process.env.DEPLOYMENT_URL || "https://postready-handling.fly.dev";

// Health check endpoint for deployment
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
// https://postready-handling.fly.dev/webhooks/coconut

const FILEMAIL_API_KEY = process.env.FILEMAIL_API_KEY || "";
const COCONUT_API_KEY = process.env.COCONUT_API_KEY || "";
const FRAMEIO_TOKEN = process.env.FRAMEIO_TOKEN || ""; // Set via env var
const FRAMEIO_PROJECT_ID = process.env.FRAMEIO_PROJECT_ID || ""; // Set via env var
const COCONUT_WEBHOOK_URL = `${DEPLOYMENT_URL}/webhooks/coconut`;

// Debug: Log loaded API keys on startup
console.log("🔍 Checking environment variables on startup:");
console.log(`   - FILEMAIL_API_KEY: ${FILEMAIL_API_KEY ? '✅ SET' : '❌ MISSING'}`);
console.log(`   - COCONUT_API_KEY: ${COCONUT_API_KEY ? '✅ SET' : '❌ MISSING'}`);
console.log(`   - FRAMEIO_TOKEN: ${FRAMEIO_TOKEN ? '✅ SET' : '❌ MISSING'}`);
console.log(`   - FRAMEIO_PROJECT_ID: ${FRAMEIO_PROJECT_ID ? '✅ SET' : '❌ MISSING'}`);

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
  console.log("Server is ready, starting transfer sync...");
  
  // Skip transfer sync if API key is not set
  if (!FILEMAIL_API_KEY) {
    console.warn("⚠️  Skipping transfer sync - FILEMAIL_API_KEY is not yet available");
    return;
  }
  
  getInboxTransfers()
    .then(async (transfers) => {
      console.log(transfers.data.transfers)
      const transfersall = transfers.data.transfers; // <-- the actual array
      console.log("Transfers found:", transfersall.length);
      // Process each transfer
      for (const t of transfersall) {
        console.log("Transfer ID:", t.id);
        const portal = t.customfields?.[0]?.value || "Unknown";
        console.log("Portal:", portal);
        
        // Only process transfers from "Strawberries" portal
        if (portal.toLowerCase() !== "strawberries") {
          console.log("Skipping transfer - not from Strawberries portal:", portal);
          continue;
        }
        
        // Check if already processed
        if (await isTransferProcessed(t.id)) {
          console.log("Transfer already processed, skipping:", t.id);
          continue;
        }
        
        // Mark as processing to avoid duplicates
        await markTransferProcessed(t.id);
        processFilemailTransfer(t.id);
      }
    })
    .catch(err => {
      console.error("Error syncing transfers:", err);
    });
});

/* ==================== 1. GET FILES FROM FILEMAIL ==================== */

async function getFilemailFiles(transferId) {
  const res = await fetch(
    `https://api-public.filemail.com/transfer/${transferId}`,
    {
        headers: {
        "x-api-key": FILEMAIL_API_KEY,
        "x-api-version": 2.0
    }
  });

  if (!res.ok) throw new Error("Filemail request failed");

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
  console.log("Processing Filemail transfer:", transferId);
  console.log("Fetching Filemail files...");
  const files = await getFilemailFiles(transferId);
  console.log("Found files:", files);

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
      const result = await sendToCoconut(file.downloadurl, file.filename);
      console.log("Coconut job created:", result.id);
      
      // Store job in database
      await storeCoconutJob(result.id, transferId, file.filename);
      console.log("Job stored in database:", result.id);
    } catch (err) {
      console.error("Coconut error for file:", file.filename, err);
    }
  }

  console.log("Waiting for Coconut webhooks...");
}

/* ==================== COCO ==================== */

async function sendToCoconut(downloadUrl, filename) {
  const safeFilename = filename.replace(/[^\w\d_-]/g,"_");
  console.log("Sending to Coconut:", downloadUrl, safeFilename);  
  const payload = {
    input: { url: downloadUrl },
    storage: {
      service: "wasabi",
      bucket: "strawberries",
      region: "eu-central-1",
      path: `/${safeFilename}.mp4`,       // top-level path relative to bucket
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
      mp4: {
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

/* ==================== COCONUT WEBHOOK ==================== */

/**
 * Upload a video to Frame.io
 */
async function uploadToFrameIO(videoUrl, filename) {
  if (!FRAMEIO_TOKEN || !FRAMEIO_PROJECT_ID) {
    console.warn("Frame.io credentials not configured, skipping upload");
    return null;
  }

  try {
    console.log(`Uploading to Frame.io: ${filename}`);
    
    // Frame.io API uses multipart form data for file uploads
    // But since we have a remote URL, we can use their source_url parameter
    const payload = {
      name: filename,
      source: {
        type: "url",
        url: videoUrl
      }
    };

    const res = await fetch(
      `https://api.frame.io/v2/projects/${FRAMEIO_PROJECT_ID}/assets`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${FRAMEIO_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }
    );

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Frame.io API error ${res.status}: ${error}`);
    }

    const data = await res.json();
    console.log(`Video uploaded to Frame.io: ${data.id}`);
    return data;
  } catch (err) {
    console.error("Frame.io upload error:", err);
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
 * Webhook endpoint to handle Coconut job callbacks
 */
app.post("/webhooks/coconut", async (req, res) => {
  try {
    const { job } = req.body;

    if (!job || !job.id) {
      console.error("Invalid Coconut webhook payload:", req.body);
      return res.status(400).json({ error: "Missing job id" });
    }

    console.log(`Coconut webhook received for job ${job.id}:`, job.status);

    // Determine final status
    let status = "processing";
    let outputUrl = null;
    let error = null;

    if (job.status === "completed") {
      status = "completed";
      // Extract output URL from job outputs
      if (job.output && job.output.mp4) {
        outputUrl = job.output.mp4.url;
      }
    } else if (job.status === "failed" || job.status === "cancelled") {
      status = "failed";
      error = job.errors?.join(", ") || "Unknown error";
    }

    // Update job status in database
    await updateCoconutJob(job.id, status, outputUrl, error);

    console.log(`Job ${job.id} status updated to: ${status}`);
    
    // If completed, upload to Frame.io
    if (status === "completed" && outputUrl) {
      const filename = job.source?.url?.split("/").pop() || `${job.id}.mp4`;
      console.log(`Uploading completed video to Frame.io: ${filename}`);
      
      uploadToFrameIO(outputUrl, filename)
        .then((frameioResult) => {
          if (frameioResult) {
            console.log(`✅ Successfully uploaded to Frame.io: ${frameioResult.id}`);
          }
        })
        .catch((err) => {
          console.error(`❌ Frame.io upload failed:`, err);
        });
    }
    
    // Return success immediately (don't wait for Frame.io upload)
    res.json({ success: true, jobId: job.id, status });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: err.message });
  }
});