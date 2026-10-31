const express = require('express');
const { load, save, log } = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(auth);

function risk(item) {
  const daysLeft = item.dailyUsage > 0 ? item.stock / item.dailyUsage : 999;
  if (daysLeft < item.leadTimeDays) return 'STOCKOUT';
  if (daysLeft < item.leadTimeDays * 1.5) return 'WATCH';
  return 'OK';
}

router.get('/', requireRole('admin', 'staff'), (req, res) => {
  const db = load();
  res.json(
    db.inventory.map((i) => ({ ...i, forecastDays: Math.round(i.stock / i.dailyUsage), risk: risk(i) }))
  );
});

router.patch('/:id', requireRole('staff', 'admin'), (req, res) => {
  const db = load();
  const item = db.inventory.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  Object.assign(item, req.body);
  log(db, `${req.user.name} updated inventory: ${item.name}`);
  save(db);
  res.json(item);
});

// Staff (and admin) can add a brand-new stock line item.
router.post('/', requireRole('staff', 'admin'), (req, res) => {
  const db = load();
  const { name, stock, dailyUsage, leadTimeDays, criticality } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Item name is required' });

  const item = {
    id: 'INV-' + Date.now(),
    name: String(name).trim(),
    stock: Number(stock) || 0,
    dailyUsage: Number(dailyUsage) || 1,
    leadTimeDays: Number(leadTimeDays) || 3,
    criticality: ['LOW', 'MEDIUM', 'HIGH'].includes(criticality) ? criticality : 'MEDIUM',
  };
  db.inventory.push(item);
  log(db, `${req.user.name} added inventory item: ${item.name}`);
  save(db);
  res.json({ ...item, forecastDays: Math.round(item.stock / item.dailyUsage), risk: risk(item) });
});

// Staff (and admin) can remove a discontinued or duplicate line item.
router.delete('/:id', requireRole('staff', 'admin'), (req, res) => {
  const db = load();
  const item = db.inventory.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  db.inventory = db.inventory.filter((i) => i.id !== req.params.id);
  log(db, `${req.user.name} removed inventory item: ${item.name}`);
  save(db);
  res.json({ ok: true });
});

module.exports = router;
