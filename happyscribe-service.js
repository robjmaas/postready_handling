/**
 * Happy Scribe Integration Module
 * Handles transcription and translation orders
 * 
 * Features:
 * - Create transcription orders from MediaConvert MP4s
 * - Track order status and poll for completion
 * - Download transcripts in multiple formats (VTT, SRT, JSON, DOCX)
 * - Create translation orders
 * - Webhook handling for order completion
 */

import fetch from 'node-fetch';

const HAPPYSCRIBE_API_KEY = process.env.HAPPYSCRIBE_API_KEY || '';
const HAPPYSCRIBE_ORG_ID = process.env.HAPPYSCRIBE_ORG_ID || '';
const HAPPYSCRIBE_AUTO_TRANSCRIBE = process.env.HAPPYSCRIBE_AUTO_TRANSCRIBE === 'true';
const HAPPYSCRIBE_TRANSCRIBE_SERVICE = process.env.HAPPYSCRIBE_TRANSCRIBE_SERVICE || 'auto';
const HAPPYSCRIBE_TRANSCRIBE_LANGUAGE = process.env.HAPPYSCRIBE_TRANSCRIBE_LANGUAGE || 'en';
const HAPPYSCRIBE_EXPORT_FORMATS = (process.env.HAPPYSCRIBE_EXPORT_FORMATS || 'vtt,srt,json').split(',');
const HAPPYSCRIBE_WEBHOOK_URL = process.env.HAPPYSCRIBE_WEBHOOK_URL || '';

const HS_API_BASE = 'https://www.happyscribe.com/api/v1';

/**
 * Check if Happy Scribe is configured
 */
export function isHappyScribeConfigured() {
  return HAPPYSCRIBE_API_KEY && HAPPYSCRIBE_ORG_ID;
}

/**
 * Create a transcription order
 * @param {string} mediaFileUrl - HTTP/HTTPS URL (S3 URLs should be converted to presigned URLs by caller)
 * @param {string} filename - Original filename
 * @param {object} options - { service, language, transferId, jobId, sourceType }
 */
export async function createTranscriptionOrder(mediaFileUrl, filename, options = {}) {
  try {
    if (!isHappyScribeConfigured()) {
      throw new Error('Happy Scribe not configured - missing API key or org ID');
    }

    const {
      service = HAPPYSCRIBE_TRANSCRIBE_SERVICE,
      language = HAPPYSCRIBE_TRANSCRIBE_LANGUAGE,
      transferId,
      jobId,
      sourceType = 'mediaconvert'
    } = options;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`📝 HAPPY SCRIBE TRANSCRIPTION ORDER`);
    console.log(`${'='.repeat(60)}`);
    console.log(`File: ${filename}`);
    console.log(`URL: ${mediaFileUrl.substring(0, 80)}...`);
    console.log(`Service: ${service}`);
    console.log(`Language: ${language}`);

    // Create order via Orders API (newer, preferred)
    const orderPayload = {
      order: {
        url: mediaFileUrl,
        language: language,
        service: service,
        confirm: true,
        organization_id: parseInt(HAPPYSCRIBE_ORG_ID),
        is_subtitle: false,
        tags: [
          transferId ? `transfer_${transferId}` : '',
          jobId ? `job_${jobId}` : '',
          sourceType
        ].filter(Boolean),
        webhook_url: HAPPYSCRIBE_WEBHOOK_URL || undefined
      }
    };

    const response = await fetch(`${HS_API_BASE}/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HAPPYSCRIBE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(orderPayload)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Happy Scribe API error ${response.status}: ${error}`);
    }

    const orderData = await response.json();

    console.log(`✅ Order created: ${orderData.id}`);
    console.log(`   State: ${orderData.state}`);
    console.log(`   Cost: $${(orderData.details?.total_cents / 100 || 0).toFixed(2)}`);

    // Store order in database
    if (global.db) {
      await global.db.run(
        `INSERT INTO happy_scribe_orders 
         (id, transfer_id, job_id, organization_id, order_id, source_type, source_url, language, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `hs_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          transferId || null,
          jobId || null,
          HAPPYSCRIBE_ORG_ID,
          orderData.id,
          sourceType,
          mediaFileUrl,
          language,
          orderData.state,
          new Date().toISOString()
        ]
      );
    }

    console.log(`${'='.repeat(60)}\n`);

    return {
      orderId: orderData.id,
      state: orderData.state,
      cost: orderData.details?.total_cents || 0,
      estimatedCompletionMs: orderData.details?.items?.[0]?.turnaround_minutes
        ? orderData.details.items[0].turnaround_minutes * 60 * 1000
        : 60000
    };
  } catch (err) {
    console.error(`❌ Failed to create transcription order: ${err.message}`);
    throw err;
  }
}

