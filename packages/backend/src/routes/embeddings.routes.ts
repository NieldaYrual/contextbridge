// packages/backend/src/routes/embeddings.routes.ts
import { Router } from "express";
import { createClient } from "@supabase/supabase-js";

export const embeddingsRouter = Router();

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!, {
  auth: { persistSession: false },
});

embeddingsRouter.get("/api/embeddings/progress", async (req, res) => {
  const projectId = req.query.projectId as string;
  if (!projectId) return res.status(400).json({ error: "projectId required" });

  const { data, error } = await supabase.rpc("cb_embedding_progress", { p_project_id: projectId });
  if (error) return res.status(500).json({ error: error.message });

  const row = Array.isArray(data) ? data[0] : data;
  const totals = (row.msg_total + row.file_total + row.block_total) || 0;
  const pending = (row.msg_pending + row.file_pending + row.block_pending) || 0;
  const done = Math.max(0, totals - pending);
  const percent = totals > 0 ? Math.round((done / totals) * 100) : 100;

  res.json({
    projectId,
    totals: {
      messages: row.msg_total,
      files: row.file_total,
      blocks: row.block_total,
      all: totals,
    },
    pending: {
      messages: row.msg_pending,
      files: row.file_pending,
      blocks: row.block_pending,
      all: pending,
    },
    done,
    percent,
  });
});
