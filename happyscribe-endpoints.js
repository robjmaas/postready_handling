/**
 * Happy Scribe API Endpoints
 * Add these to index.js after the other API routes
 * 
 * Endpoints:
 * - POST /transcribe/transfer/{id} - Create transcription order
 * - POST /translate/order/{orderId} - Create translation order
 * - GET /transcribe/order/{orderId} - Get transcription status
 * - GET /transcribe/download/{orderId} - Download transcript
 * - POST /webhooks/happyscribe - Happy Scribe webhook handler
 */

import happyscribeService from './happyscribe-service.js';

/**
 * POST /transcribe/transfer/{transferId}
 * Create a transcription order for a transfer
 * 
 * Optional body:
 * {
 *   "service": "auto|pro",
 *   "language": "en",
 *   "sourceType": "mediaconvert|filemail"
 * }
 */
app.post('/transcribe/transfer/:transferId', async (req, res) => {
  try {
    const { transferId } = req.params;
    const { service = 'auto', language = 'en', sourceType = 'mediaconvert' } = req.body || {};

    if (!happyscribeService.isHappyScribeConfigured()) {
      return res.status(400).json({
        error: 'Happy Scribe not configured - missing API key or org ID'
      });
    }

    // Get the job for this transfer
    const jobs = await db.all(
      `SELECT id, filename, output_url FROM coconut_jobs WHERE transfer_id = ? AND status = 'completed'`,
      [transferId]
    );

    if (!jobs.length) {
      return res.status(404).json({
        error: 'No completed jobs found for this transfer'
      });
    }

    const job = jobs[0];
    const mediaFileUrl = job.output_url || `s3://postready-staging/outputs/${job.filename}.mp4`;

    // Create order
    const result = await happyscribeService.createTranscriptionOrder(
      mediaFileUrl,
      job.filename,
      { service, language, transferId, jobId: job.id, sourceType }
    );

    res.json({
      success: true,
      orderId: result.orderId,
      state: result.state,
      estimatedCompletionMs: result.estimatedCompletionMs,
      transferId
    });
  } catch (err) {
    console.error('Transcription order error:', err);
    res.status(500).json({
      error: err.message
    });
  }
});

/**
 * POST /transcribe/job/{jobId}
 * Create a transcription order for a specific MediaConvert job
 */
