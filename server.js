const express = require('express');
const { createClient } = require('@libsql/client');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// ── TURSO (same DB as NEXUS — read only for journal) ─────────────
const db = createClient({
  url:       process.env.TURSO_DATABASE_URL || '',
  authToken: process.env.TURSO_AUTH_TOKEN   || '',
});

const PASSWORD  = process.env.NEXOTRADOV_PASSWORD || 'nexotradov123';
const SESSIONS  = new Set();

app.use(express.json());
const PUBLIC = process.cwd();
app.use(express.static(PUBLIC));

// ── AUTH MIDDLEWARE ────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.path === '/api/auth' || req.path === '/api/auth/verify') return next();
  if (!req.path.startsWith('/api')) return next();
  const token = req.headers['x-journal-token'];
  if (token && SESSIONS.has(token)) return next();
  return res.status(401).json({ ok: false, error: 'Unauthorized' });
}
app.use(requireAuth);

// ── AUTH ──────────────────────────────────────────────────────────
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password !== PASSWORD) return res.status(401).json({ ok: false, error: 'Wrong password' });
  const token = crypto.randomBytes(32).toString('hex');
  SESSIONS.add(token);
  setTimeout(() => SESSIONS.delete(token), 24 * 60 * 60 * 1000);
  res.json({ ok: true, token });
});

app.get('/api/auth/verify', (req, res) => {
  const token = req.headers['x-journal-token'];
  if (token && SESSIONS.has(token)) return res.json({ ok: true });
  res.json({ ok: false });
});

// ── TRADES — read from NEXUS active_trades table ──────────────────
app.get('/api/trades', async (req, res) => {
  if (!process.env.TURSO_DATABASE_URL) return res.json({ ok: true, trades: [] });
  try {
    const rows = await db.execute({
      sql: `SELECT * FROM active_trades ORDER BY opened_at DESC LIMIT 500`,
      args: []
    });
    res.json({ ok: true, trades: rows.rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── CLOSED TRADES ─────────────────────────────────────────────────
app.get('/api/trades/closed', async (req, res) => {
  if (!process.env.TURSO_DATABASE_URL) return res.json({ ok: true, trades: [] });
  try {
    const rows = await db.execute({
      sql: `SELECT * FROM active_trades WHERE status='CLOSED' ORDER BY closed_at DESC LIMIT 500`,
      args: []
    });
    res.json({ ok: true, trades: rows.rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── OPEN TRADES ───────────────────────────────────────────────────
app.get('/api/trades/open', async (req, res) => {
  if (!process.env.TURSO_DATABASE_URL) return res.json({ ok: true, trades: [] });
  try {
    const rows = await db.execute({
      sql: `SELECT * FROM active_trades WHERE status='OPEN' ORDER BY opened_at DESC`,
      args: []
    });
    res.json({ ok: true, trades: rows.rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── STATS — summary for dashboard ─────────────────────────────────
app.get('/api/stats', async (req, res) => {
  if (!process.env.TURSO_DATABASE_URL) return res.json({ ok: true, stats: {} });
  try {
    const closed = await db.execute({
      sql: `SELECT * FROM active_trades WHERE status='CLOSED' AND pnl_pct IS NOT NULL ORDER BY closed_at ASC`,
      args: []
    });
    const open = await db.execute({
      sql: `SELECT COUNT(*) as cnt FROM active_trades WHERE status='OPEN'`,
      args: []
    });
    const trades = closed.rows;
    // Only count trades with valid pnl_pct — exclude NULL/zero pnl (manual closes without price)
    const validTrades = trades.filter(t => t.pnl_pct !== null && t.pnl_pct !== undefined);
    const totalTrades = validTrades.length;
    const wins = validTrades.filter(t => t.pnl_pct > 0).length;
    const losses = validTrades.filter(t => t.pnl_pct < 0).length;
    const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0;
    const totalPnl = trades.reduce((s, t) => s + (t.pnl_pct || 0) * (t.size_usdt || 0) / 100, 0);
    const avgWin = wins > 0
      ? validTrades.filter(t => t.pnl_pct > 0).reduce((s, t) => s + t.pnl_pct * (t.size_usdt || 0) / 100, 0) / wins
      : 0;
    const avgLoss = losses > 0
      ? Math.abs(validTrades.filter(t => t.pnl_pct < 0).reduce((s, t) => s + t.pnl_pct * (t.size_usdt || 0) / 100, 0) / losses)
      : 0;
    const rr = avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : avgWin > 0 ? '∞' : 0;

    // Max drawdown
    let equity = 0, peak = 0, maxDD = 0;
    trades.forEach(t => {
      equity += (t.pnl_pct || 0) * (t.size_usdt || 0) / 100;
      if (equity > peak) peak = equity;
      const dd = peak - equity;
      if (dd > maxDD) maxDD = dd;
    });

    // Best/worst coin
    const coinMap = {};
    trades.forEach(t => {
      if (!coinMap[t.symbol]) coinMap[t.symbol] = { pnl: 0, wins: 0, total: 0 };
      coinMap[t.symbol].pnl += (t.pnl_pct || 0) * (t.size_usdt || 0) / 100;
      coinMap[t.symbol].total++;
      if ((t.pnl_pct || 0) > 0) coinMap[t.symbol].wins++;
    });
    const coinList = Object.entries(coinMap).sort((a, b) => b[1].pnl - a[1].pnl);
    const bestCoin = coinList[0] ? { symbol: coinList[0][0], ...coinList[0][1] } : null;
    const worstCoin = coinList[coinList.length - 1] ? { symbol: coinList[coinList.length - 1][0], ...coinList[coinList.length - 1][1] } : null;

    // Close reason breakdown
    const reasonMap = {};
    trades.forEach(t => {
      const r = t.close_reason || 'UNKNOWN';
      reasonMap[r] = (reasonMap[r] || 0) + 1;
    });

    res.json({
      ok: true,
      stats: {
        totalTrades, wins, losses, winRate,
        totalPnl: totalPnl.toFixed(2),
        avgWin: avgWin.toFixed(2),
        avgLoss: avgLoss.toFixed(2),
        rr, maxDD: maxDD.toFixed(2),
        openTrades: open.rows[0]?.cnt || 0,
        bestCoin, worstCoin,
        reasonBreakdown: reasonMap
      },
      equityCurve: trades.map((t, i) => ({
        label: t.symbol + ' #' + (i + 1),
        pnl: (t.pnl_pct || 0) * (t.size_usdt || 0) / 100,
        date: t.closed_at
      }))
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── HEALTH ────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

// ── KEEP ALIVE ────────────────────────────────────────────────────
const SELF = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
setInterval(() => {
  const http = require('http');
  const https = require('https');
  const url = new URL(`${SELF}/health`);
  const client = url.protocol === 'https:' ? https : http;
  client.get(url.toString(), () => {}).on('error', () => {});
}, 14 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`NexoTradoV running on port ${PORT}`);
});
