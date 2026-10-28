const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'data', 'farms.json');
const CONFIG_FILE = path.join(__dirname, 'data', 'app_config.json');

// Default App Config
const DEFAULT_CONFIG = {
  appName: "LGU Libona Farm Geotagger",
  currentVersion: "2.1.0",
  cropTypes: [
    { name: "Corn", label: "Corn (Mais)", fill: "#A5D6A7", stroke: "#2E7D32" },
    { name: "Cassava", label: "Cassava (Balanghoy)", fill: "#D7CCC8", stroke: "#6D4C41" },
    { name: "Rice", label: "Rice (Humay)", fill: "#FFF59D", stroke: "#FBC02D" },
    { name: "Vegetables", label: "Vegetables (Utanon)", fill: "#80CBC4", stroke: "#00695C" },
    { name: "Fruit Trees", label: "Fruit Trees (Prutas)", fill: "#FFCC80", stroke: "#EF6C00" },
    { name: "Others", label: "Others", fill: "#E1BEE7", stroke: "#7B1FA2" }
  ],
  barangays: [
    "Capihan", "Crossing", "Gango", "Kiliog", "Kinawe", "Laturan",
    "Maambong", "Nangka", "Palabucan", "Poblacion", "Pongol",
    "San Jose", "Santa Fe", "Sil-ipon"
  ],
  adminPin: "1234"
};

// Ensure data files exist
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify([]), 'utf8');
}
if (!fs.existsSync(CONFIG_FILE)) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
}

// Helpers
function getFarms() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveFarms(farms) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(farms, null, 2), 'utf8');
}

function getConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    return DEFAULT_CONFIG;
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

// -------------------------------------------------------------
// API ENDPOINTS
// -------------------------------------------------------------

// 1. Get All Farms (Consolidated)
app.get('/api/farms', (req, res) => {
  const { barangay, crop } = req.query;
  let list = getFarms();
  if (barangay && barangay !== 'ALL') {
    list = list.filter(f => (f.barangay || '').toLowerCase() === barangay.toLowerCase());
  }
  if (crop && crop !== 'ALL') {
    list = list.filter(f => (f.cropType || 'Others') === crop);
  }
  res.json({ success: true, count: list.length, data: list });
});

// 2. Submit new farm from Field Android App
app.post('/api/farms', (req, res) => {
  const farm = req.body;
  if (!farm || !farm.farmerName || !farm.barangay) {
    return res.status(400).json({ success: false, message: 'Missing required farm details' });
  }

  const farms = getFarms();
  const newEntry = {
    ...farm,
    id: farm.id || Date.now().toString(),
    syncedAt: new Date().toISOString(),
    source: farm.source || 'Android Field App'
  };

  // Prevent duplicates if re-synced by ID
  const existingIdx = farms.findIndex(f => f.id === newEntry.id);
  if (existingIdx >= 0) {
    farms[existingIdx] = newEntry;
  } else {
    farms.push(newEntry);
  }

  saveFarms(farms);
  console.log(`[SYNC INTAKE] New farm from Brgy. ${newEntry.barangay}: ${newEntry.farmerName}`);
  res.json({ success: true, farm: newEntry });
});

// 3. Batch Sync from Field App (for offline queue uploads)
app.post('/api/farms/batch-sync', (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) {
    return res.status(400).json({ success: false, message: 'Items array required' });
  }

  const farms = getFarms();
  let addedCount = 0;

  items.forEach(farm => {
    const entry = {
      ...farm,
      id: farm.id || Date.now().toString() + Math.random().toString().slice(2, 6),
      syncedAt: new Date().toISOString()
    };
    const idx = farms.findIndex(f => f.id === entry.id);
    if (idx >= 0) {
      farms[idx] = entry;
    } else {
      farms.push(entry);
      addedCount++;
    }
  });

  saveFarms(farms);
  console.log(`[BATCH SYNC] Synced ${items.length} farms. Added new: ${addedCount}`);
  res.json({ success: true, total: farms.length, syncedCount: items.length });
});

// 4. Update Farm details (from Admin Master Updater)
app.put('/api/farms/:id', (req, res) => {
  const { id } = req.params;
  const updates = req.body;
  const farms = getFarms();
  const idx = farms.findIndex(f => f.id === id);

  if (idx === -1) {
    return res.status(404).json({ success: false, message: 'Farm not found' });
  }

  farms[idx] = { ...farms[idx], ...updates, updatedAt: new Date().toISOString() };
  saveFarms(farms);
  res.json({ success: true, farm: farms[idx] });
});

// 5. Delete Farm (from Admin Master Updater)
app.delete('/api/farms/:id', (req, res) => {
  const { id } = req.params;
  let farms = getFarms();
  const beforeCount = farms.length;
  farms = farms.filter(f => f.id !== id);
  saveFarms(farms);
  res.json({ success: true, deleted: beforeCount !== farms.length });
});

// 6. Config API (Version Control, Barangay locking, Crop Settings)
app.get('/api/config', (req, res) => {
  res.json(getConfig());
});

app.post('/api/config', (req, res) => {
  const newConfig = req.body;
  saveConfig(newConfig);
  console.log('[CONFIG UPDATE] System configuration updated.');
  res.json({ success: true, config: newConfig });
});

// 7. Overall System Statistics API
app.get('/api/stats', (req, res) => {
  const farms = getFarms();
  const stats = {
    totalFarms: farms.length,
    totalAreaHa: (farms.reduce((acc, f) => acc + (f.area || 0), 0) / 10000).toFixed(2),
    byBarangay: {},
    byCrop: {}
  };

  farms.forEach(f => {
    const b = f.barangay || 'Unknown';
    const c = f.cropType || 'Others';
    stats.byBarangay[b] = (stats.byBarangay[b] || 0) + 1;
    stats.byCrop[c] = (stats.byCrop[c] || 0) + 1;
  });

  res.json(stats);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`🌾 LGU Libona Geotagger Central Server is RUNNING`);
  console.log(`📡 Port: ${PORT}`);
  console.log(`🏢 Office Live Screen: http://localhost:${PORT}`);
  console.log(`🛠️ Master Admin & Updater: http://localhost:${PORT}/admin.html`);
  console.log(`=======================================================`);
});
