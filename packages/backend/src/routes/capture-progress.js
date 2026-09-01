const express = require('express');
const router = express.Router();
const path = require('path');

// Store active capture jobs in memory
// In production, use Redis or database for persistence
const captureJobs = new Map();

// Serve the capture progress page
router.get('/capture-progress', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/capture-progress.html'));
});

// Create a new capture job
router.post('/api/capture/create-job', (req, res) => {
  const { conversations, projectId } = req.body;
  const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  
  const job = {
    jobId,
    projectId,
    conversations: conversations || [],
    status: 'active',
    processed: 0,
    failed: 0,
    total: conversations ? conversations.length : 0,
    createdAt: new Date(),
    results: []
  };
  
  captureJobs.set(jobId, job);
  
  // Clean up old jobs after 1 hour
  setTimeout(() => {
    captureJobs.delete(jobId);
  }, 3600000);
  
  res.json({ 
    success: true,
    jobId,
    total: job.total 
  });
});

// Get progress for a job
router.get('/api/capture/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = captureJobs.get(jobId);
  
  if (!job) {
    return res.status(404).json({ 
      error: 'Job not found',
      status: 'failed' 
    });
  }
  
  res.json({
    status: job.status,
    processed: job.processed,
    total: job.total,
    failed: job.failed,
    percentage: job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0
  });
});

// Update job progress (called by extension)
router.post('/api/capture/update-progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  const { processed, failed, status, conversationId, messageCount } = req.body;
  
  const job = captureJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  // Update job stats
  if (processed !== undefined) job.processed = processed;
  if (failed !== undefined) job.failed = failed;
  if (status) job.status = status;
  
  // Store result if provided
  if (conversationId) {
    job.results.push({
      conversationId,
      messageCount: messageCount || 0,
      capturedAt: new Date()
    });
  }
  
  // Check if job is complete
  if (job.processed + job.failed >= job.total) {
    job.status = 'completed';
  }
  
  res.json({ 
    success: true,
    job: {
      status: job.status,
      processed: job.processed,
      failed: job.failed,
      total: job.total
    }
  });
});

// Cancel a job
router.post('/api/capture/cancel/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = captureJobs.get(jobId);
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  job.status = 'cancelled';
  
  res.json({ 
    success: true,
    message: 'Job cancelled' 
  });
});

// Get job details (for debugging)
router.get('/api/capture/job/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = captureJobs.get(jobId);
  
  if (!job) {
    return res.json({
      jobId: jobId,
      conversations: [],
      status: 'not_found',
      message: 'Job not found or expired'
    });
  }
  
  res.json(job);
});

module.exports = router;