const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const config = require('../core/config');
const logger = require('../core/logger');
const db = require('../core/db');

const authRoutes = require('./routes/auth');
const platformRoutes = require('./routes/platform');
const schemaRoutes = require('./routes/schema');
const workspaceRoutes = require('./routes/workspace');
const connectionsRoutes = require('./routes/connections');
const syncConfigsRoutes = require('./routes/sync-configs');
const settingsRoutes = require('./routes/settings');
const adminRoutes = require('./routes/admin');
const adminPlansRoutes = require('./routes/admin-plans');
const adminStatsRoutes = require('./routes/admin-stats');
const adminPlatformsRoutes = require('./routes/admin-platforms');
const adminIntegrationsRoutes = require('./routes/admin-integrations');
const billingRoutes = require('./routes/billing');
const publicPlansRoutes = require('./routes/public-plans');
const publicMarketplaceRoutes = require('./routes/public-marketplace');
const internalRoutes = require('./routes/internal');
const usageRoutes = require('./routes/usage');
const adminUsageRoutes = require('./routes/admin-usage');
const clientErrorsRoutes = require('./routes/client-errors');
const { maintenanceMode } = require('./middleware/maintenance');

const ALLOWED_ORIGINS = [
  'https://velync.web.app',
  'https://velync.firebaseapp.com',
  'https://velync-staging.web.app',
  'https://velync-staging.firebaseapp.com',
  'http://localhost:5000',
  'http://localhost:3000',
  'http://127.0.0.1:5000',
];

function createApp() {
  const app = express();

  // Cloud Run terminates TLS and forwards via a proxy (X-Forwarded-For). Trust it
  // so express-rate-limit can identify clients by real IP (otherwise it throws a
  // validation error and can't rate-limit correctly).
  app.set('trust proxy', true);

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

  // Body parser with size limit — skip for the billing webhook (needs raw body)
  app.use('/api/billing/webhook', express.raw({ type: 'application/json', limit: config.maxRequestBodySize }));
  // Must NOT run express.json() on the webhook path or it will consume the raw body stream,
  // causing the HMAC signature check in lemonSqueezy.js to fail.
  app.use((req, res, next) => {
    if (req.path === '/api/billing/webhook') return next();
    express.json({ limit: config.maxRequestBodySize })(req, res, next);
  });

  // Rate limiting
  const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  });
  app.use(globalLimiter);

  app.get('/', (req, res) => {
    res.send('Velync Integration Platform is running.');
  });

  // Health check endpoint (bypasses maintenance mode via middleware)
  app.get('/health', async (req, res) => {
    // Quick Firestore probe to verify DB connectivity
    try {
      await db.collection('app_settings').doc('general').get();
      res.json({ status: 'ok', uptime: process.uptime() });
    } catch (dbErr) {
      logger.error('health', 'DB probe failed', { error: dbErr.message });
      res.status(503).json({ status: 'error', error: 'database unreachable' });
    }
  });

  // Maintenance mode middleware
  app.use('/api', maintenanceMode);

  // Routes
  app.use(authRoutes);
  app.use('/api', platformRoutes);
  app.use('/api', schemaRoutes);
  app.use('/api', workspaceRoutes);
  app.use('/api', connectionsRoutes);
  app.use('/api', syncConfigsRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api', adminRoutes);
  app.use('/api', adminPlansRoutes);
  app.use('/api', adminStatsRoutes);
  app.use('/api', adminPlatformsRoutes);
  app.use('/api', adminIntegrationsRoutes);
  app.use('/api', billingRoutes);
  app.use('/api', publicPlansRoutes);
  app.use('/api', publicMarketplaceRoutes);
  app.use('/api', internalRoutes);
  app.use('/api', usageRoutes);
  app.use('/api', adminUsageRoutes);
  app.use('/api', clientErrorsRoutes);

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
