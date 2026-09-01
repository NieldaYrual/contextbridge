// audit-entity-types.js
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from capture folder
dotenv.config({ path: join(__dirname, '..', '..', 'capture', '.env') });

// Debug: Check if env vars are loaded
console.log('Environment check:');
console.log('SB_URL:', process.env.SB_URL ? 'Found' : 'Missing');
console.log('SB_SERVICE_ROLE:', process.env.SB_SERVICE_ROLE ? 'Found' : 'Missing');

if (!process.env.SB_URL || !process.env.SB_SERVICE_ROLE) {
  console.error('\n❌ Missing environment variables!');
  console.error('Expected SB_URL and SB_SERVICE_ROLE in packages/capture/.env');
  process.exit(1);
}

// Use service role key for full access
const supabase = createClient(
  process.env.SB_URL,
  process.env.SB_SERVICE_ROLE
);

async function auditEntityTypes() {
  const projectId = 'cc8f42fd-1249-4be2-9d31-e9aba18fc7e0';
  
  console.log('\nAuditing entity types in knowledge graph...');
  console.log('Project ID:', projectId);
  console.log('=' .repeat(50));
  
  // Get entity type distribution
  const { data: types, error } = await supabase
    .from('entities')
    .select('entity_type')
    .eq('project_id', projectId);
  
  if (error) {
    console.error('Error fetching entities:', error);
    return;
  }
  
  if (!types || types.length === 0) {
    console.log('No entities found for this project.');
    console.log('Have you run the entity extraction script?');
    return;
  }
  
  const typeCounts = {};
  types.forEach(e => {
    typeCounts[e.entity_type] = (typeCounts[e.entity_type] || 0) + 1;
  });
  
  console.log('\n📊 Current entity type distribution:');
  const sortedTypes = Object.entries(typeCounts)
    .sort((a, b) => b[1] - a[1]);
  
  sortedTypes.forEach(([type, count]) => {
    console.log(`  ${type}: ${count}`);
  });
  
  console.log(`\n📈 Summary:`);
  console.log(`  Total unique entity types: ${sortedTypes.length}`);
  console.log(`  Total entities: ${types.length}`);
  
  // Check for missing types
  const desiredTypes = [
    'technology', 'file', 'task_or_issue', 'tool_or_service', 
    'standard_or_spec', 'measure_or_metric', 'function_or_api',
    'dataset_or_schema', 'role_or_team', 'version_or_release',
    'decision_or_hypothesis', 'project', 'context'
  ];
  
  const existingTypes = Object.keys(typeCounts);
  const missingTypes = desiredTypes.filter(t => !typeCounts[t]);
  const unexpectedTypes = existingTypes.filter(t => !desiredTypes.includes(t));
  
  if (missingTypes.length > 0) {
    console.log('\n⚠️  Missing desired entity types:');
    missingTypes.forEach(t => console.log(`  - ${t}`));
  } else {
    console.log('\n✅ All desired entity types are present');
  }
  
  if (unexpectedTypes.length > 0) {
    console.log('\n🔍 Additional entity types found:');
    unexpectedTypes.forEach(t => {
      console.log(`  - ${t} (${typeCounts[t]} entities)`);
    });
  }
  
  // Show sample entities for top types
  console.log('\n📝 Sample entities by type (top 5 types):');
  for (const [type, count] of sortedTypes.slice(0, 5)) {
    const { data: samples } = await supabase
      .from('entities')
      .select('canonical_name')
      .eq('project_id', projectId)
      .eq('entity_type', type)
      .limit(3);
    
    console.log(`\n${type} (${count} total):`);
    samples?.forEach(s => {
      const name = s.canonical_name.length > 50 
        ? s.canonical_name.substring(0, 50) + '...'
        : s.canonical_name;
      console.log(`  - ${name}`);
    });
  }
  
  console.log('\n' + '=' .repeat(50));
  console.log('Audit complete!\n');
}

auditEntityTypes();