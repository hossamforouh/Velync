const express = require('express');
const config = require('../core/config');
const logger = require('../core/logger');

const authRoutes = require('./routes/auth');
const platformRoutes = require('./routes/platform');
const schemaRoutes = require('./routes/schema');
const syncRoutes = require('./routes/sync');
const workspaceRoutes = require('./routes/workspace');

function createApp() {
  const app = express();

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type,Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
  });

  app.use(express.json());

  app.get('/', (req, res) => {
    res.send('Velync Integration Platform is running.');
  });

  app.use(authRoutes);
  app.use('/api', platformRoutes);
  app.use('/api', schemaRoutes);
  app.use('/api', workspaceRoutes);
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
