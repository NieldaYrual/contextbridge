import { config } from 'dotenv';
config();

import { runScheduler } from './runner/scheduler.js';

// Modes:
//   1) default: run scheduler once
//   2) --watch: run every N minutes
const WATCH = process.argv.includes('--watch');
const EVERY = Number(process.env.CAPTURE_INTERVAL_MINUTES || '30');

async function mainOnce(){
  await runScheduler(1);
}

async function mainWatch(){
  await mainOnce();
  setInterval(mainOnce, EVERY * 60 * 1000);
}

console.log('Starting capture scheduler...');
(WATCH ? mainWatch() : mainOnce())
  .catch(err => { console.error(err); process.exit(1); });
