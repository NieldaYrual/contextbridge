import { getEmbeddingService } from './services/embedding.service';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

async function testQuery(query: string, targetFile: string) {
  const svc = getEmbeddingService();
  const raw = await svc.generateEmbeddingVector(query);
  console.log('Vector type:', typeof raw, 'isArray:', Array.isArray(raw), 'keys:', raw && typeof raw === 'object' ? Object.keys(raw).slice(0, 5) : 'N/A');
  
  let qvec: number[];
  if (Array.isArray(raw)) {
    qvec = raw;
  } else if (typeof raw === 'string') {
    qvec = JSON.parse(raw);
  } else if (raw && typeof raw === 'object') {
    const obj = raw as any;
    const v = obj.vector ?? obj.data ?? obj.embedding;
    qvec = typeof v === 'string' ? JSON.parse(v) : Array.isArray(v) ? v : Object.values(obj);
  } else {
    console.error('Cannot parse vector'); return;
  }

  console.log('Vector length:', qvec.length, 'first:', qvec[0]);

  const { data, error } = await supabase.rpc('search_knowledge_artifacts', {
    p_project_id: '0198a07b-7fa1-75e2-8834-ca8a703c3469',
    p_query_vec_text: `[${qvec.join(',')}]`,
    p_top_k: 200
  });

  // Add after each search_knowledge_artifacts call:
    const { data: chunkData, error: chunkErr } = await supabase.rpc('cb_search_codex_vectors', {
    p_project_id: '0198a07b-7fa1-75e2-8834-ca8a703c3469',
    p_query_vec: `[${qvec.join(',')}]`,
    p_limit: 200
    });

    if (!chunkErr && chunkData) {
    const chunkIdx = chunkData.findIndex((r: any) => 
        r.file_path?.includes(targetFile)
    );
    console.log(`\n[CHUNKS] Rank: ${chunkIdx >= 0 ? chunkIdx + 1 : 'NOT FOUND'} / ${chunkData.length}`);
    if (chunkIdx >= 0) console.log(`[CHUNKS] Similarity: ${chunkData[chunkIdx].similarity}`);
    console.log(`[CHUNKS] Top 5:`, chunkData.slice(0, 5).map((r: any) => `${r.file_path} (${r.similarity.toFixed(4)})`));
    }

  if (error) { console.error(error); return; }

  const targetIdx = data.findIndex((r: any) => 
    r.filename?.includes(targetFile) || r.path?.includes(targetFile)
  );

  console.log(`\nQuery: "${query}"`);
  console.log(`Target: ${targetFile}`);
  console.log(`Rank: ${targetIdx >= 0 ? targetIdx + 1 : 'NOT FOUND'} / ${data.length}`);
  if (targetIdx >= 0) console.log(`Similarity: ${data[targetIdx].similarity}`);
  console.log(`Top 5:`, data.slice(0, 5).map((r: any) => `${r.filename} (${r.similarity.toFixed(4)})`));
}

(async () => {
  await testQuery("How is search by keyword done?", "supabase-retriever");
  await testQuery("How authentication is currently handled?", "auth.routes");
  await testQuery("How are content scripts currently structured?", "content-universal");
})();