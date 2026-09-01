// packages/backend/src/routes/admin.routes.ts

import { Router, Request, Response } from 'express';
import { SupabaseClient } from '@supabase/supabase-js';
import { requireAuth } from '../middleware/auth.middleware';

export function createAdminRoutes(supabase: SupabaseClient) {
  const router = Router();

  // Middleware to check if user is admin
  async function requireAdmin(req: Request, res: Response, next: Function) {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { data: user, error } = await supabase
      .from('cb_users')
      .select('is_admin')
      .eq('id', req.user.userId)
      .single();

    if (error || !user || !user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    next();
  }

  // GET /admin/users - Get all users with their projects
  router.get('/users', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      // Get all users
      const { data: users, error: usersError } = await supabase
        .from('cb_users')
        .select('id, email, name, email_verified, is_admin, created_at, updated_at')
        .order('created_at', { ascending: false });

      if (usersError) {
        console.error('[Admin] Error fetching users:', usersError);
        return res.status(500).json({ error: 'Failed to fetch users' });
      }

      // Get project counts per user
      const { data: projectCounts, error: projectError } = await supabase
        .from('cb_projects')
        .select('user_id, id')
        .order('user_id');

      if (projectError) {
        console.error('[Admin] Error fetching project counts:', projectError);
      }

      // Count projects per user
      const projectCountMap: Record<string, number> = {};
      if (projectCounts) {
        projectCounts.forEach((p: any) => {
          projectCountMap[p.user_id] = (projectCountMap[p.user_id] || 0) + 1;
        });
      }

      // Combine data
      const usersWithCounts = users?.map(user => ({
        ...user,
        project_count: projectCountMap[user.id] || 0
      }));

      console.log('[Admin] Users fetched:', usersWithCounts?.length);
      res.json({ users: usersWithCounts });
    } catch (error: any) {
      console.error('[Admin] Error:', error);
      res.status(500).json({ error: 'Failed to fetch admin data' });
    }
  });

  // GET /admin/users/:userId/projects - Get projects for a specific user
  router.get('/users/:userId/projects', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;

      const { data: projects, error } = await supabase
        .from('cb_projects')
        .select(`
            id,
            name,
            provider,
            provider_project_id,
            created_at,
            updated_at
        `)
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('[Admin] Error fetching projects:', error);
        return res.status(500).json({ error: 'Failed to fetch projects' });
      }

      // Get conversation counts per project
      const projectIds = projects?.map(p => p.id) || [];
      
      let conversationCounts: Record<string, number> = {};
      if (projectIds.length > 0) {
        const { data: convCounts, error: convError } = await supabase
          .from('cb_conversations')
          .select('project_id, id')
          .in('project_id', projectIds);

        if (!convError && convCounts) {
          convCounts.forEach((c: any) => {
            conversationCounts[c.project_id] = (conversationCounts[c.project_id] || 0) + 1;
          });
        }
      }

      const projectsWithCounts = projects?.map(project => ({
        ...project,
        llm_provider: project.provider,
        conversation_count: conversationCounts[project.id] || 0
     }));

      res.json({ projects: projectsWithCounts });
    } catch (error: any) {
      console.error('[Admin] Error:', error);
      res.status(500).json({ error: 'Failed to fetch projects' });
    }
  });

  return router;
}