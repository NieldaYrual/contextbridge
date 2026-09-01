export interface ExtractedSnippet {
  snippet: string;
  fullText: string;
  matchPositions: number[];
  sentenceCount: number;
}

export function extractContextSnippet(
  text: string,
  keywords: string[],
  options: { contextSentences?: number; maxSnippetLength?: number } = {}
): ExtractedSnippet {
  const { contextSentences = 2, maxSnippetLength = 300 } = options;

  if (!text || !keywords.length) {
    return { snippet: text.slice(0, maxSnippetLength), fullText: text, matchPositions: [], sentenceCount: 0 };
  }

  // Simple sentence split
  const sentences = text.split(/[.!?]+\s+/).filter(s => s.trim().length > 0);
  
  if (sentences.length === 0) {
    return { snippet: text.slice(0, maxSnippetLength), fullText: text, matchPositions: [], sentenceCount: 0 };
  }

  // Find first match
  const lowerText = text.toLowerCase();
  let firstMatchPos = -1;
  
  for (const keyword of keywords) {
    const pos = lowerText.indexOf(keyword.toLowerCase());
    if (pos !== -1 && (firstMatchPos === -1 || pos < firstMatchPos)) {
      firstMatchPos = pos;
    }
  }

  if (firstMatchPos === -1) {
    return { snippet: text.slice(0, maxSnippetLength), fullText: text, matchPositions: [], sentenceCount: 0 };
  }

  // Find sentence with match
  let charCount = 0;
  let matchSentenceIndex = 0;
  
  for (let i = 0; i < sentences.length; i++) {
    charCount += sentences[i].length + 2;
    if (firstMatchPos < charCount) {
      matchSentenceIndex = i;
      break;
    }
  }

  // Extract context
  const start = Math.max(0, matchSentenceIndex - contextSentences);
  const end = Math.min(sentences.length, matchSentenceIndex + contextSentences + 1);
  
  let snippet = sentences.slice(start, end).join('. ');
  if (start > 0) snippet = '...' + snippet;
  if (end < sentences.length) snippet = snippet + '...';
  
  if (snippet.length > maxSnippetLength) {
    snippet = snippet.slice(0, maxSnippetLength) + '...';
  }

  return { snippet, fullText: text, matchPositions: [firstMatchPos], sentenceCount: end - start };
}

export function shouldUseFullText(
  text: string,
  score: number,
  options: { maxWords?: number; highScoreThreshold?: number } = {}
): boolean {
  const { maxWords = 250, highScoreThreshold = 0.80 } = options;
  const wordCount = text.split(/\s+/).length;
  return wordCount <= maxWords || score >= highScoreThreshold;
}