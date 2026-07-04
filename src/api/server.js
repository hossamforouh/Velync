const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
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

const ALLOWED_ORIGINS = [
  'https://velync.web.app',
  'https://velync.firebaseapp.com',
  'http://localhost:5000',
  'http://localhost:3000',
  'http://127.0.0.1:5000',
];

function createApp() {
  const app = express();

  // Security headers
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }));

  // Request ID tracing
  app.use((req, res, next) => {
    req.requestId = req.headers['x-request-id'] || uuidv4();
    res.setHeader('X-Request-Id', req.requestId);
    next();
  });

  // CORS
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type,Authorization,X-Request-Id');
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
  });

  // Body parser with size limit
  app.use(express.json({ limit: config.maxRequestBodySize }));

  // Rate limiting
  const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  });
  app.use(globalLimiter);

  const authLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts, please try again later.' },
  });

  app.get('/', (req, res) => {
    res.send('Velync Integration Platform is running.');
  });

  // Maintenance mode middleware
  app.use('/api', maintenanceMode);

  // Routes
  app.use(authRoutes);
  app.use('/api', authLimiter, platformRoutes);
  app.use('/api', schemaRoutes);
  app.use('/api', workspaceRoutes);
  app.use('/api', syncConfigsRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use(syncRoutes);

  app.use((req, res) => {
    res.status(404).json({ error: 'Not Found', requestId: req.requestId });
  });

  return app;
}

function startServer() {
  const app = createApp();
  const port = config.port;

  const server = app.listen(port, () => {
    console.log('======================================================');
    console.log('                 Velync Integration Platform          ');
    console.log('======================================================');
    logger.info('server', `Listening on port ${port}`);
  });

  // Graceful shutdown
  const gracefulShutdown = (signal) => {
    logger.info('server', `${signal} received — shutting down gracefully`);
    server.close(() => {
      logger.info('server', 'HTTP server closed');
      process.exit(0);
    });
    setTimeout(() => {
      logger.error('server', 'Forced shutdown after timeout');
      process.exit(1);
    }, 30000);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  return server;
}

module.exports = { createApp, startServer };
