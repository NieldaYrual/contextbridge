import { startCaptureRow, finishCaptureRow, touchTarget } from '../core/supabase.js';
import { ADAPTERS } from '../adapters/index.js';
import type { CaptureTarget } from '../core/types.js';

export async function runSingleCapture(target: CaptureTarget) {
  const { id, provider, project_url, owner_label } = target;

  const adapter = ADAPTERS[provider];
  if (!adapter) {
    console.error(`No adapter found for provider: ${provider}`);
    return;
  }

  const capture = await startCaptureRow(id, provider);

  try {
    await adapter(project_url, owner_label, { targetId: id, captureId: capture.id });
    await finishCaptureRow(capture.id, true);
    await touchTarget(id);
    console.log(`Capture completed for ${provider} project: ${project_url}`);
  } catch (error) {
    console.error(`Capture failed for ${provider}:`, error);
    await finishCaptureRow(capture.id, false, (error as Error).message);
  }
}
