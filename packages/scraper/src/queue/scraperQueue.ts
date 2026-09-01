// Use require for Bull to avoid import issues
const Bull = require('bull');
import { ScraperJob, ScraperProgress } from '../types';
import { ClaudeScraper } from '../providers/claudeScraper';
import { createClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

// Create queue
export const scraperQueue = new Bull('scraper-queue', {
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
  }
});

// Process jobs with proper typing
scraperQueue.process(async (job: any) => {
  const { userId, projectId, cookies, llmProvider, jobId } = job.data as ScraperJob;
  const scraper = new ClaudeScraper();
  
  try {
    await job.progress(0);
    await scraper.initialize(true);
    await scraper.setCookies(cookies);
    
    const conversations = await scraper.getConversationList();
    logger.info(`Found ${conversations.length} conversations to capture`);
    
    await job.progress(10);
    
    const results = [];
    for (let i = 0; i < conversations.length; i++) {
      const conv = conversations[i];
      
      const progress = 10 + (80 * (i / conversations.length));
      await job.progress(progress);
      
      logger.info(`Processing conversation ${i + 1}/${conversations.length}: ${conv.title || conv.id}`);
      
      const capturedData = await scraper.captureConversation(conv.url);
      
      if (capturedData) {
        const response = await fetch('http://localhost:3001/api/conversations/process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: projectId,
            messages: capturedData.messages,
            conversationId: capturedData.id,
            llmProvider: llmProvider
          })
        });
        
        const result = await response.json();
        results.push(result);
        
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    await job.progress(100);
    
    await supabase
      .from('scraper_jobs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        result: {
          conversationsCaptured: results.length,
          totalConversations: conversations.length
        }
      })
      .eq('id', jobId);
    
    return {
      success: true,
      captured: results.length,
      total: conversations.length
    };
    
  } catch (error) {
    logger.error('Scraper job failed:', error);
    
    await supabase
      .from('scraper_jobs')
      .update({
        status: 'failed',
        error: (error as Error).message
      })
      .eq('id', jobId);
    
    throw error;
    
  } finally {
    await scraper.cleanup();
  }
});

// Progress events with proper typing
scraperQueue.on('progress', (job: any, progress: number) => {
  logger.info(`Job ${job.id} progress: ${progress}%`);
});

scraperQueue.on('completed', (job: any, result: any) => {
  logger.info(`Job ${job.id} completed:`, result);
});

scraperQueue.on('failed', (job: any, err: unknown) => {
  logger.error(`Job ${job.id} failed:`, err);
});