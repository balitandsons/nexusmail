import { Router } from 'express';
import { clampInt } from '../util.js';
import { db, recips } from '../store.js';
import { h } from './api.js';
import { computeStats } from '../engine/stats.js';

const router = Router();
router.get('/stats', h((req, res) => res.json(computeStats(db.accounts, db.campaigns, recips, clampInt(req.query.days, 3, 90, 14)))));

/** One row per recipient across all campaigns, for spreadsheets. */
router.get('/stats/export.csv', h((_req, res) => {
  const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['campaign', 'email', 'status', 'mailbox', 'sent_at', 'bounced_at', 'replied_at', 'unsubscribed_at', 'error'].join(',')];
  for (const c of db.campaigns) for (const r of recips(c.id)) lines.push([c.name, r.email, r.status, r.acc, r.at, r.bouncedAt, r.repliedAt, r.unsubAt, r.error].map(q).join(','));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="nexusmail-stats.csv"');
  res.send('﻿' + lines.join('\n'));
}));
export default router;