/**
 * Get transcription order status
 */
export async function getTranscriptionOrderStatus(orderId) {
  try {
    const response = await fetch(`${HS_API_BASE}/orders/${orderId}`, {
      headers: {
        'Authorization': `Bearer ${HAPPYSCRIBE_API_KEY}`
      }
    });

    if (!response.ok) {
      throw new Error(`Happy Scribe API error ${response.status}`);
    }

    const orderData = await response.json();

    return {
      orderId: orderData.id,
      state: orderData.state,
      progress: orderData.ingestions?.[0]?.state || 'unknown',
      transcriptions: orderData.transcriptions || [],
      estimatedAt: orderData.transcriptions?.[0]?.estimated_at,
      error: orderData.transcriptions?.[0]?.failureReason || null
    };
  } catch (err) {
    console.error(`Error getting transcription status: ${err.message}`);
    throw err;
  }
}

/**
 * Wait for transcription to complete
 */
export async function waitForTranscriptionCompletion(orderId, maxWaitMs = 30 * 60 * 1000) {
  const startTime = Date.now();
  const pollIntervalMs = 5000; // Poll every 5 seconds

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const status = await getTranscriptionOrderStatus(orderId);

      console.log(`⏳ Transcription status: ${status.state} (${Math.round((Date.now() - startTime) / 1000)}s)`);

      if (status.state === 'fulfilled') {
        console.log(`✅ Transcription complete!`);
        return status;
      }

      if (status.state === 'failed') {
        throw new Error(`Transcription failed: ${status.error}`);
      }

      // Wait before polling again
      await new Promise(r => setTimeout(r, pollIntervalMs));
    } catch (err) {
      console.error(`Error polling transcription: ${err.message}`);
      // Continue polling even on error
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }
  }

  throw new Error(`Transcription timeout after ${maxWaitMs / 1000}s`);
}

/**
 * Download transcripts in multiple formats
 */
