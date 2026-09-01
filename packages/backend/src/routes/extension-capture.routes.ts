import { Router } from 'express';
import { SupabaseClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { detectFileType } from '../utils/file-type-detector';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import mammoth from 'mammoth';
import { SEARCH_CONFIG } from '../config/search-config';

// Helper to trigger entity extraction after capture
async function triggerEntityExtraction(
  supabase: SupabaseClient, 
  projectId: string, 
  conversationId: string
) {
  try {
    console.log(`[Auto-Extract] Triggering entity extraction for conversation ${conversationId}`);
    
    // 1. Fetch all messages for this conversation (NOW WITH ID)
    const { data: messages, error: msgError } = await supabase
      .from('cb_messages')
      .select('id, content, role')  // ✅ Added 'id'
      .eq('conversation_id', conversationId)
      .order('index_in_thread', { ascending: true });
    
    if (msgError) {
      console.error('[Auto-Extract] Error fetching messages:', msgError);
      return { success: false, error: msgError.message };
    }
    
    if (!messages || messages.length === 0) {
      console.log('[Auto-Extract] No messages found for extraction');
      return { success: false, error: 'No messages found' };
    }
    
    // 2. Calculate total text length for logging (preserve existing logging)
    const fullTextLength = messages
      .map(m => m.content)
      .filter(c => c && c.trim().length > 0)
      .reduce((sum, c) => sum + c.length, 0);
    
    console.log(`[Auto-Extract] Extracted ${fullTextLength} chars from ${messages.length} messages`);
    
    if (fullTextLength === 0) {
      console.log('[Auto-Extract] No text content to extract from');
      return { success: false, error: 'No text content' };
    }
    
    // 3. Process EACH message individually with its message_id
    console.log(`[Auto-Extract] Processing messages individually with IDs`);
    let totalEntities = 0;
    let processedMessages = 0;
    
    for (const message of messages) {
      if (!message.content || message.content.trim().length === 0) {
        continue;
      }

      const { data, error } = await supabase.rpc('extract_entities_from_text_v2', {
        p_project_id: projectId,
        p_text: message.content,
        p_message_id: message.id,  // ✅ Pass message ID for proper linkage
        p_cb_file_id: null,
        p_block_id: null
      });

      if (error) {
        console.error(`[Auto-Extract] Error on message ${message.id}:`, error);
        continue; // Skip this message but continue with others
      }

      if (data?.entities_detected) {
        totalEntities += data.entities_detected;
      }
      processedMessages++;
    }
    
    console.log(`[Auto-Extract] ✅ Extracted ${totalEntities} entities from ${processedMessages}/${messages.length} messages`);
    
    // 4. Generate relationships now that mentions are linked to messages
    console.log(`[Auto-Extract] Generating relationships for conversation ${conversationId}`);
    const { data: relData, error: relError } = await supabase.rpc('cb_generate_relationships_for_conversation', {
      p_project_id: projectId,
      p_conversation_id: conversationId
    });
    
    if (relError) {
      console.error('[Auto-Extract] Relationship generation error:', relError);
      console.log(`   ⚠️  Entity extraction succeeded but relationships failed`);
    } else {
      console.log(`[Auto-Extract] ✅ Created ${relData?.relationships_created || 0} relationships`);
    }
    
    // 5. Return comprehensive result (backward compatible + enhanced)
    return { 
      success: true, 
      result: {
        entities_detected: totalEntities,
        messages_processed: processedMessages,
        relationships_created: relData?.relationships_created || 0
      }
    };
    
  } catch (error: any) {
    console.error('[Auto-Extract] Exception:', error);
    return { success: false, error: error.message };
  }
}

async function extractConceptsFromConversation(
  supabase: SupabaseClient,
  projectId: string,
  conversationId: string,
  messages: Array<{ id: string; content: string; role: string }>
) {
  try {
    const config = SEARCH_CONFIG.conceptExtraction;
    
    if (!messages || messages.length === 0) {
      console.log('[Concept Extract] No messages to extract concepts from');
      return { success: false, error: 'No messages' };
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      console.warn('[Concept Extract] ANTHROPIC_API_KEY not set, skipping');
      return { success: false, error: 'No API key' };
    }

    // Get conversation title for context
    const { data: conv } = await supabase
      .from('cb_conversations')
      .select('title, summary')
      .eq('id', conversationId)
      .single();

    const title = conv?.title || conv?.summary || 'Untitled';

    // Select head + tail messages, truncated
    const head = messages.slice(0, config.messagesHead);
    const tail = messages.length > config.messagesHead
      ? messages.slice(-config.messagesTail)
      : [];
    
    const selectedMessages = [...head, ...tail];
    
    const messageText = selectedMessages
      .map(m => {
        const truncated = (m.content || '').slice(0, config.maxCharsPerMessage);
        return `[${m.role}]: ${truncated}`;
      })
      .join('\n\n');

    console.log(`[Concept Extract] Sending ${selectedMessages.length} messages (${messageText.length} chars) for conversation: "${title}"`);

    // Call Claude to extract concepts (raw fetch, no SDK)
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `Extract the key domain concepts from this conversation. Return ONLY a JSON array of strings, no explanation.

Rules:
- Extract ${config.minConcepts}-${config.maxConcepts} concepts
- Focus on domain-specific terms, methodologies, patterns, and topics (NOT generic words)
- Include technical concepts, business terms, named frameworks, algorithms, or domain jargon
- Each concept should be 1-4 words
- Do NOT include file names, generic programming terms like "function" or "variable", or stop words

Conversation title: "${title}"

${messageText}

Respond with ONLY a JSON array like: ["concept one", "concept two", "concept three"]`
        }]
      })
    });

    // Parse response
    if (!response.ok) {
      const errBody = await response.text();
      console.error('[Concept Extract] API error:', response.status, errBody);
      return { success: false, error: `API ${response.status}` };
    }

    const data = await response.json() as any;
    const responseText = (data.content || [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');

    let concepts: string[] = [];
    try {
      const cleaned = responseText.replace(/```json\s*|```/g, '').trim();
      concepts = JSON.parse(cleaned);
      if (!Array.isArray(concepts)) concepts = [];
    } catch (parseErr) {
      console.error('[Concept Extract] Failed to parse LLM response:', responseText);
      return { success: false, error: 'Parse error' };
    }

    // Deduplicate and limit
    concepts = [...new Set(concepts.map(c => c.trim()).filter(c => c.length > 0))]
      .slice(0, config.maxConcepts);

    console.log(`[Concept Extract] Extracted ${concepts.length} concepts:`, concepts);

    // Insert into cb_entities via cb_upsert_entity_mention
    let inserted = 0;
    for (const concept of concepts) {
      try {
        await supabase.rpc('cb_upsert_entity_mention', {
          p_project_id: projectId,
          p_name: concept,
          p_type: 'concept',
          p_message_id: messages[0]?.id || null,
          p_cb_file_id: null,
          p_block_id: null,
          p_snippet: null,
        });
        inserted++;
      } catch (err) {
        console.warn(`[Concept Extract] Failed to insert concept "${concept}":`, err);
      }
    }

    console.log(`[Concept Extract] ✅ Inserted ${inserted}/${concepts.length} concepts for conversation ${conversationId}`);
    return { success: true, concepts: inserted };

  } catch (error: any) {
    console.error('[Concept Extract] Exception:', error.message);
    return { success: false, error: error.message };
  }
}

