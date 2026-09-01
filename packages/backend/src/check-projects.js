// packages/backend/src/check-projects.js
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

async function checkProjects() {
  console.log('=== Projects in Database ===\n');
  
  const { data: projects } = await supabase
    .from('projects')
    .select('*')
    .order('created_at');
  
  for (const project of projects) {
    const { count: convCount } = await supabase
      .from('conversations')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', project.id);
    
    console.log(`Project: ${project.name}`);
    console.log(`  ID: ${project.id}`);
    console.log(`  Created: ${project.created_at}`);
    console.log(`  Conversations: ${convCount}`);
    console.log('');
  }
  
  // Identify the actual projects with data
  console.log('=== Suggested Cleanup ===\n');
  
  const emptyProjects = [];
  const activeProjects = [];
  
  for (const project of projects) {
    const { count } = await supabase
      .from('conversations')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', project.id);
    
    if (count === 0) {
      emptyProjects.push(project);
    } else {
      activeProjects.push({ ...project, conversationCount: count });
    }
  }
  
  console.log(`Empty projects (can be deleted): ${emptyProjects.map(p => p.name).join(', ')}`);
  console.log(`Active projects: ${activeProjects.map(p => `${p.name} (${p.conversationCount} convs)`).join(', ')}`);
  
  // Check if "Captured Project" should be renamed
  const capturedProjects = activeProjects.filter(p => p.name === 'Captured Project');
  if (capturedProjects.length > 0) {
    console.log('\n⚠️  You have generic "Captured Project" names that should be renamed:');
    console.log('  - One appears to be "Material Selection Assistant" (211 conversations)');
    console.log('  - One appears to be "ContextBridge" (15 conversations)');
  }
}

checkProjects().catch(console.error);