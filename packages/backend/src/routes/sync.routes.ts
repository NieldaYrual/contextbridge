import { Router } from 'express';
import { SupabaseClient } from '@supabase/supabase-js';

export function createSyncRoutes(supabase: SupabaseClient) {
  const router = Router();

  // ============================================================
  // GET /api/sync/watched-projects
  // Returns projects that have at least one captured conversation
  // (i.e., "watched" projects eligible for auto-sync)
  // ============================================================
  router.get('/sync/watched-projects', async (req, res) => {
    try {
      console.log('[Sync] Fetching watched projects...');

      // Find projects with captured conversations (message_count > 0)
      const { data, error } = await supabase
        .from('cb_conversations')
        .select(`
          project_id,
          cb_projects!inner (
            id,
            name,
            provider
          )
        `)
        .gt('message_count', 0)
        .not('project_id', 'is', null);

      if (error) throw error;

      // Deduplicate by project_id and extract project info
      const projectMap = new Map();
      for (const row of data || []) {
        const proj = Array.isArray(row.cb_projects) ? row.cb_projects[0] : row.cb_projects;
        if (proj && !projectMap.has(proj.id)) {
          projectMap.set(proj.id, {
            id: proj.id,
            name: proj.name,
            provider: proj.provider
          });
        }
      }

      const watchedProjects = Array.from(projectMap.values());
      console.log(`[Sync] Found ${watchedProjects.length} watched projects`);

      res.json({
        success: true,
        projects: watchedProjects
      });

    } catch (error: any) {
      console.error('[Sync] Error fetching watched projects:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================================
  // GET /api/sync/project-status/:projectId
  // Returns conversation IDs and their last_synced_at for a project
  // Used by extension to detect what's new
  // ============================================================
  router.get('/sync/project-status/:projectId', async (req, res) => {
    try {
      const { projectId } = req.params;
      console.log(`[Sync] Getting project status for ${projectId}`);

      const { data, error } = await supabase
        .from('cb_conversations')
        .select('id, last_synced_at, message_count, updated_at')
        .eq('project_id', projectId);

      if (error) throw error;

      // Return map of conversation_id -> sync info
      const conversations: Record<string, any> = {};
      for (const conv of data || []) {
        conversations[conv.id] = {
          last_synced_at: conv.last_synced_at,
          message_count: conv.message_count,
          updated_at: conv.updated_at
        };
      }

      res.json({
        success: true,
        projectId,
        conversations,
        count: Object.keys(conversations).length
      });

    } catch (error: any) {
      console.error('[Sync] Error getting project status:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================================
  // POST /api/sync/queue
  // Extension reports detected changes (new/updated conversations)
  // ============================================================
  router.post('/sync/queue', async (req, res) => {
    try {
      const { projectId, conversations } = req.body;
      
      if (!projectId || !conversations || !Array.isArray(conversations)) {
        return res.status(400).json({ 
          error: 'Missing required fields: projectId, conversations[]' 
        });
      }

      console.log(`[Sync] Queueing ${conversations.length} conversations for project ${projectId}`);

      // Prepare queue entries
      const queueEntries = conversations.map((conv: any) => ({
        project_id: projectId,
        conversation_id: conv.id,
        conversation_url: conv.url,
        conversation_title: conv.title || 'Untitled',
        status: 'pending',
        detected_at: new Date().toISOString()
      }));

      // Upsert to avoid duplicates (unique index handles this)
      const { data, error } = await supabase
        .from('cb_sync_queue')
        .upsert(queueEntries, {
          onConflict: 'project_id,conversation_id',
          ignoreDuplicates: true
        })
        .select();

      if (error) {
        // Handle unique constraint gracefully
        if (error.code === '23505') {
          console.log('[Sync] Some conversations already queued, continuing...');
        } else {
          throw error;
        }
      }

      res.json({
        success: true,
        queued: data?.length || 0,
        message: `Queued ${data?.length || 0} new conversations for sync`
      });

    } catch (error: any) {
      console.error('[Sync] Error queueing conversations:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================================
  // GET /api/sync/queue/:projectId
  // Get pending queue items for a project
  // ============================================================
  router.get('/sync/queue/:projectId', async (req, res) => {
    try {
      const { projectId } = req.params;
      const { status = 'pending' } = req.query;

      console.log(`[Sync] Getting queue for project ${projectId}, status: ${status}`);

      const { data, error } = await supabase
        .from('cb_sync_queue')
        .select('*')
        .eq('project_id', projectId)
        .eq('status', status)
        .order('detected_at', { ascending: true });

      if (error) throw error;

      res.json({
        success: true,
        projectId,
        items: data || [],
        count: data?.length || 0
      });

    } catch (error: any) {
      console.error('[Sync] Error getting queue:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================================
  // POST /api/sync/mark-notified
  // Mark queue items as 'notified' (user has been shown notification)
  // ============================================================
  router.post('/sync/mark-notified', async (req, res) => {
    try {
      const { projectId, conversationIds } = req.body;

      if (!projectId) {
        return res.status(400).json({ error: 'Missing projectId' });
      }

      console.log(`[Sync] Marking ${conversationIds?.length || 'all'} items as notified for project ${projectId}`);

      let query = supabase
        .from('cb_sync_queue')
        .update({ 
          status: 'notified',
          notified_at: new Date().toISOString()
        })
        .eq('project_id', projectId)
        .eq('status', 'pending');

      if (conversationIds && conversationIds.length > 0) {
        query = query.in('conversation_id', conversationIds);
      }

      const { data, error } = await query.select();

      if (error) throw error;

      res.json({
        success: true,
        updated: data?.length || 0
      });

    } catch (error: any) {
      console.error('[Sync] Error marking notified:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================================
  // POST /api/sync/complete
  // Mark queue items as completed after successful capture
  // ============================================================
  router.post('/sync/complete', async (req, res) => {
    try {
      const { projectId, conversationIds, status = 'completed' } = req.body;

      if (!projectId || !conversationIds || !Array.isArray(conversationIds)) {
        return res.status(400).json({ 
          error: 'Missing required fields: projectId, conversationIds[]' 
        });
      }

      console.log(`[Sync] Marking ${conversationIds.length} items as ${status} for project ${projectId}`);

      const { data, error } = await supabase
        .from('cb_sync_queue')
        .update({ 
          status,
          processed_at: new Date().toISOString()
        })
        .eq('project_id', projectId)
        .in('conversation_id', conversationIds)
        .select();

      if (error) throw error;

      // Also update last_synced_at on the conversations
      if (status === 'completed') {
        await supabase
          .from('cb_conversations')
          .update({ last_synced_at: new Date().toISOString() })
          .in('id', conversationIds);
      }

      res.json({
        success: true,
        updated: data?.length || 0
      });

    } catch (error: any) {
      console.error('[Sync] Error completing sync:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================================
  // GET /api/sync/stats
  // Get overall sync statistics (for debugging/dashboard)
  // ============================================================
  router.get('/sync/stats', async (req, res) => {
    try {
      const { data: queueStats, error: queueError } = await supabase
        .from('cb_sync_queue')
        .select('status')
        .then(result => {
          if (result.error) throw result.error;
          const counts: Record<string, number> = {};
          for (const row of result.data || []) {
            counts[row.status] = (counts[row.status] || 0) + 1;
          }
          return { data: counts, error: null };
        });

      if (queueError) throw queueError;

      res.json({
        success: true,
        queue: queueStats
      });

    } catch (error: any) {
      console.error('[Sync] Error getting stats:', error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}