export async function downloadTranscripts(orderId, formats = HAPPYSCRIBE_EXPORT_FORMATS) {
  try {
    const status = await getTranscriptionOrderStatus(orderId);

    if (status.state !== 'fulfilled') {
      throw new Error(`Transcription not ready (state: ${status.state})`);
    }

    const transcriptionIds = status.transcriptions.map(t => t.uuid);

    if (!transcriptionIds.length) {
      throw new Error('No transcriptions found in order');
    }

    const transcriptionId = transcriptionIds[0];
    const downloads = {};

    console.log(`\n📥 Downloading transcripts (${formats.join(', ')})...`);

    for (const format of formats) {
      try {
        const exportPayload = {
          export: {
            format: format,
            transcription_ids: [transcriptionId],
            show_timestamps: true,
            show_speakers: true
          }
        };

        const exportResponse = await fetch(`${HS_API_BASE}/exports`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${HAPPYSCRIBE_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(exportPayload)
        });

        if (!exportResponse.ok) {
          console.warn(`⚠️  Failed to create export for ${format}`);
          continue;
        }

        const exportData = await exportResponse.json();
        const exportId = exportData.id;

        // Poll for export completion
        let exportStatus = null;
        for (let i = 0; i < 30; i++) {
          const statusResponse = await fetch(`${HS_API_BASE}/exports/${exportId}`, {
            headers: {
              'Authorization': `Bearer ${HAPPYSCRIBE_API_KEY}`
            }
          });

          if (!statusResponse.ok) {
            throw new Error(`Failed to get export status: ${statusResponse.status}`);
          }

          exportStatus = await statusResponse.json();

          if (exportStatus.state === 'ready') {
            downloads[format] = exportStatus.download_link;
            console.log(`✅ ${format.toUpperCase()}: Ready`);
            break;
          }

          if (exportStatus.state === 'failed') {
            console.warn(`⚠️  Export failed for ${format}`);
            break;
          }

          // Wait before polling again
          await new Promise(r => setTimeout(r, 500));
        }
      } catch (err) {
        console.warn(`⚠️  Error downloading ${format}: ${err.message}`);
      }
    }

    console.log(`\n📥 Transcript downloads ready:`);
    Object.entries(downloads).forEach(([format, url]) => {
      console.log(`   ${format.toUpperCase()}: ${url.substring(0, 60)}...`);
    });

    return downloads;
  } catch (err) {
    console.error(`Error downloading transcripts: ${err.message}`);
    throw err;
  }
}

/**
 * Download SRT file content from Happy Scribe
 * @param {string} orderId - Happy Scribe order ID
 * @returns {Promise<string>} - SRT file content
 */
export async function downloadSRT(orderId) {
  try {
    const status = await getTranscriptionOrderStatus(orderId);

    if (status.state !== 'fulfilled') {
      throw new Error(`Transcription not ready (state: ${status.state})`);
    }

    const transcriptionIds = status.transcriptions.map(t => t.uuid);

    if (!transcriptionIds.length) {
      throw new Error('No transcriptions found in order');
    }

    const transcriptionId = transcriptionIds[0];

    console.log(`\n📥 Downloading SRT for order: ${orderId}`);

    const exportPayload = {
      export: {
        format: 'srt',
        transcription_ids: [transcriptionId],
        show_timestamps: true,
        show_speakers: true
      }
    };

    const exportResponse = await fetch(`${HS_API_BASE}/exports`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HAPPYSCRIBE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(exportPayload)
    });

    if (!exportResponse.ok) {
      throw new Error(`Failed to create SRT export: ${exportResponse.status}`);
    }

    const exportData = await exportResponse.json();
    const exportId = exportData.id;

    // Poll for export completion
    let exportStatus = null;
    for (let i = 0; i < 30; i++) {
      const statusResponse = await fetch(`${HS_API_BASE}/exports/${exportId}`, {
        headers: {
          'Authorization': `Bearer ${HAPPYSCRIBE_API_KEY}`
        }
      });

      if (!statusResponse.ok) {
        throw new Error(`Failed to get export status: ${statusResponse.status}`);
      }

      exportStatus = await statusResponse.json();

      if (exportStatus.state === 'ready') {
        console.log(`✅ SRT ready, downloading...`);
        
        // Download the SRT file
        const srtResponse = await fetch(exportStatus.download_link);
        if (!srtResponse.ok) {
          throw new Error(`Failed to download SRT: ${srtResponse.status}`);
        }
        
        const srtContent = await srtResponse.text();
        console.log(`✅ SRT downloaded: ${srtContent.length} bytes`);
        
        return srtContent;
      }

      if (exportStatus.state === 'failed') {
        throw new Error(`SRT export failed`);
      }

      // Wait before polling again
      await new Promise(r => setTimeout(r, 500));
    }

    throw new Error('SRT export timed out');
  } catch (err) {
    console.error(`Error downloading SRT: ${err.message}`);
    throw err;
  }
}

/**
 * Create translation order
 */
