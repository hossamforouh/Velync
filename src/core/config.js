require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT, 10) || 8080,
  logLevel: process.env.LOG_LEVEL || 'info',
  encryptionKey: process.env.ENCRYPTION_KEY,
  notionToken: process.env.NOTION_INTEGRATION_TOKEN,
  notionDatabaseId: process.env.NOTION_DATABASE_ID,
  ticktick: {
    clientId: process.env.TICKTICK_CLIENT_ID,
    clientSecret: process.env.TICKTICK_CLIENT_SECRET,
    accessToken: process.env.TICKTICK_ACCESS_TOKEN,
    username: process.env.TICKTICK_USERNAME,
    password: process.env.TICKTICK_PASSWORD,
    cookie: process.env.TICKTICK_COOKIE,
  },
  firebase: {
    projectId: process.env.GOOGLE_CLOUD_PROJECT,
  },
  superadminUids: (process.env.SUPERADMIN_UIDS || 'Ryu5sGSNYrgFN12EgpRpwl4rg1z2,Jfkkjsfas3hUm1Gq1xQqLTEp8Wl1').split(',').map(s => s.trim()).filter(Boolean),
  isCloudRun: !!process.env.PORT,
  nodeEnv: process.env.NODE_ENV || 'development',
  apiKeyAuthEnabled: process.env.API_KEY_AUTH_ENABLED !== 'false',
  externalApiTimeout: parseInt(process.env.EXTERNAL_API_TIMEOUT, 10) || 30000,
  maxRequestBodySize: process.env.MAX_REQUEST_BODY_SIZE || '1mb',
};

module.exports = config;
