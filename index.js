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
    )
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

// Initialize database on startup
await initDb();

const app = express();
app.listen(3000, () => console.log("Server running"));

const FILEMAIL_API_KEY = `t7ZthvU4aFpDbUmLPVrX4ICdvqtLeFAX2kH8MPno5a1qmskNNQvWD00740n9NwWK`
const COCONUT_API_KEY = `k-6b91539067f3581606cfcf07f38a4eff`;
const COCONUT_WEBHOOK_URL = `https://6585886dfff3.ngrok-free.app`;
/**
 * Get all inbox transfers from Filemail
 */
export async function getInboxTransfers() {
  const url = "https://api-public.filemail.com/transfer/inbox";

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

getInboxTransfers()
  .then(async (transfers) => {
    console.log(transfers.data.transfers)
    const transfersall = transfers.data.transfers; // <-- the actual array
    console.log("Transfers found:", transfersall.length);
    // Process each transfer
    for (const t of transfersall) {
      console.log("Transfer ID:", t.id);
      console.log("Portal:", t.customfields[0].value);
      
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
  .catch(console.error);

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

async function processFilemailTransfer(transferId) {
  console.log("Processing Filemail transfer:", transferId);
  console.log("Fetching Filemail files...");
  const files = await getFilemailFiles(transferId);
  console.log("Found files:", files);

  for (const file of files) {
    
    console.log("Creating Coconut job for:", file.filename);
    try {
      const result = await sendToCoconut(file.downloadurl, file.filename);
      console.log("Coconut job created:", result.id);
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