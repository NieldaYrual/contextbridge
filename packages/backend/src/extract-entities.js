// packages/backend/src/extract-entities.js
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

// Comprehensive entity types
const ENTITY_TYPES = {
  PERSON: 'person',
  ORG: 'organization',
  GPE: 'location',
  PRODUCT: 'product',
  TECH: 'technology',
  DATE: 'date',
  EVENT: 'event',
  PROJECT: 'project',
  CONCEPT: 'concept',
  CONTEXT: 'context',
  FILE: 'file',
  CODE: 'code_entity',
  TASK: 'task_or_issue',
  TOOL: 'tool_or_service',
  STANDARD: 'standard_or_spec',
  MEASURE: 'measure_or_metric',
  API: 'function_or_api',
  DATA: 'dataset_or_schema',
  ROLE: 'role_or_team',
  VERSION: 'version_or_release',
  DECISION: 'decision_or_hypothesis'
};

// Define all pattern groups
const techPatterns = [
  // Web & runtimes
  /\b(React|Vue|Angular|Svelte|Next\.js|Nuxt\.js|Remix|SolidJS|Node\.js|Deno|Bun|Express|Fastify|NestJS)\b/gi,
  // Backend frameworks
  /\b(Django|Flask|FastAPI|Rails|Laravel|Spring|ASP\.NET|Phoenix|Fiber)\b/gi,
  // Databases & search
  /\b(PostgreSQL|MySQL|MariaDB|SQLite|MongoDB|Redis|Elasticsearch|OpenSearch|ClickHouse|Snowflake|BigQuery|DuckDB|Supabase|Firebase)\b/gi,
  // Vector DB & embeddings
  /\b(pgvector|Pinecone|Qdrant|Weaviate|Milvus|FAISS|Annoy|HNSW|Chroma)\b/gi,
  // Languages
  /\b(Python|JavaScript|TypeScript|Java|C\+\+|C#|Rust|Go|Kotlin|Swift|Ruby|PHP|Dart|Scala|Haskell|Erlang|Elixir)\b/gi,
  // Containers & cloud & IaC
  /\b(Docker|Podman|Kubernetes|Helm|Terraform|Pulumi|AWS|Azure|GCP|Vercel|Netlify|Cloudflare|Railway|Fly\.io)\b/gi,
  // Messaging/streaming
  /\b(Kafka|RabbitMQ|NATS|SQS|SNS|Pub\/Sub|Kinesis|EventBridge|Celery|BullMQ)\b/gi,
  // Observability
  /\b(Prometheus|Grafana|OpenTelemetry|Datadog|New Relic|Sentry|Jaeger|Zipkin)\b/gi,
  // Auth & standards
  /\b(OAuth2?|OIDC|SAML|JWT|Keycloak|Auth0|Clerk|Okta|Supabase Auth|Firebase Auth)\b/gi,
  // Build/test/tools
  /\b(Vite|Webpack|Rollup|esbuild|SWC|Turbopack|Jest|Vitest|Mocha|PyTest|Playwright|Cypress|Puppeteer)\b/gi,
  // LLMs & agents
  /\b(Claude(?:\s*(?:3\.5|Opus|Sonnet))?|GPT-?4(?:o|\.?1|\.?mini)?|ChatGPT|LLaMA|Ollama|Mistral|Phi-3|Gemini|Mixtral|DeepSeek|Qwen)\b/gi,
  /\b(RAG|LangChain|LlamaIndex|Haystack|Agents?|Tools?|Function Calling|ReAct|Chain of Thought)\b/gi,
  // ML/DL libs & accel
  /\b(PyTorch|TensorFlow|Keras|scikit-?learn|XGBoost|LightGBM|RAPIDS|CUDA|cuDNN|ONNX|Hugging Face|Transformers)\b/gi,
];

const filePatterns = [
  // Simple filenames with extensions
  /(?:^|[\s"'`])([a-zA-Z0-9_.-]+\.(tsx?|jsx?|py|java|c|cpp|go|rs|rb|php|cs|mjs|cjs|sql|md|rst|csv|parquet|json|ya?ml|toml|ini|env|ipynb|proto|graphql|http|log|cfg|conf))(?=$|[\s"'`.,;:])/gim,
  // Unix/Windows paths
  /((?:\.{0,2}\/|[A-Za-z]:\\)[\w\-./\\@]+?\.(?:tsx?|jsx?|py|java|c|cpp|go|rs|sql|md|csv|json|ya?ml|toml))/g,
  // NPM packages with scope
  /(@[a-z0-9][\w-]*\/[a-z0-9][\w-]*)/gi,
  // GitHub org/repo
  /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?=#[0-9]+|\b)/g,
];

const projectPatterns = [
  // PascalCase compounds
  /\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+)\b/g,
  // kebab-case/snake_case identifiers
  /\b([a-z0-9]+(?:[-_][a-z0-9]+){2,})\b/g,
  // "Project/Service/Module X"
  /\b(?:Project|Service|Library|Module|System|Platform|Framework|Tool)\s+([A-Z][a-zA-Z0-9]+)\b/gi,
];

const versionPatterns = [
  /\bv?\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/g,  // semver
  /\b(?:CUDA|Python|Node|Chrome|Firefox)\s*(\d+(?:\.\d+)*)\b/gi,
  /\b(?:iOS|Android|Windows|macOS|Ubuntu)\s*(\d+(?:\.\d+)*)\b/gi,
];

const apiPatterns = [
  /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s'"`]+)\b/gi,
  /\bhttps?:\/\/[^\s'"`]+\/api\/[^\s'"`]+/gi,
  /\b(REST|GraphQL|gRPC|WebSocket|SSE)\b/gi,
  /\b([a-zA-Z_][a-zA-Z0-9_]*)\(\)/g,  // function calls
];

const measurePatterns = [
  /\b\d+(?:\.\d+)?\s?(ms|µs|ns|s|sec|min|h|hrs?|GB|MB|KB|TB|GiB|MiB|KiB|TiB)\b/gi,
  /\b\d+(?:\.\d+)?\s?(kN|N|MPa|GPa|psi|kg|g|mg|lb|oz|mm|cm|m|km|ft|in|µm|nm)\b/gi,
  /\b\d+(?:\.\d+)?\s?(°C|°F|K|%|fps|QPS|RPS|req\/s|tokens?\/s)\b/gi,
];

const taskPatterns = [
  /\b([A-Z]{2,10}-\d{1,6})\b/g,  // JIRA/Linear keys
  /#(\d{1,6})\b/g,  // GitHub/GitLab issues
  /\b(TODO|FIXME|BUG|HACK|NOTE|WARNING|DEPRECATED)(?:\s*:|\s*-|\s*\()/gi,
];

const standardPatterns = [
  /\bRFC\s?\d{3,5}\b/gi,
  /\b(ISO|ASTM|IEC|IEEE|ANSI|DIN)\s?\d{2,5}(?:[-:]\d+)*\b/gi,
  /\b(OpenAPI|Swagger|JSON Schema|GraphQL Schema|Protocol Buffers?|AsyncAPI)\b/gi,
];

const servicePatterns = [
  /\b(AWS\s+(?:Lambda|S3|EC2|ECS|EKS|RDS|DynamoDB|SQS|SNS|CloudWatch|CloudFormation|IAM|SageMaker|Bedrock))\b/gi,
  /\b(Azure\s+(?:Functions|Blob Storage|Container Instances|AKS|Cosmos DB|Service Bus|Monitor|DevOps))\b/gi,
  /\b(GCP\s+(?:Cloud Functions|Cloud Storage|GKE|BigQuery|Pub\/Sub|Cloud Run|Vertex AI))\b/gi,
  /\b(GitHub\s+(?:Actions|Copilot|Codespaces|Pages)|GitLab\s+(?:CI|Runner)|CircleCI|Jenkins|ArgoCD|FluxCD)\b/gi,
  /\b(Slack|Discord|Teams|Zoom|Jira|Linear|Confluence|Notion|Figma|Miro)\b/gi,
];

const dataPatterns = [
  /\b([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\b/g,  // schema.table
  /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi,
  /\bFROM\s+([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)/gi,
  /\b(?:column|field)[:\s]+["'`]?([a-z_][a-z0-9_]*)["'`]?/gi,
];

const rolePatterns = [
  /\b(CEO|CTO|CFO|COO|VP|Director|Manager|Lead|Senior|Junior|Intern)\b/gi,
  /\b(Frontend|Backend|Fullstack|DevOps|SRE|QA|Product|Design|Data)\s+(?:Engineer|Developer|Team)\b/gi,
  /\b(Engineering|Product|Design|Marketing|Sales|Support|Infrastructure)\s+Team\b/gi,
];

const decisionPatterns = [
  /\b(?:decided?|chose|selected|agreed|concluded)\s+(?:to\s+)?([^.!?]{5,50})/gi,
  /\b(?:hypothesis|assumption|theory):\s*([^.!?]{5,100})/gi,
  /\b(?:rationale|reason|because):\s*([^.!?]{5,100})/gi,
];

// Stoplist for filtering false positives
const STOPLIST = new Set([
  'the project', 'this system', 'new feature', 'final notes', 'meeting notes',
  'thank you', 'good morning', 'hello world', 'test data', 'sample code',
  'example usage', 'see below', 'as follows', 'next steps', 'action items',
  'follow up', 'please review', 'for review', 'draft version', 'work in progress'
].map(s => s.toLowerCase()));

/**
 * Enhanced extraction helper with clean group handling
 */
function collectEntities(patterns, text) {
  const hits = [];
  
  for (const { regex, entityType, groupIndex = 0 } of patterns) {
    // Ensure regex has global flag
    const flags = Array.from(new Set((regex.flags + 'g').split(''))).join('');
    const re = new RegExp(regex.source, flags);
    
    let match;
    while ((match = re.exec(text)) !== null) {
      const fullMatch = match[0];
      const extractedText = match[groupIndex] || fullMatch;
      
      if (!extractedText || extractedText.length < 2) continue;
      
      // Skip if in stoplist
      if (STOPLIST.has(extractedText.toLowerCase())) continue;
      
      // Calculate actual position of extracted text
      const startIdx = match.index + (groupIndex > 0 ? fullMatch.indexOf(extractedText) : 0);
      const endIdx = startIdx + extractedText.length;
      
      hits.push({
        text: extractedText,
        type: entityType,
        start: startIdx,
        end: endIdx,
        confidence: 0.7  // Base confidence, can be adjusted per type
      });
    }
  }
  
  return hits;
}

/**
 * Extract all entities from text
 */
function extractEntitiesFromText(text, messageId) {
  const patterns = [
    ...techPatterns.map(regex => ({ regex, entityType: 'technology' })),
    ...filePatterns.map(regex => ({ regex, entityType: 'file' })),
    ...projectPatterns.map(regex => ({ regex, entityType: 'project', groupIndex: 1 })),
    ...versionPatterns.map(regex => ({ regex, entityType: 'version_or_release' })),
    ...apiPatterns.map(regex => ({ regex, entityType: 'function_or_api', groupIndex: 2 })),
    ...measurePatterns.map(regex => ({ regex, entityType: 'measure_or_metric' })),
    ...taskPatterns.map(regex => ({ regex, entityType: 'task_or_issue' })),
    ...standardPatterns.map(regex => ({ regex, entityType: 'standard_or_spec' })),
    ...servicePatterns.map(regex => ({ regex, entityType: 'tool_or_service' })),
    ...dataPatterns.map(regex => ({ regex, entityType: 'dataset_or_schema', groupIndex: 1 })),
    ...rolePatterns.map(regex => ({ regex, entityType: 'role_or_team' })),
    ...decisionPatterns.map(regex => ({ regex, entityType: 'decision_or_hypothesis', groupIndex: 1 })),
  ];
  
  const hits = collectEntities(patterns, text);
  
  // Convert hits to entity format with message_id
  return hits.map(hit => ({
    message_id: messageId,
    entity_type: hit.type,
    surface_form: hit.text,
    canonical_name: hit.text.toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_.-]/g, ''),
    start_idx: hit.start,
    end_idx: hit.end,
    confidence: hit.confidence
  }));
}

/**
 * Process a single conversation
 */
async function processConversation(conversation) {
  const { id: conversationId, project_id } = conversation;
  
  // Get messages
  const { data: messages, error } = await supabase
    .from('cb_messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('ts');
  
  if (error || !messages || messages.length === 0) {
    return { entities: 0, mentions: 0, relationships: 0 };
  }
  
  const uniqueEntities = new Map();
  const allMentions = [];
  let relationshipCount = 0;
  
  // Extract entities from each message
  for (const message of messages) {
    const entities = extractEntitiesFromText(message.content, message.id);
    
    for (const entity of entities) {
      const key = `${entity.canonical_name}_${entity.entity_type}`;
      
      // Get or create entity
      let entityId;
      if (uniqueEntities.has(key)) {
        entityId = uniqueEntities.get(key);
      } else {
        const { data: newEntity } = await supabase
          .from('entities')
          .upsert({
            project_id,
            canonical_name: entity.canonical_name,
            entity_type: entity.entity_type,
            source: 'extraction'
          }, {
            onConflict: 'project_id,canonical_name,entity_type',
            ignoreDuplicates: true
          })
          .select()
          .single();
        
        if (newEntity) {
          entityId = newEntity.id;
          uniqueEntities.set(key, entityId);
        }
      }
      
      // Create mention
      if (entityId) {
        allMentions.push({
          project_id,
          entity_id: entityId,
          message_id: entity.message_id,
          start_idx: entity.start_idx,
          end_idx: entity.end_idx,
          surface_form: entity.surface_form,
          confidence: entity.confidence
        });
      }
    }
  }
  
  // Insert mentions in batch
  if (allMentions.length > 0) {
    const { error: mentionError } = await supabase
      .from('entity_mentions')
      .insert(allMentions);
    
    if (mentionError) {
      console.error('Error inserting mentions:', mentionError);
    }
  }
  
  // Create co-occurrence relationships
  const entitiesPerMessage = new Map();
  allMentions.forEach(m => {
    if (!entitiesPerMessage.has(m.message_id)) {
      entitiesPerMessage.set(m.message_id, []);
    }
    entitiesPerMessage.get(m.message_id).push(m.entity_id);
  });
  
  for (const [messageId, entityIds] of entitiesPerMessage) {
    const uniqueIds = [...new Set(entityIds)];
    
    for (let i = 0; i < uniqueIds.length - 1; i++) {
      for (let j = i + 1; j < uniqueIds.length; j++) {
        await supabase
          .from('relationships')
          .upsert({
            project_id,
            subject_entity_id: uniqueIds[i],
            predicate: 'co_mentioned',
            object_entity_id: uniqueIds[j],
            direction: 'symmetric',
            strength: 0.5,
            evidence: JSON.stringify([{ message_id: messageId }])
          }, {
            onConflict: 'project_id,subject_entity_id,predicate,object_entity_id',
            ignoreDuplicates: true
          });
        relationshipCount++;
      }
    }
  }
  
  return {
    entities: uniqueEntities.size,
    mentions: allMentions.length,
    relationships: relationshipCount
  };
}

/**
 * Main extraction pipeline
 */
async function main() {
  console.log('Starting enhanced entity extraction...\n');
  
  let stats = {
    conversations: 0,
    entities: 0,
    mentions: 0,
    relationships: 0
  };
  
  let offset = 0;
  const batchSize = 5;
  
  while (true) {
    const { data: conversations } = await supabase
      .from('conversations')
      .select('id, project_id')
      .range(offset, offset + batchSize - 1);
    
    if (!conversations || conversations.length === 0) break;
    
    for (const conv of conversations) {
      const result = await processConversation(conv);
      stats.conversations++;
      stats.entities += result.entities;
      stats.mentions += result.mentions;
      stats.relationships += result.relationships;
      
      console.log(`Conv ${conv.id}: ${result.entities} entities, ${result.mentions} mentions, ${result.relationships} relationships`);
    }
    
    offset += batchSize;
    console.log(`Progress: ${stats.conversations} conversations processed...`);
  }
  
  console.log('\n=== Extraction Complete ===');
  console.log(`Conversations: ${stats.conversations}`);
  console.log(`Unique entities: ${stats.entities}`);
  console.log(`Entity mentions: ${stats.mentions}`);
  console.log(`Relationships: ${stats.relationships}`);
}

main().catch(console.error);