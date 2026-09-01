import type { SupabaseClient } from '@supabase/supabase-js';

export type FileContentRow = {
  path: string;
  content: string;
  updated_at: string | null;
};

export class FileContentFetcher {
  private cache = new Map<string, FileContentRow>(); // key = `${projectId}:${path}`

  constructor(private sb: SupabaseClient) {}

  async getLatestFiles(projectId: string, paths: string[]): Promise<FileContentRow[]> {
    const need: string[] = [];
    const out: FileContentRow[] = [];

    for (const p of paths) {
      const k = `${projectId}:${p}`;
      const cached = this.cache.get(k);
      if (cached) out.push(cached);
      else need.push(p);
    }

    if (need.length) {
      const { data, error } = await this.sb.rpc('cb_get_latest_files', {
        p_project_id: projectId,
        p_paths: need
      });
      if (error) throw error;
      for (const row of (data ?? []) as FileContentRow[]) {
        const k = `${projectId}:${row.path}`;
        this.cache.set(k, row);
        out.push(row);
      }
    }

    // preserve request order
    const order = new Map(paths.map((p, i) => [p, i]));
    out.sort((a, b) => (order.get(a.path)! - order.get(b.path)!));
    return out;
  }
}
