const express = require('express');
const config = require('../core/config');
const logger = require('../core/logger');

const authRoutes = require('./routes/auth');
const platformRoutes = require('./routes/platform');
const schemaRoutes = require('./routes/schema');
const syncRoutes = require('./routes/sync');
const workspaceRoutes = require('./routes/workspace');
const syncConfigsRoutes = require('./routes/sync-configs');
const settingsRoutes = require('./routes/settings');
const { maintenanceMode } = require('./middleware/maintenance');

function createApp() {
  const app = express();

  const ALLOWED_ORIGINS = [
    'https://velync.web.app',
    'https://velync.firebaseapp.com',
    'http://localhost:5000',
    'http://localhost:3000',
    'http://127.0.0.1:5000',
  ];
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type,Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
  });

  app.use(express.json());

  app.get('/', (req, res) => {
    res.send('Velync Integration Platform is running.');
  });

  // ─── Maintenance mode middleware ─────────────────────────────────
  app.use('/api', maintenanceMode);

  // ─── Routes ──────────────────────────────────────────────────────
  app.use(authRoutes);
  app.use('/api', platformRoutes);
  app.use('/api', schemaRoutes);
  app.use('/api', workspaceRoutes);
  app.use('/api', syncConfigsRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use(syncRoutes);

  app.use((req, res) => {
    res.status(404).send('Not Found');
  });

  return app;
}

function startServer() {
  const app = createApp();
  const port = config.port;

  app.listen(port, () => {
    console.log('======================================================');
    console.log('                 Velync Integration Platform          ');
    console.log('======================================================');
    logger.info('server', `Listening on port ${port}`);
  });

  return app;
}

module.exports = { createApp, startServer };
