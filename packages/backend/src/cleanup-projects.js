// packages/backend/src/cleanup-projects.js
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../../.env') });

const supabase = createClient(
  process.env.SB_URL || process.env.SUPABASE_URL,
  process.env.SB_SERVICE_ROLE || process.env.SUPABASE_SERVICE_KEY
);

async function cleanupProjects() {
  console.log('Starting project cleanup...\n');
  
  // 1. Delete empty projects
  const emptyProjectIds = [
    '9825b3d2-1df4-48ba-a9f2-3e504acc2276', // Test Project
    '5cdb944c-a08c-4409-a284-a07174a0a459'  // Material Selection Assistant (empty)
  ];
  
  console.log('Deleting empty projects...');
  for (const id of emptyProjectIds) {
    const { error } = await supabase
      .from('projects')
      .delete()
      .eq('id', id);
    
    if (error) {
      console.error(`Failed to delete project ${id}:`, error.message);
    } else {
      console.log(`  ✅ Deleted project ${id}`);
    }
  }
  
  // 2. Rename the "Captured Project" entries
  console.log('\nRenaming captured projects...');
  
  // Rename ContextBridge project (15 conversations)
  const { error: error1 } = await supabase
    .from('projects')
    .update({ name: 'ContextBridge' })
    .eq('id', '0198a07b-7fa1-75e2-8834-ca8a703c3469');
  
  if (error1) {
    console.error('Failed to rename ContextBridge project:', error1.message);
  } else {
    console.log('  ✅ Renamed project 0198a07b-7fa1-75e2-8834-ca8a703c3469 to "ContextBridge"');
  }
  
  // Rename Material Selection Assistant project (211 conversations)
  const { error: error2 } = await supabase
    .from('projects')
    .update({ name: 'Material Selection Assistant' })
    .eq('id', 'cc8f42fd-1249-4be2-9d31-e9aba18fc7e0');
  
  if (error2) {
    console.error('Failed to rename Material Selection Assistant project:', error2.message);
  } else {
    console.log('  ✅ Renamed project cc8f42fd-1249-4be2-9d31-e9aba18fc7e0 to "Material Selection Assistant"');
  }
  
  // 3. Verify the cleanup
  console.log('\n=== Verification ===');
  const { data: projects } = await supabase
    .from('projects')
    .select('id, name')
    .order('name');
  
  console.log('Projects after cleanup:');
  for (const project of projects) {
    const { count } = await supabase
      .from('conversations')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', project.id);
    
    console.log(`  - ${project.name}: ${count} conversations`);
  }
  
  console.log('\n✅ Cleanup complete!');
}

cleanupProjects().catch(console.error);