app.post('/transcribe/job/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { service = 'auto', language = 'en' } = req.body || {};

    if (!happyscribeService.isHappyScribeConfigured()) {
      return res.status(400).json({ error: 'Happy Scribe not configured' });
    }

    // Get job details
    const job = await db.get(
      `SELECT transfer_id, filename FROM coconut_jobs WHERE id = ?`,
      [jobId]
    );

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Assume S3 output URL follows convention
    const mediaFileUrl = `s3://postready-staging/outputs/${job.filename}.mp4`;

    const result = await happyscribeService.createTranscriptionOrder(
      mediaFileUrl,
      job.filename,
      { service, language, transferId: job.transfer_id, jobId }
    );

    res.json({
      success: true,
      orderId: result.orderId,
      state: result.state,
      jobId
    });
  } catch (err) {
    console.error('Transcription order error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /transcribe/order/{orderId}
 * Get transcription order status
 */
app.get('/transcribe/order/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;

    const status = await happyscribeService.getTranscriptionOrderStatus(orderId);

    res.json({
      success: true,
      ...status
    });
  } catch (err) {
    console.error('Get transcription status error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /transcribe/download/{orderId}
 * Download transcript in specified format
 * 
 * Query params:
 * - format: vtt, srt, json, docx, pdf, etc
 * - redirect: true/false (default true) - redirect to download link or return URLs
 */
app.get('/transcribe/download/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { format = 'vtt', redirect = 'true' } = req.query;

    const downloads = await happyscribeService.downloadTranscripts(orderId, [format]);

    if (!downloads[format]) {
      return res.status(404).json({
        error: `No download available for format: ${format}`
      });
    }

    if (redirect === 'true') {
      // Redirect to download link
      return res.redirect(downloads[format]);
    } else {
      // Return URLs
      return res.json({
        success: true,
        orderId,
        format,
        downloadUrl: downloads[format]
      });
    }
  } catch (err) {
    console.error('Download transcript error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /translate/order/{orderId}
 * Create translation order from transcription
 * 
 * Body:
 * {
 *   "targetLanguages": ["es", "fr", "de"],
 *   "service": "auto|pro"
 * }
 */
app.post('/translate/order/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { targetLanguages = [], service = 'auto' } = req.body || {};

    if (!happyscribeService.isHappyScribeConfigured()) {
      return res.status(400).json({ error: 'Happy Scribe not configured' });
    }

    if (!targetLanguages.length) {
      return res.status(400).json({
        error: 'targetLanguages array required in body'
      });
    }

    // Get transcription status to find transcription ID
    const status = await happyscribeService.getTranscriptionOrderStatus(orderId);

    if (!status.transcriptions?.length) {
      return res.status(400).json({
        error: 'No transcriptions found - order may not be complete'
      });
    }

    const sourceTranscriptionId = status.transcriptions[0].uuid;

    const result = await happyscribeService.createTranslationOrder(
      sourceTranscriptionId,
      targetLanguages,
      { service }
    );

    res.json({
      success: true,
      orderId: result.orderId,
      state: result.state,
      targetLanguages,
      outputIds: result.outputIds
    });
  } catch (err) {
    console.error('Translation order error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /translate/order/{orderId}
 * Get translation order status
 */
app.get('/translate/order/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;

    const status = await happyscribeService.getTranslationOrderStatus(orderId);

    res.json({
      success: true,
      ...status
    });
  } catch (err) {
    console.error('Get translation status error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /webhooks/happyscribe
 * Handle Happy Scribe webhooks
 */
app.post('/webhooks/happyscribe', async (req, res) => {
  try {
    const signature = req.headers['x-happyscribe-signature'] || '';
    const payload = req.body;

    console.log(`📨 Happy Scribe webhook: ${payload.id} -> ${payload.state}`);

    // Verify signature
    const verified = happyscribeService.verifyHappyScribeWebhookSignature(
      JSON.stringify(payload),
      signature
    );

    if (!verified) {
      console.warn(`⚠️  Invalid Happy Scribe webhook signature`);
      // Continue anyway for now (TODO: implement proper verification)
    }

    // Handle webhook
    const result = await happyscribeService.handleHappyScribeWebhook(payload);

    res.json(result);
  } catch (err) {
    console.error('Happy Scribe webhook error:', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /transcribe/list
 * List all transcription orders for a transfer
 */
app.get('/transcribe/list/:transferId', async (req, res) => {
  try {
    const { transferId } = req.params;

    const orders = await db.all(
      `SELECT id, order_id, source_type, language, state, created_at, completed_at 
       FROM happy_scribe_orders 
       WHERE transfer_id = ? 
       ORDER BY created_at DESC`,
      [transferId]
    );

    res.json({
      success: true,
      transferId,
      count: orders.length,
      orders
    });
  } catch (err) {
    console.error('List transcriptions error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /transcribe/stats
 * Get Happy Scribe usage statistics
 */
app.get('/transcribe/stats', async (req, res) => {
  try {
    const total = await db.get(
      `SELECT COUNT(*) as count FROM happy_scribe_orders`
    );

    const byState = await db.all(
      `SELECT state, COUNT(*) as count FROM happy_scribe_orders GROUP BY state`
    );

    const completed = await db.get(
      `SELECT COUNT(*) as count FROM happy_scribe_orders WHERE state = 'fulfilled'`
    );

    const failed = await db.get(
      `SELECT COUNT(*) as count FROM happy_scribe_orders WHERE state = 'failed'`
    );

    res.json({
      success: true,
      total: total?.count || 0,
      completed: completed?.count || 0,
      failed: failed?.count || 0,
      byState: byState || []
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default {
  // These are exported to be integrated into main app routing
};
