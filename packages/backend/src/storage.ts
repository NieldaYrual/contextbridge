import fs from 'fs-extra';
import path from 'path';

const CAPTURES_DIR = path.join(process.cwd(), 'captures');

export async function saveConversation(projectId: string, conversationId: string, data: any) {
  const projectDir = path.join(process.cwd(), 'captures', projectId);
  console.log(`   📂 Creating directory: ${projectDir}`);
  await fs.ensureDir(projectDir);
  
  const filePath = path.join(projectDir, `${conversationId}.json`);
  console.log(`   💾 Writing file: ${filePath}`);
  await fs.writeJson(filePath, data, { spaces: 2 });
  
  console.log(`   ✅ File saved: ${filePath}`);
  return filePath;
}

export async function getProjectSummary(projectId: string) {
  const projectDir = path.join(CAPTURES_DIR, projectId);
  if (!await fs.pathExists(projectDir)) return null;
  
  const files = await fs.readdir(projectDir);
  let totalMessages = 0;
  let totalTokens = 0;
  
  for (const file of files) {
    if (file.endsWith('.json')) {
      const data = await fs.readJson(path.join(projectDir, file));
      totalMessages += data.chat_messages?.length || 0;
      totalTokens += data.token_count || 0;
    }
  }
  
  return { conversations: files.length, totalMessages, totalTokens };
}