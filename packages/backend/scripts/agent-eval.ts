/* eslint-disable no-console */
import fetch from 'node-fetch';

const API = process.env.API_BASE || 'http://localhost:3001';
const PROJECT_ID = process.env.PROJECT_ID || '0198a07b-7fa1-75e2-8834-ca8a703c3469';

type Case = {
  q: string;
  mustContain: string[];  // any of these paths in top locations counts as a hit
};

const CASES: Case[] = [
  {
    q: 'Where is the dashboard/extension code that renders the Context Pack?',
    mustContain: ['packages/chrome-extension/content-simple.js']
  },
  {
    q: 'Explain how Cytoscape is used in knowledge-graph.routes.ts',
    mustContain: ['knowledge-graph.routes.ts']
  },
  {
    q: 'Where is the capture endpoint defined?',
    mustContain: ['extension-capture.routes.ts']
  }
  // Add more as you wish
];

function rr(rank: number) { return rank > 0 ? 1 / rank : 0; }

async function runOne(c: Case) {
  const res = await fetch(`${API}/api/agent/context-pack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruction: c.q, projectId: PROJECT_ID, tokenBudget: 12000 })
  });
  const data = await res.json();
  const sq = data?.pack?.subquestions?.[0];
  const locations: { path: string }[] = sq?.locations || [];

  // Hit@1 and MRR
  let hit1 = 0;
  let mrr = 0;
  let foundRank = 0;

  for (let i = 0; i < locations.length; i++) {
    const p = String(locations[i].path || '');
    if (c.mustContain.some(needle => p.endsWith(needle) || p.includes(needle))) {
      foundRank = i + 1;
      break;
    }
  }
  if (foundRank === 1) hit1 = 1;
  if (foundRank > 0) mrr = rr(foundRank);

  const outTokens = data?.pack?.budget?.outputTokens || 0;
  const compacted = !!data?.pack?.budget?.compacted;
  const size = outTokens.toString().padStart(6, ' ');

  return { q: c.q, hit1, mrr, rank: foundRank, size, compacted, first: locations[0]?.path || '-' };
}

(async () => {
  const results = await Promise.all(CASES.map(runOne));
  const agg = results.reduce((a, r) => {
    a.h += r.hit1; a.m += r.mrr;
    return a;
  }, { h: 0, m: 0 });
  console.log('\nAgent Eval Results');
  console.log('='.repeat(60));
  console.table(results.map(r => ({
    Hit1: r.hit1, MRR: r.mrr.toFixed(3), Rank: r.rank || '-', Size: r.size, Comp: r.compacted ? 'Y':'N', First: r.first
  })));
  console.log('='.repeat(60));
  console.log(`Hit@1: ${(agg.h / results.length).toFixed(3)}   MRR: ${(agg.m / results.length).toFixed(3)}\n`);
})();
