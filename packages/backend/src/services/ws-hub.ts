// packages/backend/src/services/ws-hub.ts
import http from 'http';
import path from 'path';
import * as fs from 'fs/promises';
import { WebSocketServer, WebSocket } from 'ws';
import { encoding_for_model } from 'tiktoken';

// If you already export a named storage API:
import { saveConversation } from '../storage.js';

// Keep one tokenizer for the process
const enc = encoding_for_model('gpt-4o-mini'); // choose the tokenizer you prefer

type RoomId = string;
type Role = 'extension' | 'driver' | 'dashboard' | 'backend' | string;

interface ExtWebSocket extends WebSocket {
  projectId?: RoomId;
  role?: Role;
}

const rooms = new Map<RoomId, Set<ExtWebSocket>>(); // projectId -> sockets

function joinRoom(ws: ExtWebSocket, projectId: RoomId) {
  if (!rooms.has(projectId)) rooms.set(projectId, new Set());
  rooms.get(projectId)!.add(ws);
  ws.projectId = projectId;
}

function leaveRoom(ws: ExtWebSocket) {
  const pid = ws.projectId;
  if (!pid) return;
  const set = rooms.get(pid);
  if (set) {
    set.delete(ws);
    if (set.size === 0) rooms.delete(pid);
  }
}

function broadcast(projectId: RoomId, payload: any, except?: ExtWebSocket) {
  const set = rooms.get(projectId);
  if (!set) return;
  const msg = JSON.stringify(payload);
  for (const peer of set) {
    if (peer !== except && peer.readyState === WebSocket.OPEN) {
      try { peer.send(msg); } catch {}
    }
  }
}

// ——— Capture helpers ————————————————————————————————————————

function extractMessages(payload: any): Array<{ role: string; text: string }> {
  try {
    // Common Claude-ish shapes we've seen
    if (Array.isArray(payload?.chat_messages)) {
      return payload.chat_messages.map((m: any) => ({
        role: m.role ?? 'unknown',
        text: String(m.content ?? m.text ?? '')  // Ensure it's a string
      }));
    }
    if (Array.isArray(payload?.messages)) {
      return payload.messages.map((m: any) => ({
        role: m.role ?? 'unknown',
        text: String(m.content ?? m.text ?? '')  // Ensure it's a string
      }));
    }
    if (payload?.conversation?.messages) {
      return payload.conversation.messages.map((m: any) => ({
        role: m.role ?? 'unknown',
        text: String(m.content ?? m.text ?? '')  // Ensure it's a string
      }));
    }
    // WS deltas / streamed events
    if (payload?.delta || payload?.text) {
      return [{ role: payload.role || 'assistant', text: String(payload.delta ?? payload.text ?? '') }];
    }
  } catch {}
  return [];
}

function findConversationIdInUrl(u?: string): string | null {
  if (!u) return null;
  
  // Try to extract conversation ID from different URL patterns
  // Pattern 1: /chat_conversations/[id]
  const chatMatch = u.match(/\/chat_conversations\/([a-f0-9-]{36})/i);
  if (chatMatch) return chatMatch[1];
  
  // Pattern 2: Generic UUID anywhere in URL
  const uuidMatch = u.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  if (uuidMatch) {
    // Skip if this is the org ID (appears early in URL)
    if (!u.includes(`organizations/${uuidMatch[1]}`)) {
      return uuidMatch[1];
    }
    // Look for a second UUID (likely the conversation ID)
    const remaining = u.substring(u.indexOf(uuidMatch[1]) + uuidMatch[1].length);
    const secondMatch = remaining.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
    if (secondMatch) return secondMatch[1];
  }
  
  // Pattern 3: /conversations/[id]
  const convMatch = u.match(/\/conversations\/([A-Za-z0-9_-]+)/);
  if (convMatch) return convMatch[1];
  
  return null;
}

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

async function saveCapture(
  projectId: string,
  conversationId: string,
  payload: any
) {
  // Use your real storage helper
  if (typeof saveConversation === 'function') {
    const savedPath = await saveConversation(projectId, conversationId, payload);
    console.log(`   📁 File saved to: ${savedPath}`);
    return savedPath;
  }

  // Safe local fallback
  const dir = path.join(process.cwd(), 'captures', projectId);
  await ensureDir(dir);
  const fp = path.join(dir, `${conversationId}.json`);
  await fs.writeFile(fp, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`   📁 File saved to: ${fp}`);
  return fp;
}

async function handleApiHit(ws: ExtWebSocket, msg: any) {
  const projectId: string = msg.projectId || ws.projectId || 'default-project';
  const url: string = msg.url || '';
  const body: any = msg.body || {};

  const messages = extractMessages(body);
  
  // Fix: Ensure text is a string before encoding
  const tokenCount = messages.reduce((sum, m) => {
    const textStr = String(m.text || '');
    if (textStr) {
      try {
        return sum + enc.encode(textStr).length;
      } catch (e) {
        console.error('Token encoding error:', e);
        return sum;
      }
    }
    return sum;
  }, 0);

  // Better conversation ID extraction
  let conversationId = findConversationIdInUrl(url);
  
  // If not found in URL, try the body
  if (!conversationId) {
    conversationId = body?.uuid || 
                    body?.conversation?.uuid || 
                    body?.conversation?.id ||
                    body?.id;
  }
  
  // If still not found, generate one from timestamp
  if (!conversationId) {
    conversationId = `conversation-${Date.now()}`;
  }

  const payloadToSave = {
    url,
    dataType: msg.dataType || 'unknown',
    contentType: msg.contentType || '',
    messages,
    tokens: tokenCount,
    // Include the full body for debugging
    fullBody: body,
    // Keep raw only if we couldn't normalize any messages
    raw: messages.length ? undefined : body
  };

  await saveCapture(projectId, conversationId, payloadToSave);

  // Let the room know we saved something
  broadcast(projectId, {
    t: 'capture_saved',
    projectId,
    conversationId,
    messages: messages.length,
    tokens: tokenCount
  });

  console.log(
    `[ws-hub] Saved ${messages.length} msgs (${tokenCount} tokens) for ${conversationId} [${projectId}]`
  );
}

// ——— Public factory ————————————————————————————————————————————

export function createWsHub(server: http.Server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: ExtWebSocket) => {
    ws.on('message', async (raw: Buffer) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Handle joins / keepalives
      if (msg.t === 'join') {
        const projectId: RoomId = msg.projectId || 'default-project';
        const role: Role = msg.role || 'unknown';
        ws.role = role;
        joinRoom(ws, projectId);
        // Ack to just-joined client
        try {
          ws.send(JSON.stringify({ t: 'joined', projectId, role }));
        } catch {}
        // Notify others in the room
        broadcast(projectId, { t: 'peer_joined', role }, ws);
        return;
      }

      if (msg.t === 'ping') {
        try { ws.send(JSON.stringify({ t: 'pong' })); } catch {}
        return;
      }

      // Main capture path from extension/content
      if (msg.t === 'api_hit') {
        try {
          await handleApiHit(ws, msg);
        } catch (e) {
          console.error('[ws-hub] api_hit error', e);
        }
        return;
      }

      // You can forward other message types as needed
      if (msg.t === 'broadcast' && ws.projectId) {
        broadcast(ws.projectId, msg);
        return;
      }
    });

    ws.on('close', () => {
      leaveRoom(ws);
    });

    ws.on('error', () => {
      leaveRoom(ws);
    });
  });

  console.log('[ws-hub] WebSocket hub ready at /ws');
  return wss;
}