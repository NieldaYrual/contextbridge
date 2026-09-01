// packages/backend/src/routes/knowledge-graph.routes.ts
import { Router } from 'express';
import { SupabaseClient } from '@supabase/supabase-js';
import { createClient as createSbClient } from '@supabase/supabase-js';

export function createKnowledgeGraphRoutes(supabase: SupabaseClient) {
  const router = Router();
  
  router.get('/ping', (_req, res) => res.json({ ok: true, router: 'knowledge-graph' }));

  // --- Entity Search (phrase-aware, uses cb_search_entities) ---

  const sbForEntities = createSbClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!, {
    auth: { persistSession: false },
  });

  router.get('/entities/search', async (req, res) => {
    try {
      const projectId = String(req.query.projectId || '');
      const q = String(req.query.q || '');
      const limit = Math.min(200, parseInt(String(req.query.limit || '50'), 10));
      const offset = Math.max(0, parseInt(String(req.query.offset || '0'), 10));

      if (!projectId) return res.status(400).json({ error: 'projectId required' });

      const { data, error } = await sbForEntities.rpc('cb_search_entities', {
        p_project_id: projectId,
        p_query: q,
        p_limit: limit,
        p_offset: offset,
      });

      if (error) return res.status(500).json({ error: error.message });
      return res.json({ items: data ?? [] });
    } catch (e: any) {
      return res.status(500).json({ error: e.message || 'entity search failed' });
    }
  });

  /**
   * GET /api/kg/graph?projectId=...&minOverlap=1
   * Returns a conversation graph derived from cb_entity_mentions via RPC get_project_graph_v2
   */
  // inside createKnowledgeGraphRoutes(supabase)
  router.get('/project/:projectId/subgraph', async (req, res) => {
    try {
      const projectId = String(req.params.projectId || '');
      if (!projectId) return res.status(400).json({ error: 'projectId required' });

      // -------- Params (legacy-compatible) --------
      const q = String(req.query.q ?? '');
      const maxNodes = Number(req.query.max_nodes ?? 30);
      const maxMessages = Number(req.query.max_messages ?? 20); // reserved for future
      const minOverlap = Number(req.query.min_overlap ?? 1);
      const limitEdges = Math.min(Number(req.query.limit_edges ?? 500), 5000);
      const includeIsolated = String(req.query.include_isolated ?? '0') === '1';
      const includeEntities = String(req.query.include_entities ?? '0') === '1';
      const includeMessages = String(req.query.include_messages ?? '0') === '1';
      const topKEntities = Math.min(Number(req.query.top_k_entities ?? 5), 50);

      // -------- Types --------
      type KgNode = { id: string; type: 'conversation' | 'entity' | 'message'; label: string; classes?: string; role?: string; degree?: number; created_at?: string; conversation_id?: string };
      type KgEdge = { source: string; target: string; weight: number };
      type RpcEdgeRow = { edge_c1: string; edge_c2: string; edge_weight: number };

      // Embedding row shapes (array-embedded FKs per PostgREST)
      type MsgLiftRow = { cb_messages: Array<{ conversation_id: string | null }> };
      type BlkLiftRow = { cb_blocks: Array<{ message_id: string | null; cb_messages: Array<{ conversation_id: string | null }> }> };
      type FileLiftRow = { cb_files: Array<{ conversation_id: string | null }> };

      let nodes: KgNode[] = [];
      let edges: KgEdge[] = [];

      // -------- 1) Find entities matching q --------
      let entityIds: string[] = [];
      if (q.trim().length > 0) {
        const { data: ents, error: entsErr } = await supabase.rpc('cb_search_entities', {
          p_project_id: projectId,
          p_query: q,
          p_limit: topKEntities,
          p_offset: 0,
        });
        if (entsErr) {
          console.error('[kg.subgraph] cb_search_entities error:', entsErr);
          return res.status(500).json({ error: 'entity_search_failed', detail: entsErr.message });
        }
        entityIds = (ents ?? []).map((e: any) => String(e.entity_id));

        if (includeEntities && ents && ents.length) {
          nodes.push(
            ...ents.map(
              (e: any): KgNode => ({
                id: String(e.entity_id),
                type: 'entity',
                label: String(e.name ?? e.canonical ?? e.entity_id).slice(0, 120),
                classes: 'entity-node'  // ✅ Add this line for custom styling
              })
            )
          );
        }
      }

      // -------- 1b) Fetch messages that mention these entities --------
      console.log('[kg.subgraph] includeMessages:', includeMessages, 'entityIds:', entityIds.length);

      if (includeMessages && entityIds.length > 0) {
        console.log('[kg.subgraph] Fetching messages for', entityIds.length, 'entities');

        const { data: msgData, error: msgErr } = await supabase
          .from('cb_entity_mentions')
          .select('cb_messages!inner(id, content, role, conversation_id)')
          .eq('project_id', projectId)
          .in('entity_id', entityIds)
          .not('message_id', 'is', null)
          .limit(maxMessages);

        if (msgErr) {
          console.error('[kg.subgraph] message fetch error:', msgErr);
        } else if (msgData && msgData.length) {
          console.log('[kg.subgraph] Fetched', msgData?.length || 0, 'message rows');

          // Deduplicate messages by ID
          const seenMsgIds = new Set<string>();
          const uniqueMessages = [];
          
          for (const row of msgData) {
            const msg = (row as any).cb_messages;
            if (msg?.id && !seenMsgIds.has(msg.id)) {
              seenMsgIds.add(msg.id);
              uniqueMessages.push(msg);
            }
          }

          nodes.push(
            ...uniqueMessages.map((m: any): KgNode => ({
              id: String(m.id),
              type: 'message',
              label: String(m.content || 'Message').slice(0, 80),
              classes: 'message-node',
              role: m.role,
              conversation_id: m.conversation_id,
              created_at: m.created_at
            }))
          );
          console.log('[kg.subgraph] Added', uniqueMessages.length, 'message nodes. Total nodes now:', nodes.length); // ✅ ADD THIS
        }
      }

      if (q.trim().length && entityIds.length === 0) {
        const payload = { project_id: projectId, params: { q, max_nodes: maxNodes, max_messages: maxMessages, min_overlap: minOverlap, limit_edges: limitEdges, include_isolated: includeIsolated, include_entities: includeEntities, top_k_entities: topKEntities }, nodes, edges, stats: { nodeCount: nodes.length, edgeCount: edges.length }, data: { nodes, edges } };
        return res.json(payload);
      }

      // -------- 2) Lift mentions → conversation IDs via all three paths --------
      const convSet = new Set<string>();

      if (entityIds.length > 0) {
        // 2a) MESSAGE path
        const { data: msgLift, error: msgErr } = await supabase
          .from('cb_entity_mentions')
          .select('cb_messages!inner(conversation_id)')
          .eq('project_id', projectId)
          .in('entity_id', entityIds)
          .not('message_id', 'is', null)
          .limit(5000);
        if (msgErr) console.error('[kg.subgraph] msg lift error:', msgErr);
        for (const row of (msgLift ?? [])) {
          const msg = (row as any).cb_messages;
          if (msg?.conversation_id) {
            convSet.add(String(msg.conversation_id));
          }
        }

        // 2b) BLOCK path: block_id -> cb_blocks.message_id -> cb_messages.conversation_id
        const { data: blkLift, error: blkErr } = await supabase
          .from('cb_entity_mentions')
          .select('cb_blocks!inner(message_id, cb_messages!inner(conversation_id))')
          .eq('project_id', projectId)
          .in('entity_id', entityIds)
          .not('block_id', 'is', null)
          .limit(5000);
        if (blkErr) console.error('[kg.subgraph] block lift error:', blkErr);
        for (const row of (blkLift ?? [])) {
          const block = (row as any).cb_blocks;
          const msg = block?.cb_messages;
          if (msg?.conversation_id) {
            convSet.add(String(msg.conversation_id));
          }
        }

        // 2c) FILE path: cb_file_id -> cb_files.conversation_id
        const { data: fileLift, error: fileErr } = await supabase
          .from('cb_entity_mentions')
          .select('cb_files!inner(conversation_id)')
          .eq('project_id', projectId)
          .in('entity_id', entityIds)
          .not('cb_file_id', 'is', null)
          .limit(5000);
        if (fileErr) console.error('[kg.subgraph] file lift error:', fileErr);
        for (const row of (fileLift ?? [])) {
          const file = (row as any).cb_files;
          if (file?.conversation_id) {
            convSet.add(String(file.conversation_id));
          }
        }
      }

      let convIdsInScope = Array.from(convSet);

      // Cap conversations (respect max_nodes but never remove explicit entity nodes)
      if (convIdsInScope.length > maxNodes) {
        convIdsInScope = convIdsInScope.slice(0, maxNodes);
      }

      // -------- 3) Fetch edges (v2) and filter to in-scope conversations --------
      const { data: allEdges, error: edgeErr } = await supabase.rpc('get_project_graph_v2', {
        p_project_id: projectId,
        p_min_overlap: minOverlap,
      });
      if (edgeErr) {
        console.error('[kg.subgraph] get_project_graph_v2 error:', edgeErr);
        // continue without edges
      }

      const inScope = new Set(convIdsInScope);
      edges = ((allEdges as RpcEdgeRow[]) ?? [])
        .filter((row: RpcEdgeRow) => inScope.has(row.edge_c1) && inScope.has(row.edge_c2))
        .map((row: RpcEdgeRow): KgEdge => ({ source: row.edge_c1, target: row.edge_c2, weight: row.edge_weight }))
        .sort((a: KgEdge, b: KgEdge) => (b.weight ?? 0) - (a.weight ?? 0));

      if (Number.isFinite(limitEdges) && limitEdges > 0) {
        edges = edges.slice(0, limitEdges);
      }

      // -------- 4) Add conversation nodes (labels) so edges render --------
      if (convIdsInScope.length > 0) {
        const { data: convs, error: convErr } = await supabase
          .from('cb_conversations')
          .select('id, summary')
          .eq('project_id', projectId)
          .in('id', convIdsInScope);

        if (convErr) {
          console.error('[kg.subgraph] cb_conversations fetch error:', convErr);
          return res.status(500).json({ error: 'conv_fetch_failed', detail: convErr.message });
        }

        const presentIds = new Set(nodes.map(n => n.id));
        for (const c of (convs ?? [])) {
          const id = String((c as any).id);
          if (!presentIds.has(id)) {
            nodes.push({
              id,
              type: 'conversation',
              label: (c as any).summary?.slice(0, 120) || id.slice(0, 8),
              classes: 'has-entities'  // ✅ Add this line for purple color
            });
            presentIds.add(id);
          }
        }
      }

      // -------- Add edges from messages to their conversations --------
      if (includeMessages) {
        for (const node of nodes) {
          if (node.type === 'message' && (node as any).conversation_id) {
            const convId = String((node as any).conversation_id);
            // Only add edge if the conversation node exists
            if (nodes.some(n => n.id === convId)) {
              edges.push({
                source: node.id,
                target: convId,
                weight: 1
              });
            }
          }
        }
      }

      // -------- Add edges from entities to conversations that mention them --------
      if (includeEntities && entityIds.length > 0) {
        const { data: entityConvs } = await supabase
          .from('cb_entity_mentions')
          .select('entity_id, cb_messages!inner(conversation_id)')
          .eq('project_id', projectId)
          .in('entity_id', entityIds)
          .not('message_id', 'is', null);

        if (entityConvs) {
          const entityToConv = new Map<string, Set<string>>();
          for (const row of entityConvs) {
            const eid = String(row.entity_id);
            const cid = String((row as any).cb_messages?.conversation_id);
            if (cid) {
              if (!entityToConv.has(eid)) entityToConv.set(eid, new Set());
              entityToConv.get(eid)!.add(cid);
            }
          }
          
          for (const [eid, convIds] of entityToConv) {
            for (const cid of convIds) {
              edges.push({ source: eid, target: cid, weight: 1 });
            }
          }
        }
      }

      // -------- 5) Drop isolated conversations unless includeIsolated --------
      if (!includeIsolated && edges.length > 0) {
        const endpoints = new Set<string>(edges.flatMap(e => [e.source, e.target]));
        nodes = nodes.filter(n => n.type === 'entity' || n.type === 'message' || endpoints.has(n.id));
      }

      // -------- 6) Done: return both modern and legacy shapes --------
      const payload = {
        project_id: projectId,
        params: {
          q,
          max_nodes: maxNodes,
          max_messages: maxMessages,
          min_overlap: minOverlap,
          limit_edges: limitEdges,
          include_isolated: includeIsolated,
          include_entities: includeEntities,
          top_k_entities: topKEntities,
        },
        nodes,
        edges,
        stats: { nodeCount: nodes.length, edgeCount: edges.length },
        data: { nodes, edges }, // legacy-friendly
      };

      return res.json(payload);
    } catch (err: any) {
      console.error('[kg.subgraph] exception:', err);
      return res.status(500).json({ error: 'exception', message: err?.message || String(err) });
    }
  });
  
  // ✅ Optional alias: keep old path but use new RPC under the hood
  router.get('/search/entities', async (req, res) => {
    try {
      const projectId = String(req.query.project_id || req.query.projectId || '');
      const q = String(req.query.q || '');
      const limit = Math.min(200, parseInt(String(req.query.limit || '50'), 10));
      const offset = Math.max(0, parseInt(String(req.query.offset || '0'), 10));

      if (!projectId) return res.status(400).json({ error: 'project_id or projectId required' });

      const { data, error } = await sbForEntities.rpc('cb_search_entities', {
        p_project_id: projectId,
        p_query: q,
        p_limit: limit,
        p_offset: offset,
      });

      if (error) return res.status(500).json({ error: error.message });
      return res.json({ items: data ?? [] });
    } catch (e: any) {
      return res.status(500).json({ error: e.message || 'entity search failed' });
    }
  });
  
  // ✅ Updated: Get conversations for an entity (cb_* tables)
  router.get('/entity/:entityId/conversations', async (req, res) => {
    const { entityId } = req.params;

    // 1) Mentions for this entity
    const { data: mentions, error: mErr } = await supabase
      .from('cb_entity_mentions')
      .select('message_id, cb_file_id, block_id')
      .eq('entity_id', entityId);

    if (mErr) return res.status(500).json({ error: mErr.message });
    if (!mentions || mentions.length === 0) return res.json({ conversations: [] });

    const messageIds = mentions.map(m => m.message_id).filter(Boolean);
    if (messageIds.length === 0) return res.json({ conversations: [] });

    // 2) Get conversation ids via messages
    const { data: messages, error: msgErr } = await supabase
      .from('cb_messages')
      .select('conversation_id')
      .in('id', messageIds as string[]);
    if (msgErr) return res.status(500).json({ error: msgErr.message });

    const convIds = Array.from(new Set((messages ?? []).map(m => m.conversation_id)));
    if (convIds.length === 0) return res.json({ conversations: [] });

    // 3) Fetch conversations
    const { data: conversations, error: convErr } = await supabase
      .from('cb_conversations')
      .select('id, summary, started_at, last_activity_at')
      .in('id', convIds)
      .limit(10);

    if (convErr) return res.status(500).json({ error: convErr.message });

    res.json({ conversations: conversations || [] });
  });
  
  // Get conversation context with related conversations
  router.get('/conversation/:convId/context', async (req, res) => {
    const { convId } = req.params;
    
    // Get linked conversations
    const { data: links } = await supabase
      .from('conversation_links')
      .select('*')
      .or(`source_conversation_id.eq.${convId},target_conversation_id.eq.${convId}`)
      .order('similarity_score', { ascending: false })
      .limit(5);
    
    // Get summary
    const { data: summary } = await supabase
      .from('summaries')
      .select('content, citations')
      .eq('target_id', convId)
      .eq('level', 'conversation')
      .single();
    
    // Get top entities in this conversation
    // First get message IDs for this conversation
    const { data: messageIds } = await supabase
      .from('cb_messages')
      .select('id')
      .eq('conversation_id', convId);
    
    const messageIdList = messageIds?.map(m => m.id) || [];
    
    const { data: entities, error: entErr } = await supabase
      .from('cb_entity_mentions')
      .select('entity_id, cb_entities!inner(name, type)')
      .in('message_id', messageIdList)
      .not('message_id', 'is', null)
      .limit(10);
    if (entErr) return res.status(500).json({ error: entErr.message });
  });
  
  // Get project knowledge graph stats
  router.get('/project/:projectId/stats', async (req, res) => {
    const { projectId } = req.params;
    
    try {
      const [
        entityResult,
        relationshipResult,
        conversationResult
      ] = await Promise.all([
        supabase.from('entities').select('*', { count: 'exact', head: true }).eq('project_id', projectId),
        supabase.from('relationships').select('*', { count: 'exact', head: true }).eq('project_id', projectId),
        supabase.from('cb_conversations').select('*', { count: 'exact', head: true }).eq('project_id', projectId)
      ]);
      
      res.json({
        entities: entityResult.count || 0,
        relationships: relationshipResult.count || 0,
        conversations: conversationResult.count || 0
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

    // Graph: nodes=conversations, edges=conversation_links
    // ─────────────────────────────────────────────────────────────────────────────
    // GET /api/kg/project/:projectId/graph
    // ─────────────────────────────────────────────────────────────────────────────
    
    router.get('/project/:projectId/graph', async (req, res) => {
      const projectId = req.params.projectId;

      // Parse query params (keep your existing options)
      const minOverlap = Number(req.query.min_overlap ?? 2);
      const minSim = Number(req.query.min_similarity ?? 0); // not used by RPC, kept for future
      const limitEdges = Math.min(Number(req.query.limit_edges ?? 500), 5000);
      const includeIsolated =
        String(req.query.include_isolated ?? '0') === '1' ||
        String(req.query.include_isolated ?? 'false') === 'true';
      const includeSummaries = (req.query.include_summaries ?? '1') === '1';
      const includeEntityCounts = (req.query.include_entity_counts ?? '1') === '1';
      const includeEntities = (req.query.include_entities ?? '0') === '1';
      const topKEntities = Math.min(Number(req.query.top_k_entities ?? 3), 10);

      // Unified log so you can see it in the console
      console.log('[kg.graph]', {
        projectId, minOverlap, limitEdges, includeIsolated,
        includeSummaries, includeEntityCounts, includeEntities, topKEntities
      });

      // Types used in this file
      type KgNode = { id: string; label: string; type?: string; classes?: string; degree?: number; created_at?: string };
      type KgEdge = { source: string; target: string; weight: number };
      type RpcEdgeRow = { edge_c1: string; edge_c2: string; edge_weight: number };

      try {
        // 1) Call the NEW v2 RPC (conversation-conversation edges)
        const { data: v2Edges, error: v2Err } = await supabase.rpc('get_project_graph_v2', {
          p_project_id: projectId,
          p_min_overlap: minOverlap,
        });
        if (v2Err) {
          console.error('[kg.graph] get_project_graph_v2 error:', v2Err);
          return res.status(502).json({ error: 'rpc_error', detail: v2Err.message ?? String(v2Err) });
        }

        // Build typed edges and sort
        let edges: KgEdge[] = ((v2Edges as RpcEdgeRow[]) ?? [])
          .map((row: RpcEdgeRow): KgEdge => ({
            source: row.edge_c1,
            target: row.edge_c2,
            weight: row.edge_weight,
          }))
          .sort((a: KgEdge, b: KgEdge) => (b.weight ?? 0) - (a.weight ?? 0));

        if (Number.isFinite(limitEdges) && limitEdges > 0) {
          edges = edges.slice(0, limitEdges);
        }

        // 2) Build nodes for conversations present in edges
        const convIds = Array.from(new Set(edges.flatMap((e: { source: string; target: string }) => [e.source, e.target])));
        let nodes: KgNode[] = [];

        if (convIds.length) {
          const { data: convs, error: convErr } = await supabase
            .from('cb_conversations')
            .select('id, summary')
            .eq('project_id', projectId)
            .in('id', convIds);

          if (convErr) {
            console.error('[kg.graph] cb_conversations fetch error:', convErr);
            return res.status(500).json({ error: 'kg_nodes_failed', detail: convErr.message });
          }

          const labelById = new Map<string, string>(
            (convs ?? []).map((c: any) => [String(c.id), (c.summary as string) ?? String(c.id).slice(0, 8)])
          );

          nodes = convIds.map((id: string): KgNode => ({
            id,
            label: labelById.get(id) || id.slice(0, 8),
          }));
        }

        // Debug counts
        console.log('[kg.graph] v2 counts → nodes:', nodes.length, 'edges:', edges.length);

        // 3) Return in the SAME shape your dashboard expects
        if (nodes.length || edges.length || !includeIsolated) {
          return res.json({
            project_id: projectId,
            params: {
              min_overlap: minOverlap,
              min_similarity: minSim,
              limit_edges: limitEdges,
              include_isolated: includeIsolated,
              include_summaries: includeSummaries,
              include_entity_counts: includeEntityCounts,
              include_entities: includeEntities,
              top_k_entities: topKEntities
            },
            nodes,
            edges
          });
        }

        // 4) Fallback for includeIsolated=true with 0 edges (unchanged)
        const { data: convs, error: convErr } = await supabase
          .from('cb_conversations')
          .select('id, summary, created_at')
          .eq('project_id', projectId)
          .limit(2000);

        if (convErr) {
          console.error('[kg.graph] fallback conversations error:', convErr);
          return res.status(500).json({ error: 'fallback_query_failed', detail: convErr.message });
        }

        const fallbackNodes: KgNode[] = (convs ?? []).map((c: any) => ({
          id: String(c.id),
          label: (c.summary || 'Conversation').slice(0, 120),
          degree: 0,
          created_at: c.created_at
        }));

        console.log('[kg.graph] fallback counts → nodes:', fallbackNodes.length, 'edges: 0');

        return res.json({
          project_id: projectId,
          params: {
            min_overlap: minOverlap,
            min_similarity: minSim,
            limit_edges: limitEdges,
            include_isolated: includeIsolated,
            include_summaries: includeSummaries,
            include_entity_counts: includeEntityCounts,
            include_entities: includeEntities,
            top_k_entities: topKEntities
          },
          nodes: fallbackNodes,
          edges: []
        });

      } catch (err: any) {
        console.error('[kg.graph] exception:', err);
        return res.status(500).json({ error: 'exception', message: err?.message || String(err) });
      }
    });

    // Add this new route for focused subgraphs
    router.get('/conversation/:convId/neighborhood', async (req, res) => {
        try {
            const { convId } = req.params;
            const hops = Math.min(Number(req.query.hops ?? 1), 2); // Max 2 hops
            const limit = Math.min(Number(req.query.limit ?? 20), 50);
            
            // Get conversation's project ID
            const { data: conv } = await supabase
            .from('cb_conversations')
            .select('project_id')
            .eq('id', convId)
            .single();
            
            if (!conv) {
            return res.status(404).json({ error: 'Conversation not found' });
            }
            
            // Get direct neighbors (1-hop)
            const { data: edges } = await supabase
            .from('conversation_links')
            .select('*')
            .or(`source_conversation_id.eq.${convId},target_conversation_id.eq.${convId}`)
            .order('overlap_entities', { ascending: false })
            .limit(limit);
            
            // Collect all node IDs
            const nodeIds = new Set<string>([convId]);
            edges?.forEach(e => {
            nodeIds.add(e.source_conversation_id);
            nodeIds.add(e.target_conversation_id);
            });
            
            // If 2-hop requested, get second degree neighbors
            if (hops === 2 && edges?.length) {
            const neighborIds = Array.from(nodeIds).filter(id => id !== convId);
            const { data: secondHop } = await supabase
                .from('conversation_links')
                .select('*')
                .in('source_conversation_id', neighborIds)
                .or(`target_conversation_id.in.(${neighborIds.join(',')})`)
                .limit(limit * 2);
            
            secondHop?.forEach(e => {
                nodeIds.add(e.source_conversation_id);
                nodeIds.add(e.target_conversation_id);
                edges?.push(e);
            });
            }
            
            // Get node metadata
            const { data: nodes } = await supabase
            .from('cb_conversations')
            .select('id, summary, created_at')
            .in('id', Array.from(nodeIds));
            
            // Format response
            const nodeMap = new Map();
            nodes?.forEach(n => {
            nodeMap.set(n.id, {
                id: n.id,
                label: n.summary?.substring(0, 50) + '...' || 'Conversation',
                summary: n.summary,
                created_at: n.created_at,
                isCenter: n.id === convId
            });
            });
            
            const formattedEdges = edges?.map(e => ({
            source: e.source_conversation_id,
            target: e.target_conversation_id,
            weight: e.similarity_score || 0,
            overlap: e.overlap_entities
            }));
            
            res.json({
            center: convId,
            nodes: Array.from(nodeMap.values()),
            edges: formattedEdges,
            hops
            });
            
        } catch (error: any) {
            res.status(500).json({ error: error.message });
        }
    });
  
  return router;
}