import pLimit from 'p-limit';
import { listDueTargets } from '../core/supabase.js';
import { runSingleCapture } from './capture.js';

export async function runScheduler(concurrency = 1){
  const due = await listDueTargets(new Date());
  if (due.length === 0) {
    console.log('No targets due');
    return;
  }
  const limit = pLimit(concurrency);
  await Promise.all(due.map(t => limit(() => runSingleCapture(t))));
}