export function createExtensionCaptureRoutes(supabase: SupabaseClient) {
  const router = Router();

  router.post('/api/capture/urls', async (req, res) => {
    console.log('=== /api/capture/urls ENDPOINT HIT ===');
    console.log('Body received:', {
      projectId: req.body.projectId,
      projectName: req.body.projectName,
      conversationCount: req.body.conversations?.length
    });
    
    try {
      const { projectId, projectName, conversations, llmProvider } = req.body;

      // FIRST: Create or verify project exists
      console.log(`Checking if project exists: ${projectId}`);
      const { data: existingProject, error: checkError } = await supabase
        .from('cb_projects')
        .select('id')
        .eq('id', projectId)
        .single();
      
      console.log('Project check result:', { exists: !!existingProject, error: checkError });
      
      if (!existingProject) {
        // Warn if no project name provided
        if (!projectName) {
          console.warn(`No project name provided for ${projectId}, using fallback`);
        }
        
        const finalProjectName = projectName || 'Unnamed Project';
        console.log(`Creating project: ${projectId} - ${finalProjectName}`);

        // Use upsert to avoid conflicts
        const { data: newProject, error: projectError } = await supabase
          .from('cb_projects')
          .upsert({
            id: projectId,
            name: finalProjectName,
            created_at: new Date().toISOString()
          }, {
            onConflict: 'id'
          });
        
        if (projectError) {
          console.error('Project creation error:', projectError);
          // Continue anyway - project might exist
        } else {
          console.log('Project created successfully');
        }
      }
      
      // NOW insert conversations
      console.log(`Inserting ${conversations.length} conversations...`);
      
      // Use upsert for conversations too
      const conversationsToInsert = conversations.map((conv: any) => ({
        id: conv.id,
        project_id: projectId,
        summary: conv.title || 'Untitled',
        url: conv.url,
        llm_provider: llmProvider || 'claude',
        created_at: new Date().toISOString(),
        message_count: 0,
        token_count: 0
      }));
      
      const { data: inserted, error: convError } = await supabase
        .from('cb_conversations')
        .upsert(conversationsToInsert, {
          onConflict: 'id'
        });
      
      if (convError) {
        console.error('Conversation insert error:', convError);
        return res.status(500).json({ error: convError.message });
      }
      
      console.log('Successfully saved conversations');
      
      res.json({ 
        success: true,
        message: `Saved ${conversations.length} conversations`
      });
      
    } catch (error: any) {
      console.error('CAPTURE ERROR:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get capture status for multiple conversations at once
  router.post('/api/projects/:projectId/capture-status', async (req, res) => {
    try {
      const { projectId } = req.params;
      const { conversationIds } = req.body;
      
      const { data, error } = await supabase
        .from('cb_conversations')
        .select('id, message_count')
        .eq('project_id', projectId)
        .in('id', conversationIds);
      
      if (error) throw error;
      
      // Return map of id -> captured status
      const statusMap: Record<string, boolean> = {};
      data?.forEach(conv => {
        statusMap[conv.id] = conv.message_count > 0;
      });
      
      res.json({
        captured: statusMap,
        summary: {
          total: conversationIds.length,
          captured: Object.values(statusMap).filter(v => v).length,
          needsCapture: Object.values(statusMap).filter(v => !v).length
        }
      });
      
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/api/extension/capture', async (req, res) => {
    const startTime = Date.now();
    const payloadSize = JSON.stringify(req.body).length;
    const convId = req.body?.conversationId || 'unknown';
    
    console.log(`\n========================================`);
    console.log(`[Capture START] ${convId}`);
    console.log(`[Capture] Payload: ${(payloadSize / 1024 / 1024).toFixed(2)} MB`);
    console.log(`[Capture] Messages: ${req.body?.conversation?.messages?.length || 0}`);
    console.log(`========================================\n`);
    
    if (payloadSize > 40 * 1024 * 1024) {  // Warning if over 40MB
      console.warn('⚠️ LARGE PAYLOAD - May cause timeouts or failures');
    }
    
    try {
      const { projectId, conversationId, conversation, captureMetadata, userId } = req.body;
      
      console.log(`[Extension Capture] Project: ${projectId}, Conv: ${conversationId}`);
      
      /// Ensure project exists
      const provider = conversation.provider || 'claude';
      const providerProjectId = conversation.provider_project_id || projectId;

      const { data: project, error: projectError } = await supabase
        .from('cb_projects')
        .upsert({
          id: projectId, // UUID (real UUID for Claude, generated for OpenAI)
          name: conversation.project_name || 'Captured Project',
          provider: provider,
          provider_project_id: providerProjectId, // Original ID (gizmo_id for OpenAI)
          user_id: userId || 'default',
          created_at: new Date().toISOString()
        }, { onConflict: 'id' })
        .select()
        .single();

      if (projectError) {
        console.error('Project upsert error:', projectError);
        // Continue anyway
      }

      // Save conversation
      const conversationTitle = conversation.name || conversation.title || 'Untitled';

      const { data: conv, error: convError } = await supabase
        .from('cb_conversations')
        .upsert({
          id: conversationId,
          project_id: projectId,
          title: conversationTitle,           // Always save to title field
          summary: conversationTitle,         // Also save to summary for backward compatibility
          created_at: conversation.created_at,
          updated_at: conversation.updated_at,
          url: conversation.url 
            || (provider === 'claude' 
              ? `https://claude.ai/chat/${conversationId}`
              : provider === 'grok'
                ? `https://x.com/i/grok?conversation=${conversationId}`
                : provider === 'gemini'
                  ? `https://gemini.google.com/app/${conversationId}`
                  : `https://chatgpt.com/c/${conversationId}`),
          llm_provider: provider || 'claude'
        }, { onConflict: 'id' })
        .select()
        .single();

      if (convError) {
        console.error('Conversation upsert error:', convError);
        return res.status(500).json({ error: convError.message });
      }

      // Extract and save messages with files
      const messages = conversation.messages || conversation.chat_messages || [];
      const extractedFiles = [];

      console.log('First message sample:', JSON.stringify(messages[0], null, 2));
      
      // Find a message with code to debug
      const msgWithCode = messages.find((m: any) => 
        m.content && Array.isArray(m.content) && 
        m.content.some((c: any) => c.type !== 'text' || (c.text && c.text.includes('```')))
      );
      
      if (msgWithCode) {
        console.log('Found message with code:', JSON.stringify(msgWithCode, null, 2));
      }

      // helper to sanitize filenames
      function normalizeFileName(name: string): string {
        return (name || '').trim().replace(/^[`'"]+|[`'"]+$/g, '');
      }

      for (const msg of messages) {

      // Debug: Log files_v2 on ALL messages (including assistant)
      if ((msg.files_v2?.length > 0 || msg.files?.length > 0) && msg.sender === 'assistant') {
        console.log('[DEBUG] Assistant message has files:', JSON.stringify({
          sender: msg.sender,
          files: msg.files,
          files_v2: msg.files_v2
        }, null, 2));
      }

      // Attachments with extracted_content → extractedFiles[]
      if (msg.attachments && Array.isArray(msg.attachments)) {
        console.log('Found attachments:', msg.attachments.length);
        if (msg.attachments.length > 0) {
          console.log('Attachment details:', JSON.stringify(msg.attachments.map((a: any) => ({
            file_name: a.file_name,
            file_type: a.file_type,
            has_extracted_content: !!a.extracted_content,
            content_length: a.extracted_content?.length || 0,
            all_keys: Object.keys(a)
          })), null, 2));
        }

        // Debug: Check for files in other fields
        if (msg.files?.length > 0 || msg.files_v2?.length > 0) {
          console.log('Files found in alternate fields:', JSON.stringify({
            files: msg.files,
            files_v2: msg.files_v2
          }, null, 2));
        }
        
        for (const attachment of msg.attachments) {
          if (!attachment.extracted_content) continue;

          const rawName = attachment.file_name || 'unknown';
          const sanitizedAttachmentName = normalizeFileName(rawName);
            
            // Use robust file type detection
            const detected = await detectFileType(sanitizedAttachmentName, attachment.extracted_content);

            extractedFiles.push({
              conversation_id: conversationId,
              project_id: projectId,
              file_name: sanitizedAttachmentName,
              file_type: detected.file_type,
              file_extension: detected.file_extension,
              language: detected.language,
              content: attachment.extracted_content,
              content_sha: crypto.createHash('sha256').update(attachment.extracted_content).digest('hex'),
              content_tokens: Math.ceil(attachment.extracted_content.length / 4),
            });
          }

        // Handle OpenAI attachments (metadata only - no content extraction available)
        for (const attachment of msg.attachments) {
          // Skip if already processed (has extracted_content) 
          if (attachment.extracted_content) continue;
          
          // OpenAI attachments have: id, name, mime_type, size
          // Check if this looks like an OpenAI attachment
          if (attachment.id && attachment.name && attachment.mime_type) {
            console.log(`[OpenAI File] Found attachment: ${attachment.name} (${attachment.mime_type})`);
            
            const fileName = normalizeFileName(attachment.name);
            const fileExtension = fileName.split('.').pop()?.toLowerCase() || 'txt';
            
            // Determine file type from mime_type or extension
            let fileType = 'document';
            if (attachment.mime_type?.startsWith('image/')) {
              fileType = 'image';
            } else if (attachment.mime_type === 'application/pdf') {
              fileType = 'document';
            } else if (attachment.mime_type === 'text/markdown' || fileExtension === 'md') {
              fileType = 'text';
            } else if (['js', 'ts', 'py', 'java', 'cpp', 'c', 'go', 'rs'].includes(fileExtension)) {
              fileType = 'code';
            }
            
            // Create a placeholder entry with metadata only
            const placeholderContent = `[OpenAI file - content not captured]\nFile: ${fileName}\nType: ${attachment.mime_type}\nSize: ${attachment.size || 'unknown'} bytes`;
            
            extractedFiles.push({
              conversation_id: conversationId,
              project_id: projectId,
              file_name: fileName,
              file_type: fileType,
              file_extension: fileExtension,
              language: null,
              content: placeholderContent,
              content_sha: crypto.createHash('sha256').update(`openai_${attachment.id}`).digest('hex'),
              content_tokens: 0,
            });
            
            console.log(`[OpenAI File] ✅ Added metadata-only entry for ${fileName} (skip_embedding: true)`);
          }
        }
        }

        // Handle files_v2 (PDFs and other files without extracted_content)
        if (msg.files_v2 && Array.isArray(msg.files_v2) && msg.files_v2.length > 0) {
          console.log('Processing files_v2:', msg.files_v2.length);
          
          for (const fileInfo of msg.files_v2) {
            if (!fileInfo.success || !fileInfo.file_name) continue;
            
            const fileName = fileInfo.file_name;
            const isPdf = fileName.toLowerCase().endsWith('.pdf');
            
            // Check if extension sent PDF base64 data
            if (isPdf && fileInfo.pdf_base64) {
              console.log(`[PDF] Processing base64 PDF: ${fileName} (${fileInfo.pdf_base64.length} chars)`);
              
              try {
                // Decode base64 to buffer
                const pdfBuffer = Buffer.from(fileInfo.pdf_base64, 'base64');
                console.log(`[PDF] Decoded buffer: ${pdfBuffer.length} bytes`);
                
                // Parse PDF to extract text using pdfjs-dist
                const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer) });
                const pdfDoc = await loadingTask.promise;
                
                let extractedText = '';
                for (let i = 1; i <= pdfDoc.numPages; i++) {
                  const page = await pdfDoc.getPage(i);
                  const textContent = await page.getTextContent();
                  const pageText = textContent.items
                    .map((item: any) => item.str)
                    .join(' ');
                  extractedText += pageText + '\n';
                }
                extractedText = extractedText.trim();
                console.log(`[PDF] ✅ Extracted ${extractedText.length} chars from ${fileName}`);
                
                // Sanitize filename
                const sanitizedFileName = normalizeFileName(fileName);
                
                // Detect file type
                const detected = await detectFileType(sanitizedFileName, extractedText);
                
                // Add to extracted files (same format as attachments)
                extractedFiles.push({
                  conversation_id: conversationId,
                  project_id: projectId,
                  file_name: sanitizedFileName,
                  file_type: detected.file_type || 'document',
                  file_extension: 'pdf',
                  language: null,
                  content: extractedText
                });
                
                console.log(`[PDF] ✅ Added ${sanitizedFileName} to extractedFiles`);
                
              } catch (pdfError: any) {
                console.error(`[PDF] Error parsing ${fileName}:`, pdfError.message);
              }
            } else if (isPdf) {
              console.log(`[PDF] Found PDF without base64 data: ${fileName}`);
            }
          }
        }

        // Handle Claude-generated artifacts from present_files tool results
        if (msg.content && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'tool_use' && block.name === 'present_files' && block.artifact_files) {
              console.log(`[Artifact] Processing ${block.artifact_files.length} artifact files`);
              
              for (const artifact of block.artifact_files) {
                if (!artifact.artifact_base64 || !artifact.file_name) continue;
                
                const fileName = artifact.file_name;
                const isDocx = fileName.toLowerCase().endsWith('.docx');
                
                try {
                  const fileBuffer = Buffer.from(artifact.artifact_base64, 'base64');
                  console.log(`[Artifact] Processing: ${fileName} (${fileBuffer.length} bytes)`);
                  
                  let extractedText = '';
                  
                  if (isDocx) {
                    // Parse DOCX using mammoth
                    const result = await mammoth.extractRawText({ buffer: fileBuffer });
                    extractedText = result.value;
                    console.log(`[Artifact] ✅ Extracted ${extractedText.length} chars from DOCX: ${fileName}`);
                  } else {
                    // For other file types, try to decode as text
                    try {
                      extractedText = fileBuffer.toString('utf-8');
                      console.log(`[Artifact] ✅ Decoded ${extractedText.length} chars as text: ${fileName}`);
                    } catch {
                      console.log(`[Artifact] ⚠️ Could not decode ${fileName} as text`);
                      continue;
                    }
                  }
                  
                  if (extractedText.length > 0) {
                    // Sanitize filename
                    const sanitizedFileName = normalizeFileName(fileName);
                    
                    // Detect file type
                    const detected = await detectFileType(sanitizedFileName, extractedText);
                    const fileExtension = fileName.split('.').pop()?.toLowerCase() || 'txt';
                    
                    // Add to extracted files
                    extractedFiles.push({
                      conversation_id: conversationId,
                      project_id: projectId,
                      file_name: sanitizedFileName,
                      file_type: detected.file_type || 'document',
                      file_extension: fileExtension,
                      language: null,
                      content: extractedText
                    });
                    
                    console.log(`[Artifact] ✅ Added ${sanitizedFileName} to extractedFiles`);
                  }
                } catch (artifactError: any) {
                  console.error(`[Artifact] Error processing ${fileName}:`, artifactError.message);
                }
              }
            }
          }
        }

        // Fenced code **in message text** → extractedFiles[]
        const text = (() => {
          if (Array.isArray(msg.content)) {
            // Claude-like schema: pull only text items (skip thinking etc.)
            return msg.content
              .filter((it: any) => it.type === 'text')
              .map((it: any) => it.text || '')
              .join('\n');
          }
          return typeof msg.text === 'string'
            ? msg.text
            : (typeof msg.content === 'string' ? msg.content : '');
        })();

        if (text && text.includes('```')) {
          const FENCE_RE = /```(\w+)?\s*?\n([\s\S]*?)\n```/g;
          const HINT_RE  = /(file|path|source)\s*:\s*([^\s"']+\.[a-z0-9]+)\b/i;
          const hinted   = HINT_RE.exec(text);
          const hintedName = hinted?.[2];

          let m: RegExpExecArray | null;
          while ((m = FENCE_RE.exec(text)) !== null) {
            const lang = (m[1] || '').trim();   // e.g. js / ts / css …
            const code = m[2] || '';
            if (!code.trim()) continue;

            const ext = (lang || '').toLowerCase();
            const fileExt = ext || 'txt';

            const idx = extractedFiles.length;
            const nameFromHint = hintedName as string | undefined; // narrow type
            const base = nameFromHint ?? `msg_${conversationId}_${idx}.${fileExt}`;
            const fileName: string = normalizeFileName(base);      // ✅ sanitize here

            extractedFiles.push({
              conversation_id: conversationId,
              project_id: projectId,
              file_name: fileName,
              content: code,
              file_type: ['js','ts','py','java','cpp','c','cs','go','rs','html','css','json','yml','yaml','sql'].includes(fileExt) ? 'code' : 'text',
              file_extension: fileExt,
              language: lang || null,
              content_sha: crypto.createHash('sha256').update(code).digest('hex'),
              content_tokens: Math.ceil(code.length / 4),
              importance_score: 0.6,
            });
          }
        }
      }

      // Save files to cb_files if any
      if (extractedFiles.length > 0) {
        // Deduplicate by (conversation_id, content_sha)
        const uniqueFiles = Array.from(
          new Map(extractedFiles.map(f => [`${f.conversation_id}_${f.content_sha}`, f])).values()
        );
        
        const { error: filesError } = await supabase
          .from('cb_files')
          .upsert(uniqueFiles, { onConflict: 'conversation_id,content_sha' });
        
        if (filesError) {
          console.error('Files insert error:', filesError);
        } else {
          console.log(`   📄 Saved ${extractedFiles.length} files`);
        }
      }

      // Extract code blocks and artifacts from messages
      const codeBlocks: any[] = [];

      for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
        const msg = messages[msgIndex];
        
        // Extract markdown code blocks from text content
        if (msg.text && typeof msg.text === 'string') {
          const codeBlockRegex = /```([\w-]+)?(?:[^\n]*)?\n([\s\S]*?)```/g;
          let match;
          let blockIndex = 0;
          
          while ((match = codeBlockRegex.exec(msg.text)) !== null) {
            const language = match[1] || 'text';
            const content = match[2];
            
            if (content.trim()) {
              codeBlocks.push({
                message_id: msg.uuid,
                kind: 'code',
                language: language,
                file_name: `msg_${msgIndex}_block_${blockIndex}.${language}`,
                content: content,
                content_sha: crypto.createHash('sha256').update(content).digest('hex'),
                meta: { extracted_from: 'markdown' }
              });
              blockIndex++;
            }
          }
        }
        
        // Extract from content array
        if (msg.content && Array.isArray(msg.content)) {
          for (const item of msg.content) {
            if (item.type === 'text' && item.text) {
              // Check for code blocks in structured text
              const codeBlockRegex = /```([\w-]+)?(?:[^\n]*)?\n([\s\S]*?)```/g;
              let match;
              let blockIndex = 0;
              
              while ((match = codeBlockRegex.exec(item.text)) !== null) {
                const language = match[1] || 'text';
                const content = match[2];
                
                if (content.trim()) {
                  codeBlocks.push({
                    message_id: msg.uuid,
                    kind: 'code',
                    language: language,
                    file_name: `msg_${msgIndex}_block_${blockIndex}.${language}`,
                    content: content,
                    content_sha: crypto.createHash('sha256').update(content).digest('hex'),
                    meta: { extracted_from: 'content_text' }
                  });
                  blockIndex++;
                }
              }
            }
          }
        }
      } // ✅ Close the code blocks for loop

      // Extract text/file blocks (JSON, YAML, config files, etc.)
      const textBlocks: any[] = [];

      for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
        const msg = messages[msgIndex];
        
        // Extract non-code file blocks from markdown (json, yaml, xml, etc.)
        if (msg.text && typeof msg.text === 'string') {
          const textBlockRegex = /```(json|yaml|yml|xml|txt|md|csv|toml|ini|env|config)(?:[^\n]*)?\n([\s\S]*?)```/g;
          let match;
          let blockIndex = 0;
          
          while ((match = textBlockRegex.exec(msg.text)) !== null) {
            const fileType = match[1];
            const content = match[2];
            
            if (content.trim()) {
              textBlocks.push({
                message_id: msg.uuid,
                kind: 'file',
                language: fileType,
                file_name: `msg_${msgIndex}_${fileType}_${blockIndex}.${fileType}`,
                content: content,
                content_sha: crypto.createHash('sha256').update(content).digest('hex'),
                meta: { extracted_from: 'markdown', file_type: fileType }
              });
              blockIndex++;
            }
          }
        }
        
        // Extract from content array
        if (msg.content && Array.isArray(msg.content)) {
          for (const item of msg.content) {
            if (item.type === 'text' && item.text) {
              const textBlockRegex = /```(json|yaml|yml|xml|txt|md|csv|toml|ini|env|config)(?:[^\n]*)?\n([\s\S]*?)```/g;
              let match;
              let blockIndex = 0;
              
              while ((match = textBlockRegex.exec(item.text)) !== null) {
                const fileType = match[1];
                const content = match[2];
                
                if (content.trim()) {
                  textBlocks.push({
                    message_id: msg.uuid,
                    kind: 'file',
                    language: fileType,
                    file_name: `msg_${msgIndex}_${fileType}_${blockIndex}.${fileType}`,
                    content: content,
                    content_sha: crypto.createHash('sha256').update(content).digest('hex'),
                    meta: { extracted_from: 'content_text', file_type: fileType }
                  });
                  blockIndex++;
                }
              }
            }
          }
        }
      } // ✅ Close the text blocks for loop

      // Update conversation with message data
      const totalTokens = messages.reduce((sum: number, msg: any) => {
        // Check both 'text' (OpenAI) and 'content' (Claude) fields
        const textContent = msg.text || (typeof msg.content === 'string' ? msg.content : '');
        let msgTokens = Math.ceil((textContent.length || 0) / 4);
        if (msg.attachments) {
          msg.attachments.forEach((att: any) => {
            if (att.extracted_content) {
              msgTokens += Math.ceil(att.extracted_content.length / 4);
            }
          });
        }
        return sum + msgTokens;
      }, 0);

      // Count actual code and text files
      const codeFileCount = extractedFiles.filter(f => 
        f.file_type === 'code'
      ).length;

      const textFileCount = extractedFiles.filter(f => 
        f.file_type === 'text' || f.file_type === 'document'
      ).length;

      console.log(`Updating conversation ${conversationId}:`);
      console.log(`  - Messages: ${messages.length}`);
      console.log(`  - Tokens: ${totalTokens}`);
      console.log(`  - Code files: ${codeFileCount}`);
      console.log(`  - Text files: ${textFileCount}`);

      // First, get existing raw_messages to merge
      const { data: existingConv } = await supabase
        .from('cb_conversations')
        .select('raw_messages')
        .eq('id', conversationId)
        .single();

      // Merge existing and new raw_messages (dedupe by uuid)
      const existingMessages = existingConv?.raw_messages || [];
      const existingUuids = new Set(existingMessages.map((m: any) => m.uuid));
      const newUniqueMessages = messages.filter((m: any) => !existingUuids.has(m.uuid));
      const mergedMessages = [...existingMessages, ...newUniqueMessages];

      // Calculate totals from merged messages
      const totalMessageCount = mergedMessages.length;
      const mergedTokens = mergedMessages.reduce((sum: number, msg: any) => {
        let textContent = msg.text || '';
        if (!textContent && typeof msg.content === 'string') {
          textContent = msg.content;
        } else if (!textContent && Array.isArray(msg.content)) {
          textContent = msg.content
            .filter((c: any) => c.type === 'text' && c.text)
            .map((c: any) => c.text)
            .join('\n');
        }
        let msgTokens = Math.ceil((textContent.length || 0) / 4);
        if (msg.attachments) {
          msg.attachments.forEach((att: any) => {
            if (att.extracted_content) {
              msgTokens += Math.ceil(att.extracted_content.length / 4);
            }
          });
        }
        return sum + msgTokens;
      }, 0);

      // Get actual file counts from database
      const [codeFilesResult, textFilesResult] = await Promise.all([
        supabase.from('cb_files').select('id', { count: 'exact', head: true })
          .eq('conversation_id', conversationId).eq('file_type', 'code'),
        supabase.from('cb_files').select('id', { count: 'exact', head: true })
          .eq('conversation_id', conversationId).in('file_type', ['text', 'document'])
      ]);

      const totalCodeFiles = codeFilesResult.count || 0;
      const totalTextFiles = textFilesResult.count || 0;

      console.log(`Updating conversation ${conversationId}:`);
      console.log(`  - Messages: ${totalMessageCount} (${newUniqueMessages.length} new)`);
      console.log(`  - Tokens: ${mergedTokens}`);
      console.log(`  - Code files: ${totalCodeFiles}`);
      console.log(`  - Text files: ${totalTextFiles}`);

      const { error: updateError } = await supabase
        .from('cb_conversations')
        .update({
          raw_messages: mergedMessages,
          message_count: totalMessageCount,
          token_count: mergedTokens,
          code_files_count: totalCodeFiles,
          text_files_count: totalTextFiles,
          captured_at: new Date().toISOString()
        })
        .eq('id', conversationId);

      if (updateError) {
        console.error('Conversation update error:', updateError);
      } else {
        console.log(`✅ Updated conversation ${conversationId} with ${messages.length} messages`);
      }

      console.log(`✅ Saved conversation ${conversationId}: ${messages.length} messages, ${extractedFiles.length} files`);

      // Insert individual messages into cb_messages table
      const messagesToInsert = messages.map((msg: any, index: number) => ({
        id: msg.uuid,
        project_id: projectId,
        conversation_id: conversationId,
        role: msg.sender === 'human' ? 'user' : 'assistant',
        content: extractMessageContent(msg),
        created_at: msg.created_at || new Date().toISOString(),
        index_in_thread: index,
        content_sha: crypto.createHash('sha256')
          .update(extractMessageContent(msg))
          .digest('hex')
      }));

      const { error: messagesError } = await supabase
        .from('cb_messages')
        .upsert(messagesToInsert, {
          onConflict: 'id'
        });

      if (messagesError) {
        console.error('Messages insert error:', messagesError);
      } else {
        console.log(`   💬 Inserted ${messagesToInsert.length} messages into cb_messages`);
      }

      // Save code blocks (AFTER messages exist)
      if (codeBlocks.length > 0) {
        const uniqueCodeBlocks = Array.from(
          new Map(codeBlocks.map(b => [`${b.message_id}_${b.content_sha}`, b])).values()
        );
        
        const { error: blocksError } = await supabase
          .from('cb_blocks')
          .upsert(uniqueCodeBlocks, { onConflict: 'message_id,content_sha' });
        
        if (blocksError) {
          console.error('Blocks insert error:', blocksError);
        } else {
          console.log(`   🧱 Saved ${codeBlocks.length} code blocks`);
        }
      }

      // Save text blocks (AFTER messages exist)
      if (textBlocks.length > 0) {
        const uniqueTextBlocks = Array.from(
          new Map(textBlocks.map(b => [`${b.message_id}_${b.content_sha}`, b])).values()
        );
        
        const { error: textBlocksError } = await supabase
          .from('cb_blocks')
          .upsert(uniqueTextBlocks, { onConflict: 'message_id,content_sha' });
        
        if (textBlocksError) {
          console.error('Text blocks insert error:', textBlocksError);
        } else {
          console.log(`   📝 Saved ${textBlocks.length} text blocks`);
        }
      }

      // Trigger entity extraction
      triggerEntityExtraction(supabase, projectId, conversationId)
        .then(result => {
          if (result.success) {
            console.log(`   🏷️  Entity extraction completed for ${conversationId}`);
          } else {
            console.warn(`   ⚠️  Entity extraction failed: ${result.error}`);
          }
        })
        .catch(err => {
          console.error(`   ❌ Entity extraction error:`, err);
        });

      // Trigger concept extraction (LLM-based, fire-and-forget)
      extractConceptsFromConversation(
        supabase,
        projectId,
        conversationId,
        messagesToInsert.map(m => ({ id: m.id, content: m.content, role: m.role }))
      )
        .then(result => {
          if (result.success) {
            console.log(`   💡 Concept extraction completed for ${conversationId}: ${result.concepts} concepts`);
          } else {
            console.warn(`   ⚠️  Concept extraction skipped: ${result.error}`);
          }
        })
        .catch(err => {
          console.error(`   ❌ Concept extraction error:`, err);
        });

      // Finally trigger auto-embedding (once, at the very end)
      console.log(`[Capture] 🎨 Triggering auto-embed for conversation ${conversationId}`);
      const embedUrl = `http://localhost:${process.env.PORT || 3001}/api/context/_auto-embed`;

      (async () => {
        try {
          const response = await fetch(embedUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId, conversationId })
          });
          
          const data = await response.json();
          console.log(`[Capture] ✅ Auto-embed response:`, data);
        } catch (err: any) {
          console.error(`[Capture] ❌ Auto-embed failed:`, err.message);
        }
      })();

      res.json({
        success: true,
        conversationId,
        messageCount: messages.length,
        fileCount: extractedFiles.length,
        tokenCount: totalTokens,
        entityExtractionQueued: true,
        embeddingQueued: true
      });

    } catch (error) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.error(`\n❌ [Capture FAILED] ${convId} after ${duration}s:`, error);
      console.error('Extension capture error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  // Get capture status for a conversation
  router.get('/api/projects/:projectId/conversations/:conversationId/status', async (req, res) => {
    try {
      const { projectId, conversationId } = req.params;
      
      // Get message counts
      const { data: messages } = await supabase
        .from('cb_messages')
        .select('id', { count: 'exact', head: true })
        .eq('conversation_id', conversationId);
      
      const { data: messageEmbeddings } = await supabase
        .from('cb_message_embeddings')
        .select('message_id', { count: 'exact', head: true })
        .in('message_id', 
          (await supabase.from('cb_messages').select('id').eq('conversation_id', conversationId)).data?.map(m => m.id) || []
        );
      
      // Get file counts
      const { data: files } = await supabase
        .from('cb_files')
        .select('id', { count: 'exact', head: true })
        .eq('conversation_id', conversationId);
      
      const { data: fileEmbeddings } = await supabase
        .from('cb_file_embeddings')
        .select('cb_file_id', { count: 'exact', head: true })
        .eq('conversation_id', conversationId);
      
      // Get block counts
      const { data: blocks } = await supabase
        .from('cb_blocks')
        .select('id', { count: 'exact', head: true })
        .in('message_id',
          (await supabase.from('cb_messages').select('id').eq('conversation_id', conversationId)).data?.map(m => m.id) || []
        );
      
      const messageCount = messages?.length || 0;
      const messageEmbeddedCount = messageEmbeddings?.length || 0;
      const fileCount = files?.length || 0;
      const fileEmbeddedCount = fileEmbeddings?.length || 0;
      const blockCount = blocks?.length || 0;
      
      res.json({
        conversationId,
        captured: messageCount > 0,
        messagesComplete: messageCount > 0 && messageEmbeddedCount >= messageCount * 0.95, // 95% threshold
        filesComplete: fileCount === 0 || fileEmbeddedCount >= fileCount * 0.95,
        embeddingsComplete: messageEmbeddedCount >= messageCount * 0.95 && fileEmbeddedCount >= fileCount * 0.95,
        counts: {
          messages: messageCount,
          messagesEmbedded: messageEmbeddedCount,
          files: fileCount,
          filesEmbedded: fileEmbeddedCount,
          blocks: blockCount
        }
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Reset conversation messages for re-capture
  router.post('/api/projects/:projectId/reset-messages', async (req, res) => {
    try {
      const { projectId } = req.params;
      
      // Reset all conversations for this project
      const { error } = await supabase
        .from('cb_conversations')
        .update({
          message_count: 0,
          raw_messages: null,
          token_count: 0
        })
        .eq('project_id', projectId);
      
      if (error) throw error;
      
      res.json({ success: true, message: 'Messages reset for recapture' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Update conversation with messages
  router.post('/api/conversations/:id/messages', async (req, res) => {
    try {
      const { id } = req.params;
      const { messages, projectId } = req.body;
      
      // Extract files from messages
      const files: any[] = [];
      let codeFileCount = 0;
      let textFileCount = 0;
      
      for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
        const message = messages[msgIndex];
            // Extract code blocks
            if (message.codeBlocks && message.codeBlocks.length > 0) {
              message.codeBlocks.forEach((block: any, blockIndex: number) => {
                const ext = getFileExtension(block.language);
                const fileName = `msg_${msgIndex}_block_${blockIndex}.${ext}`;
                
                files.push({
                  conversation_id: id,
                  project_id: projectId,
                  file_name: fileName,
                  content: block.content,
                  file_type: determineFileType(fileName),
                  file_extension: ext,
                  language: block.language,
                  content_sha: crypto.createHash('sha256').update(block.content).digest('hex'),
                  content_tokens: Math.ceil(block.content.length / 4),
                  importance_score: calculateImportance(fileName, block.content),
                  message_index: msgIndex
                });
                
                if (['js', 'ts', 'py', 'java', 'cpp', 'c', 'cs', 'go', 'rs'].includes(ext)) {
                  codeFileCount++;
                } else {
                  textFileCount++;
                }
              }
            );
        }
        
        // Extract artifacts
        if (message.artifacts && message.artifacts.length > 0) {
          message.artifacts.forEach((artifact: any) => {
            const fileExt = getFileExtensionFromName(artifact.fileName);
            files.push({
              conversation_id: id,
              project_id: projectId,
              file_name: artifact.fileName,
              content: artifact.content,
              file_type: determineFileType(artifact.fileName),
              file_extension: fileExt,
              language: getLanguageFromExtension(fileExt),
              content_sha: crypto.createHash('sha256').update(artifact.content).digest('hex'),
              content_tokens: Math.ceil(artifact.content.length / 4),
              importance_score: calculateImportance(artifact.fileName, artifact.content),
              message_index: msgIndex
            });
            textFileCount++;
          });
        }

        // Extract attachments with extracted_content
        if (message.attachments && Array.isArray(message.attachments)) {
          for (const [attachIndex, attachment] of message.attachments.entries()) {
            if (attachment.extracted_content) {
              const fileName = attachment.file_name || `attachment_${msgIndex}_${attachIndex}`;
              
              // Use robust file type detection
              const detected = await detectFileType(fileName, attachment.extracted_content);

              files.push({
                conversation_id: id,
                project_id: projectId,
                file_name: fileName,
                file_type: detected.file_type,
                file_extension: detected.file_extension,
                language: detected.language,
                content: attachment.extracted_content,
                content_sha: crypto.createHash('sha256').update(attachment.extracted_content).digest('hex'),
                content_tokens: Math.ceil(attachment.extracted_content.length / 4),
                importance_score: calculateImportance(fileName, attachment.extracted_content),
                message_index: msgIndex
              });
              
              // Count by file type (now more accurate!)
              if (detected.file_type === 'code') {
                codeFileCount++;
              } else {
                textFileCount++;
              }
            }
          }
        }
      }
      
      // Save files if any
      if (files.length > 0) {
        const { error: fileError } = await supabase
          .from('cb_files')
          .upsert(files, {
            onConflict: 'conversation_id,content_sha'
          });
        
        if (fileError) {
          console.error('Error inserting files:', fileError);
          // Continue anyway - messages are more important
        } else {
          console.log(`Saved ${files.length} files from message content`);
        }
      }
      
      // Calculate tokens (improved estimation)
      const totalTokens = messages.reduce((sum: number, msg: any) => {
        // Check both 'text' (OpenAI) and 'content' (Claude) fields
        // Claude's content can be an array of { type: 'text', text: '...' } objects
        let textContent = msg.text || '';
        if (!textContent && typeof msg.content === 'string') {
          textContent = msg.content;
        } else if (!textContent && Array.isArray(msg.content)) {
          textContent = msg.content
            .filter((c: any) => c.type === 'text' && c.text)
            .map((c: any) => c.text)
            .join('\n');
        }
        let tokens = Math.ceil((textContent.length || 0) / 4);

        if (msg.attachments) {
          msg.attachments.forEach((attachment: any) => {
            if (attachment.extracted_content) {
              tokens += Math.ceil((attachment.extracted_content?.length || 0) / 4);
            }
          });
        }
        
        if (msg.codeBlocks) {
          msg.codeBlocks.forEach((block: any) => {
            tokens += Math.ceil((block.content?.length || 0) / 4);
          });
        }
        
        if (msg.artifacts) {
          msg.artifacts.forEach((artifact: any) => {
            tokens += Math.ceil((artifact.content?.length || 0) / 4);
          });
        }
        
        return sum + tokens;
      }, 0);
      
      // Update conversation
      const { data, error } = await supabase
        .from('cb_conversations')
        .update({
          raw_messages: messages,
          message_count: messages.length,
          token_count: totalTokens,
          code_files_count: codeFileCount,
          text_files_count: textFileCount,
          captured_at: new Date().toISOString()
        })
        .eq('id', id)
        .select()
        .single();
      
      if (error) throw error;
      
      res.json({ 
        success: true,
        messageCount: messages.length,
        tokenCount: totalTokens,
        filesExtracted: files.length,
        codeFiles: codeFileCount,
        textFiles: textFileCount
      });
      
    } catch (error: any) {
      console.error('Error updating conversation:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Create batch capture job
  router.post('/api/capture/batch', async (req, res) => {
    try {
      const { projectId, projectName, conversations } = req.body;
      
      // Create batch job record
      const batchId = `batch_${Date.now()}_${projectId}`;
      
      // First try to insert the batch record
      const { error } = await supabase
        .from('capture_batches')
        .insert({
          id: batchId,
          project_id: projectId,
          total_conversations: conversations.length,
          conversations_to_process: conversations.filter((c: any) => !c.hasMessages).length,
          status: 'in_progress',
          created_at: new Date().toISOString()
        });
      
      // If table doesn't exist, create it (using try/catch instead of .catch())
      if (error && error.code === '42P01') { 
        try {
          // Note: You might need to create this table manually in Supabase
          // as RPC functions need to be defined in the database first
          console.log('Table capture_batches does not exist. Please create it manually.');
          
          // Alternative: Just continue without the batch tracking table
          // The core functionality will still work
        } catch (rpcError) {
          console.log('Could not create capture_batches table:', rpcError);
        }
      }
      
      res.json({ 
        success: true, 
        batchId: batchId,
        conversationsToProcess: conversations.filter((c: any) => !c.hasMessages).length
      });
      
    } catch (error: any) {
      console.error('Batch creation error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Update batch progress - FIXED increment handling
  router.post('/api/capture/batch/:batchId/progress', async (req, res) => {
    try {
      const { batchId } = req.params;
      const { conversationId, status, processed, total, error } = req.body;
      
      // Log individual conversation status
      if (conversationId) {
        console.log(`Batch ${batchId}: Conversation ${conversationId} - ${status}`);
      }
      
      // Update batch progress if provided
      if (processed !== undefined) {
        // First get current failed_count
        const { data: currentBatch } = await supabase
          .from('capture_batches')
          .select('failed_count')
          .eq('id', batchId)
          .single();
        
        const currentFailedCount = currentBatch?.failed_count || 0;
        const newFailedCount = status === 'failed' ? currentFailedCount + 1 : currentFailedCount;
        
        // Now update with the new values
        await supabase
          .from('capture_batches')
          .update({
            processed_count: processed,
            failed_count: newFailedCount
          })
          .eq('id', batchId);
      }
      
      res.json({ success: true });
      
    } catch (error: any) {
      console.error('Progress update error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Alternative simpler version without batch tracking table
  router.post('/api/capture/batch/simple', async (req, res) => {
    try {
      const { projectId, projectName, conversations } = req.body;
      
      // Simple batch ID without database tracking
      const batchId = `batch_${Date.now()}_${projectId}`;
      
      res.json({ 
        success: true, 
        batchId: batchId,
        conversationsToProcess: conversations.filter((c: any) => !c.hasMessages).length
      });
      
    } catch (error: any) {
      console.error('Batch creation error:', error);
      res.status(500).json({ error: error.message });
    }
  });

// Complete batch
router.post('/api/capture/batch/:batchId/complete', async (req, res) => {
  try {
    const { batchId } = req.params;
    const { totalProcessed, totalConversations, capturedNew } = req.body;
    
    await supabase
      .from('capture_batches')
      .update({
        status: 'completed',
        processed_count: totalProcessed,
        completed_at: new Date().toISOString()
      })
      .eq('id', batchId);
    
    console.log(`Batch ${batchId} completed: ${totalProcessed}/${totalConversations} processed, ${capturedNew} new captures`);
    
    res.json({ 
      success: true,
      summary: {
        totalProcessed,
        totalConversations,
        capturedNew
      }
    });
    
  } catch (error: any) {
    console.error('Batch completion error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Server-side conversation capture (no extension needed)
router.post('/api/capture/conversation', async (req, res) => {
  const { projectId, conversationId, url } = req.body;
  
  try {
    // Check if conversation exists and needs update
    const { data: existing } = await supabase
      .from('cb_conversations')
      .select('id, message_count, cb_messages(created_at)')
      .eq('id', conversationId)
      .single();
    
    // Check if stale (older than 24 hours)
    const lastMessageDate = existing?.cb_messages?.[0]?.created_at;
    const isStale = !lastMessageDate || 
                    new Date(lastMessageDate) < new Date(Date.now() - 24*60*60*1000);
    
    if (existing?.message_count > 0 && !isStale) {
      return res.json({ 
        success: true, 
        conversationId, 
        status: 'already_current',
        message: 'Conversation is already up to date' 
      });
    }
    
    // Mark for capture by external process
    const { error: updateError } = await supabase
      .from('cb_conversations')
      .update({
        needs_capture: true,
        capture_requested_at: new Date().toISOString()
      })
      .eq('id', conversationId);
    
    if (updateError) throw updateError;
    
    res.json({ 
      success: true, 
      conversationId,
      status: 'marked_for_capture',
      message: 'Conversation marked for capture. Open the conversation in Claude to trigger capture.'
    });
    
  } catch (error: any) {
    console.error('Server capture error:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Batch mark for capture
router.post('/api/capture/mark-batch', async (req, res) => {
  const { projectId, conversationIds } = req.body;
  
  try {
    const { error } = await supabase
      .from('cb_conversations')
      .update({
        needs_capture: true,
        capture_requested_at: new Date().toISOString()
      })
      .in('id', conversationIds);
    
    if (error) throw error;
    
    res.json({
      success: true,
      markedCount: conversationIds.length,
      message: `${conversationIds.length} conversations marked for capture`
    });
    
  } catch (error: any) {
    console.error('Batch mark error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get files for a conversation
router.get('/api/conversations/:conversationId/files', async (req, res) => {
  try {
    const { conversationId } = req.params;
    
    const { data, error } = await supabase
      .from('cb_files')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('importance_score', { ascending: false });
    
    if (error) throw error;
    
    res.json(data || []);
  } catch (error: any) {
    console.error('Error fetching files:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get file statistics for a project
router.get('/api/projects/:projectId/files/stats', async (req, res) => {
  try {
    const { projectId } = req.params;
    
    const { data, error } = await supabase
      .from('cb_files')
      .select('file_type')
      .eq('project_id', projectId);
    
    if (error) throw error;
    
    const stats = {
      totalFiles: data?.length || 0,
      codeFiles: data?.filter(f => f.file_type === 'code').length || 0,
      textFiles: data?.filter(f => f.file_type === 'text').length || 0,
      documentFiles: data?.filter(f => f.file_type === 'document').length || 0,
      dataFiles: data?.filter(f => f.file_type === 'data').length || 0
    };
    
    res.json(stats);
  } catch (error: any) {
    console.error('Error fetching file stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get full conversation with messages
router.get('/api/conversations/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;
    
    const { data, error } = await supabase
      .from('cb_conversations')
      .select('*')
      .eq('id', conversationId)
      .single();
    
    if (error) throw error;
    
    res.json(data);
  } catch (error: any) {
    console.error('Error fetching conversation:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single file by ID
router.get('/api/files/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    
    const { data, error } = await supabase
      .from('cb_files')
      .select('*')
      .eq('id', fileId)
      .single();
    
    if (error) throw error;
    
    res.json(data);
  } catch (error: any) {
    console.error('Error fetching file:', error);
    res.status(500).json({ error: error.message });
  }
});

  // Helper functions
  function getFileExtension(language: string): string {
    const extensions: Record<string, string> = {
      'javascript': 'js',
      'typescript': 'ts',
      'python': 'py',
      'java': 'java',
      'cpp': 'cpp',
      'c': 'c',
      'csharp': 'cs',
      'go': 'go',
      'rust': 'rs',
      'html': 'html',
      'css': 'css',
      'json': 'json',
      'yaml': 'yml',
      'bash': 'sh',
      'sql': 'sql',
      'markdown': 'md'
    };
    
    return extensions[language] || 'txt';
  }

  function getFileExtensionFromName(fileName: string): string {
    const parts = fileName.split('.');
    return parts.length > 1 ? parts[parts.length - 1] : 'txt';
  }

  function determineFileType(fileName: string): string {
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    
    const codeExtensions = ['js', 'ts', 'py', 'java', 'cpp', 'c', 'cs', 'go', 'rs', 'swift'];
    const docExtensions = ['md', 'txt', 'pdf', 'docx', 'doc'];
    const dataExtensions = ['json', 'xml', 'csv', 'yaml', 'yml'];
    
    if (codeExtensions.includes(ext)) return 'code';
    if (docExtensions.includes(ext)) return 'document';
    if (dataExtensions.includes(ext)) return 'data';
    
    return 'text';
  }

  function getLanguageFromExtension(ext: string): string {
    const languageMap: Record<string, string> = {
      'js': 'javascript',
      'ts': 'typescript',
      'py': 'python',
      'bat': 'batch',
      'java': 'java',
      'cpp': 'cpp',
      'c': 'c', 
      'cs': 'csharp',
      'go': 'go',
      'rs': 'rust',
      'html': 'html',
      'css': 'css',
      'json': 'json',
      'yml': 'yaml',
      'yaml': 'yaml',
      'sh': 'bash'
    };
    
    return languageMap[ext] || ext;
  }

  function calculateImportance(fileName: string, content: string): number {
    let score = 0.5;
    
    if (fileName.includes('main') || fileName.includes('index')) score += 0.2;
    if (fileName.includes('config') || fileName.includes('package.json')) score += 0.15;
    if (content.length > 1000) score += 0.1;
    
    return Math.min(score, 1.0);
  }

  function extractMessageContent(msg: any): string {
    if (typeof msg.text === 'string' && msg.text) {
      return msg.text;
    }
    
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n\n');
    }
    
    return '';
  }

  // Get single message with context
  router.get('/api/messages/:messageId', async (req, res) => {
    try {
      const { messageId } = req.params;
      
      // Fetch the message with conversation info
      const { data: message, error } = await supabase
        .from('cb_messages')
        .select(`
          id,
          content,
          role,
          created_at,
          index_in_thread,
          conversation_id,
          cb_conversations (
            id,
            summary,
            project_id,
            url
          )
        `)
        .eq('id', messageId)
        .single();
      
      if (error) throw error;
      
      if (!message) {
        return res.status(404).json({ error: 'Message not found' });
      }
      
      res.json(message);
    } catch (error: any) {
      console.error('Error fetching message:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get latest version of a file by name
  router.get('/api/projects/:projectId/files/latest/:fileName', async (req, res) => {
    try {
      const { projectId, fileName } = req.params;
      
      // Extract just the filename (basename) from the full path
      // e.g., "packages/extension/src/background.js" -> "background.js"
      const basename = fileName.split('/').pop() || fileName;
      
      console.log('[latest-file] Searching for:', fileName, '-> basename:', basename, 'in project:', projectId);
      
      // Fetch the most recent version of this file using basename
      const { data: files, error: fileError } = await supabase
        .from('cb_files')
        .select('*')
        .eq('project_id', projectId)
        .ilike('file_name', `%${basename}%`)
        .order('created_at', { ascending: false })
        .limit(10);
      
      if (fileError) throw fileError;
      
      if (!files || files.length === 0) {
        console.log('[latest-file] No files found for basename:', basename);
        return res.status(404).json({ error: 'File not found' });
      }
      
      console.log(`[latest-file] Found ${files.length} versions of ${basename}`);
      
      // Get the most recent file
      const latestFile = files[0];
      
      // Now fetch the conversation details
      const { data: conversation, error: convError } = await supabase
        .from('cb_conversations')
        .select('id, summary, created_at, url')
        .eq('id', latestFile.conversation_id)
        .single();
      
      if (convError) {
        console.warn('[latest-file] Could not fetch conversation:', convError);
      }
      
      // Combine the data
      const result = {
        ...latestFile,
        cb_conversations: conversation
      };
      
      console.log('[latest-file] Returning file:', latestFile.file_name, 'from conversation:', conversation?.summary);
      
      res.json(result);
      
    } catch (error: any) {
      console.error('Error fetching file:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Search messages across conversations
  router.get('/api/projects/:projectId/messages/search', async (req, res) => {
    try {
      const { projectId } = req.params;
      const { q, limit = 20, offset = 0 } = req.query;
      
      if (!q || (q as string).trim().length === 0) {
        return res.status(400).json({ error: 'Query parameter "q" is required' });
      }
      
      const query = (q as string).trim();
      const searchLimit = Math.min(Number(limit), 100);
      const searchOffset = Number(offset);
      
      console.log('[message-search] Query:', query, 'Limit:', searchLimit, 'Offset:', searchOffset);
      
      // Search messages with conversation context
      const { data: messages, error } = await supabase
        .from('cb_messages')
        .select(`
          id,
          content,
          role,
          created_at,
          index_in_thread,
          conversation_id,
          cb_conversations!inner(
            id,
            summary,
            url,
            created_at
          )
        `)
        .eq('project_id', projectId)
        .ilike('content', `%${query}%`)
        .order('created_at', { ascending: false })
        .range(searchOffset, searchOffset + searchLimit - 1);
      
      if (error) throw error;
      
      // Get total count for pagination
      const { count } = await supabase
        .from('cb_messages')
        .select('*', { count: 'exact', head: true })
        .eq('project_id', projectId)
        .ilike('content', `%${query}%`);
      
      console.log(`[message-search] Found ${messages?.length || 0} messages (${count} total)`);
      
      res.json({
        query,
        results: messages || [],
        total: count || 0,
        limit: searchLimit,
        offset: searchOffset
      });
      
    } catch (error: any) {
      console.error('Message search error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}