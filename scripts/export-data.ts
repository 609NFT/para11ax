/**
 * Export data to CSV for analysis
 * Run with: npx ts-node scripts/export-data.ts
 */

import { getDatabase } from '../src/db';
import * as path from 'path';

const db = getDatabase();

const outputDir = path.join(process.cwd(), 'data', 'exports');
db.exportAllToCSV(outputDir);

console.log(`Data exported to ${outputDir}`);

db.close();
