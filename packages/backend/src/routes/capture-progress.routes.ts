import { Router } from 'express';
import { SupabaseClient } from '@supabase/supabase-js';
import path from 'path';

// Store active capture jobs in memory
// In production, consider using Redis or database for persistence
const captureJobs = new Map<string, any>();

export function createCaptureProgressRoutes(supabase: SupabaseClient) {
  const router = Router();

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

  // Update job progress (called by each conversation when it completes)
  router.post('/api/capture/update-progress/:jobId', (req, res) => {
    const { jobId } = req.params;
    const { conversationId, messageCount } = req.body;
    
    const job = captureJobs.get(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    // INCREMENT processed count (not set it)
    job.processed = (job.processed || 0) + 1;
    
    // Store result if provided
    if (conversationId) {
      if (!job.results) job.results = [];
      job.results.push({
        conversationId,
        messageCount: messageCount || 0,
        capturedAt: new Date()
      });
    }
    
    // Calculate percentage
    job.percentage = job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0;
    
    // Check if job is complete
    if (job.processed >= job.total) {
      job.status = 'completed';
    }
    
    console.log(`Job ${jobId}: ${job.processed}/${job.total} (${job.percentage}%) - Conv: ${conversationId}`);
    
    res.json({ 
      success: true,
      job: {
        status: job.status,
        processed: job.processed,
        failed: job.failed || 0,
        total: job.total,
        percentage: job.percentage
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

  return router;
}