export async function createTranslationOrder(sourceTranscriptionId, targetLanguages, options = {}) {
  try {
    if (!isHappyScribeConfigured()) {
      throw new Error('Happy Scribe not configured');
    }

    const { service = 'auto' } = options;

    console.log(`\n🌐 Creating translation order`);
    console.log(`   Source: ${sourceTranscriptionId}`);
    console.log(`   Targets: ${targetLanguages.join(', ')}`);

    const orderPayload = {
      order: {
        source_transcription_id: sourceTranscriptionId,
        target_languages: targetLanguages,
        service: service,
        confirm: true
      }
    };

    const response = await fetch(`${HS_API_BASE}/orders/translation`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HAPPYSCRIBE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(orderPayload)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Happy Scribe API error: ${error}`);
    }

    const orderData = await response.json();

    console.log(`✅ Translation order created: ${orderData.id}`);

    return {
      orderId: orderData.id,
      state: orderData.state,
      outputIds: orderData.outputsIds || []
    };
  } catch (err) {
    console.error(`Error creating translation order: ${err.message}`);
    throw err;
  }
}

/**
 * Get translation order status
 */
export async function getTranslationOrderStatus(orderId) {
  try {
    const response = await fetch(`${HS_API_BASE}/orders/${orderId}`, {
      headers: {
        'Authorization': `Bearer ${HAPPYSCRIBE_API_KEY}`
      }
    });

    if (!response.ok) {
      throw new Error(`Happy Scribe API error ${response.status}`);
    }

    const orderData = await response.json();

    return {
      orderId: orderData.id,
      state: orderData.state,
      operations: orderData.operations || [],
      outputIds: orderData.outputsIds || [],
      transcriptions: orderData.transcriptions || []
    };
  } catch (err) {
    console.error(`Error getting translation status: ${err.message}`);
    throw err;
  }
}

/**
 * Verify Happy Scribe webhook signature
 * (Implement based on HS documentation)
 */
export function verifyHappyScribeWebhookSignature(body, signature) {
  // TODO: Implement signature verification
  // For now, just log and return true
  console.log(`🔐 Webhook signature verification (TODO): ${signature ? 'provided' : 'missing'}`);
  return true;
}

/**
 * Handle Happy Scribe webhook
 */
export async function handleHappyScribeWebhook(payload) {
  try {
    console.log(`\n📨 Happy Scribe webhook received`);
    console.log(`   Order ID: ${payload.id}`);
    console.log(`   State: ${payload.state}`);

    // Update database with webhook data
    if (global.db && payload.id) {
      await global.db.run(
        `UPDATE happy_scribe_orders SET state = ?, updated_at = ? WHERE order_id = ?`,
        [payload.state, new Date().toISOString(), payload.id]
      );
    }

    // Handle completion
    if (payload.state === 'fulfilled') {
      console.log(`✅ Transcription order fulfilled`);

      // Download transcripts
      try {
        const downloads = await downloadTranscripts(payload.id);

        if (global.db) {
          await global.db.run(
            `UPDATE happy_scribe_orders 
             SET exported_formats = ?, completed_at = ?
             WHERE order_id = ?`,
            [JSON.stringify(downloads), new Date().toISOString(), payload.id]
          );
        }
      } catch (err) {
        console.error(`Error downloading transcripts from webhook: ${err.message}`);
      }
    }

    return { success: true };
  } catch (err) {
    console.error(`Error handling Happy Scribe webhook: ${err.message}`);
    return { success: false, error: err.message };
  }
}

export default {
  isHappyScribeConfigured,
  createTranscriptionOrder,
  getTranscriptionOrderStatus,
  waitForTranscriptionCompletion,
  downloadTranscripts,
  downloadSRT,
  createTranslationOrder,
  getTranslationOrderStatus,
  verifyHappyScribeWebhookSignature,
  handleHappyScribeWebhook
};
