import { Router } from 'express';
import { SupabaseClient } from '@supabase/supabase-js';
import Bull from 'bull';

export function createScraperRoutes(supabase: SupabaseClient) {
  const router = Router();
  
  // Initialize queue connection
  const scraperQueue = new Bull('scraper-queue', {
    redis: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
    }
  });

  // Start project capture
  router.post('/scraper/capture-project', async (req, res) => {
    try {
      const { projectId, cookies, llmProvider, currentUrl } = req.body;
      
      // Create job record in database
      const { data: jobRecord, error } = await supabase
        .from('scraper_jobs')
        .insert({
          project_id: projectId,
          status: 'pending',
          llm_provider: llmProvider,
          created_at: new Date().toISOString()
        })
        .select()
        .single();
      
      if (error) throw error;
      
      // Add job to queue
      const job = await scraperQueue.add({
        userId: 'user_123', // Get from auth
        projectId,
        cookies,
        llmProvider,
        jobId: jobRecord.id
      });
      
      res.json({
        success: true,
        jobId: jobRecord.id,
        queueId: job.id
      });
      
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Get job status
  router.get('/scraper/status/:jobId', async (req, res) => {
    try {
      const { jobId } = req.params;
      
      // Get job from database
      const { data, error } = await supabase
        .from('scraper_jobs')
        .select('*')
        .eq('id', jobId)
        .single();
      
      if (error) throw error;
      
      // Get queue job for progress
      const jobs = await scraperQueue.getJobs(['active', 'waiting', 'completed', 'failed']);
      const queueJob = jobs.find(j => j.data.jobId === jobId);
      
      res.json({
        success: true,
        status: data.status,
        progress: queueJob ? queueJob.progress() : 0,
        result: data.result,
        error: data.error
      });
      
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  return router;
}