import { query, Router } from 'express';
import { SupabaseClient } from '@supabase/supabase-js';
import { ExtractionService } from '../services/extraction.service';

export function createQueryRoutes(supabase: SupabaseClient) {
  const router = Router();
  const extractionService = new ExtractionService();

    // Search conversations by query
    router.post('/query/search', async (req, res) => {
    try {
        const { projectId, query, limit = 5 } = req.body;
        
        console.log('Searching for:', query, 'in project:', projectId);

        // For now, skip embeddings and do direct text search
        // Get ALL conversations for the project first
        const { data, error } = await supabase
        .from('cb_conversations')
        .select('*')
        .eq('project_id', projectId);

        if (error) {
        console.error('Supabase error:', error);
        throw error;
        }
        
        console.log('Found conversations:', data?.length);
        
        // Filter results manually
        const results = (data || []).filter((conv: any) => {
        const searchLower = query.toLowerCase();
        
        // Check summary
        if (conv.summary && conv.summary.toLowerCase().includes(searchLower)) {
            console.log('Match found in summary');
            return true;
        }
        
        // Check extracted context (this is JSONB)
        const contextStr = JSON.stringify(conv.extracted_context || {}).toLowerCase();
        if (contextStr.includes(searchLower)) {
            console.log('Match found in extracted_context');
            return true;
        }
        
        // Check raw messages (this is JSONB array)
        const messagesStr = JSON.stringify(conv.raw_messages || []).toLowerCase();
        if (messagesStr.includes(searchLower)) {
            console.log('Match found in raw_messages');
            return true;
        }
        
        return false;
        }).slice(0, limit);
        
        console.log('Filtered results:', results.length);

        // Codex code search for the same project/query
        let codex: any[] = [];
        try {
          const { data: codexData, error: codexError } = await supabase.rpc(
            'cb_search_codex_text',
            {
              p_project_id: projectId,
              p_query: query,
              p_limit: 20,
            }
          );

          if (codexError) {
            console.error('Codex search error:', codexError);
          } else if (codexData) {
            codex = codexData.map((row: any) => ({
              kind: 'codex',
              provider: 'codex',
              chunkId: row.chunk_id,
              sourceId: row.source_id,
              artifactId: row.artifact_id,
              filePath: row.file_path,
              // normalize Windows newlines for nicer display
              snippet: ((row.snippet as string) || '').replace(/\r\n/g, '\n'),
              startLine: row.start_line,
              endLine: row.end_line,
              createdAt: row.created_at,
            }));
          }
        } catch (e) {
          console.error('Unexpected Codex search error:', e);
        }
        
        res.json({ success: true, results, codex });
        
    } catch (error: any) {
        console.error('Search error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
    });

    // Get conversation details
    router.get('/query/conversation/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // Get conversation without entities first to avoid relationship conflict
        const { data, error } = await supabase
        .from('cb_conversations')
        .select('*, artifacts(*)')
        .eq('id', id)
        .single();

        if (error) throw error;

        res.json({ success: true, conversation: data });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
    });

    // Get project statistics
    router.get('/query/projects/:projectId/stats-simple', async (req, res) => {
      try {
        const { projectId } = req.params;
        
        // Get all conversations for this project
        const { data, error } = await supabase
          .from('cb_conversations')
          .select('message_count, token_count, raw_messages')
          .eq('project_id', projectId);
        
        if (error) throw error;
        
        // Calculate stats
        const stats = {
          totalConversations: data?.length || 0,
          totalMessages: data?.reduce((sum: number, conv: any) => {
            // Count from raw_messages if available, otherwise use message_count
            if (conv.raw_messages && Array.isArray(conv.raw_messages)) {
              return sum + conv.raw_messages.length;
            }
            return sum + (conv.message_count || 0);
          }, 0) || 0,
          textFiles: 0,
          codeFiles: 0
        };

        // Count files from cb_files table
        const { data: cbFiles, error: cbFilesError } = await supabase
          .from('cb_files')
          .select('file_type')
          .eq('project_id', projectId);

        if (cbFilesError) {
          console.error('cb_files stats error:', cbFilesError);
        } else if (cbFiles) {
          stats.textFiles = cbFiles.filter(f => f.file_type === 'document' || f.file_type === 'text').length;
          stats.codeFiles = cbFiles.filter(f => f.file_type === 'code').length;
        }

        // Also count distinct Codex code files from cb_chunks
        const { data: codexChunks, error: codexStatsError } = await supabase
          .from('cb_chunks')
          .select('metadata->>file_path as file_path')
          .eq('project_id', projectId)
          .eq('provider', 'codex')
          .eq('chunk_kind', 'code');

        if (codexStatsError) {
          console.error('Codex stats error:', codexStatsError);
        }

        const codeFileSet = new Set(
          (codexChunks ?? [])
            .map((row: any) => row.file_path)
            .filter((fp: string | null) => !!fp)
        );

        // Add Codex code files to total (avoid double counting if already in cb_files)
        stats.codeFiles = Math.max(stats.codeFiles, codeFileSet.size);
        
        res.json(stats);
      } catch (error: any) {
        console.error('Error fetching stats:', error);
        res.status(500).json({ error: error.message });
      }
    });

  /*
    // Get all conversations for a project
    router.get('/api/projects/:projectId/conversations', async (req, res) => {
      const { data, error } = await supabase
        .from('cb_conversations')
        .select('*')
        .eq('project_id', req.params.projectId)
        .order('created_at', { ascending: false }); // Make sure this is false for newest first
        
      res.json({ conversations: data });
    });
  */

    // Generate context summary
    router.post('/query/summarize', async (req, res) => {
        try {
        const { conversationIds, projectId, limit } = req.body;

        const { data: conversations, error } = await supabase
            .from('cb_conversations')
            .select('*, artifacts(*)')
            .in('id', conversationIds)
            .eq('project_id', projectId);

        if (error) throw error;

        // Compile context
        const context = {
            files: [] as any[],
            decisions: [] as string[],
            requirements: [] as string[],
            entities: new Set<string>(),
            messageCount: 0
        };

        conversations?.forEach((conv: any) => {
            const extracted = conv.extracted_context || {};
            context.files.push(...(extracted.files || []));
            context.decisions.push(...(extracted.decisions || []));
            context.requirements.push(...(extracted.requirements || []));
            (extracted.entities || []).forEach((e: any) => context.entities.add(e.name));
            context.messageCount += conv.raw_messages?.length || 0;
        });

        // Create summary from compiled context
        const summary = {
            files: [...new Set(context.files.map((f: any) => f.name))],
            decisions: [...new Set(context.decisions)],
            requirements: [...new Set(context.requirements)],
            entities: Array.from(context.entities),
            conversationCount: conversations?.length || 0,
            messageCount: context.messageCount
        };

        // Search Codex code for this query within the same project
        const { data: codexData, error: codexError } = await supabase.rpc(
          'cb_search_codex_text',
          {
            p_project_id: projectId,
            p_query: query,
            p_limit: limit ?? 20,   // reuse incoming limit, default to 20
          }
        );

        if (codexError) {
          console.error('Codex search error:', codexError);
        }

        const codex = (codexData ?? []).map((row: any) => ({
          kind: 'codex',
          provider: 'codex',
          chunkId: row.chunk_id,
          sourceId: row.source_id,
          artifactId: row.artifact_id,
          filePath: row.file_path,
          // normalize Windows newlines to '\n' for display
          snippet: (row.snippet as string || '').replace(/\r\n/g, '\n'),
          startLine: row.start_line,
          endLine: row.end_line,
          createdAt: row.created_at,
        }));

        // Optionally enrich summary with a code file count
        const codeFiles = new Set(codex.map((r: any) => r.filePath));
        (summary as any).codeFileCount = codeFiles.size;

        res.json({ success: true, summary, conversations, codex });

        } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
        }
    });

    // Debug endpoint to list all conversations for a project
    router.get('/query/debug/:projectId', async (req, res) => {
        try {
        const { projectId } = req.params;
        
        const { data, error } = await supabase
            .from('cb_conversations')
            .select('id, summary, extracted_context, created_at')
            .eq('project_id', projectId);
        
        if (error) throw error;
        
        res.json({ 
            success: true, 
            count: data?.length || 0,
            conversations: data 
        });
        } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
        }
    });

  return router;
}