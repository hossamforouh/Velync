const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '../index.js');
const lines = fs.readFileSync(file, 'utf8').split('\n');

const newExpressCode = `  // Serverless HTTP Mode (for Google Cloud Run)
  const express = require('express');
  const app = express();
  const port = process.env.PORT || 8080;
  
  console.log(\`[Cloud Run Mode] Starting Express HTTP server on port \${port}...\`);

  // CORS Middleware
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type,Authorization');
    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }
    next();
  });

  app.use(express.json());

  // Auth Middleware
  const verifyAuth = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized: Missing or invalid Authorization header' });
    }
    try {
      const decodedToken = await getAuth().verifyIdToken(authHeader.split('Bearer ')[1]);
      req.user = decodedToken;
      next();
    } catch (err) {
      console.error('[Auth Middleware] Verification failed:', err.message);
      return res.status(401).json({ error: 'Unauthorized: Token verification failed' });
    }
  };

  // Health check
  app.get('/', (req, res) => {
    res.send('TickTick-Notion Sync Service is running with Firestore configs.');
  });

  // /sync
  app.post('/sync', async (req, res) => {
    console.log(\`[\${new Date().toISOString()}] Received request to trigger sync...\`);
    try {
      await runSyncWorkflow(true);
      res.json({ success: true, message: 'Sync workflow executed successfully.' });
    } catch (err) {
      console.error('[Cloud Run Mode] Sync workflow failed:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // /api/data-sources
  app.get('/api/data-sources', verifyAuth, (req, res) => {
    res.json([
      { id: 'fetchTickTickLists', name: 'TickTick: Fetch Lists' },
      { id: 'fetchTickTickTags', name: 'TickTick: Fetch Tags' },
      { id: 'fetchNotionDBs', name: 'Notion: Fetch Databases' },
      { id: 'fetchNotionTemplates', name: 'Notion: Fetch Templates' },
      { id: 'google_contacts_fetch_groups', name: 'Google Contacts: Fetch Contact Groups' }
    ]);
  });

  // /api/platform-entities
  app.post('/api/platform-entities', verifyAuth, async (req, res) => {
    try {
      const { connectionId, providerName, dataSourceId, parentValue } = req.body;
      if (!connectionId) throw new Error('Connection ID required');
      
      const creds = await resolveConnectionTokens(req.user.uid, connectionId);
      let entities = [];

      switch (dataSourceId) {
        case 'fetchTickTickLists':
          const ticktick = new TickTickService(creds);
          const lists = await ticktick.getProjects();
          entities = (lists || []).map(l => ({ id: l.id || l.name, name: l.name }));
          break;
        case 'google_contacts_fetch_groups':
          // Placeholder logic for Google People API
          entities = [
            { id: 'contactGroups/all', name: 'All Contacts' },
            { id: 'contactGroups/starred', name: 'Starred Contacts' }
          ];
          break;
        default:
          throw new Error(\`Unknown data source: \${dataSourceId}\`);
      }
      
      res.json({ success: true, entities });
    } catch (err) {
      console.error('[Cloud Run Mode] Failed to fetch platform entities:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Legacy endpoints (migrated)
  app.get('/api/notion/databases', verifyAuth, async (req, res) => {
    try {
      const connectionId = req.query.connectionId;
      if (!connectionId) throw new Error('Connection ID required');
      const creds = await resolveConnectionTokens(req.user.uid, connectionId);
      const notion = new NotionService(creds.accessToken);
      const databases = await notion.listDatabases();
      res.json({ success: true, databases });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/ticktick/lists', verifyAuth, async (req, res) => {
    try {
      const connectionId = req.query.connectionId;
      if (!connectionId) throw new Error('Connection ID required');
      const creds = await resolveConnectionTokens(req.user.uid, connectionId);
      const ticktick = new TickTickService(creds);
      const lists = await ticktick.getProjects();
      res.json({ success: true, lists: lists || [] });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/notion-database-schema', verifyAuth, async (req, res) => {
    try {
      const { connectionId, databaseId, token } = req.body;
      if (!databaseId) throw new Error('Notion database ID is required');
      let actualToken = token;
      if (connectionId) {
        const creds = await resolveConnectionTokens(req.user.uid, connectionId);
        actualToken = creds.accessToken;
      }
      if (!actualToken) throw new Error('Token or Connection ID required');
      const notion = new NotionService(actualToken, databaseId);
      const schema = await notion.getDatabaseSchema();
      res.json({ success: true, schema });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/notion-database-templates', verifyAuth, async (req, res) => {
    try {
      const { connectionId, databaseId, token } = req.body;
      if (!databaseId) throw new Error('Notion database ID is required');
      let actualToken = token;
      if (connectionId) {
        const creds = await resolveConnectionTokens(req.user.uid, connectionId);
        actualToken = creds.accessToken;
      }
      if (!actualToken) throw new Error('Token or Connection ID required');
      const notion = new NotionService(actualToken, databaseId);
      const templates = await notion.listTemplates();
      res.json({ success: true, templates });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/oauth/exchange', verifyAuth, async (req, res) => {
    try {
      const uid = req.user.uid;
      const { code, platformId, label, workspaceId, redirectUri } = req.body;
      if (!code || !platformId) return res.status(400).json({ error: 'Missing code or platformId' });

      const platformDoc = await db.collection('platforms').doc(platformId).get();
      if (!platformDoc.exists) return res.status(404).json({ error: 'Platform not found' });
      const platform = platformDoc.data();
      
      const clientId = platform.clientId;
      const clientSecret = platform.clientSecret;
      if (!clientId || !clientSecret) throw new Error('Platform is missing OAuth Client ID or Client Secret in its attributes');

      const basicAuth = Buffer.from(\`\${clientId}:\${clientSecret}\`).toString('base64');
      const params = new URLSearchParams();
      params.append('client_id', clientId);
      params.append('client_secret', clientSecret);
      params.append('code', code);
      params.append('grant_type', 'authorization_code');
      params.append('redirect_uri', redirectUri);

      const response = await axios.post(platform.tokenUrl, params.toString(), {
        headers: {
          'Authorization': \`Basic \${basicAuth}\`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      const data = response.data;
      const accessToken = data.access_token;
      if (!accessToken) throw new Error('Failed to retrieve access token from provider');
      
      const encryptedToken = encrypt(accessToken);
      let encryptedRefreshToken = null;
      if (data.refresh_token) {
        encryptedRefreshToken = encrypt(data.refresh_token);
      }

      const credentialRef = db.collection('credentials').doc(uid);
      await credentialRef.set({
        [platformId]: {
          accessToken: encryptedToken,
          refreshToken: encryptedRefreshToken,
          providerWorkspaceId: data.workspace_id || null,
          providerWorkspaceName: data.workspace_name || null,
          botId: data.bot_id || null,
          updatedAt: new Date().toISOString()
        }
      }, { merge: true });

      const connectionPayload = {
        provider: platformId,
        label: label || platform?.name || 'OAuth Connection',
        userId: uid,
        workspaceId: workspaceId || uid,
        authType: 'oauth',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attributes: {}
      };
      
      await db.collection('connected_accounts').add(connectionPayload);
      res.json({ success: true, message: 'OAuth successful. Credentials securely stored.' });
    } catch (err) {
      console.error('[Cloud Run Mode] OAuth exchange failed:', err.response ? err.response.data : err.message);
      res.status(500).json({ success: false, error: err.response?.data?.message || err.message });
    }
  });

  app.use((req, res) => {
    res.status(404).send('Not Found');
  });

  app.listen(port, () => {
    console.log(\`[Cloud Run Mode] Express HTTP Server is listening on port \${port}.\`);
    console.log('======================================================');
  });`;

const newLines = newExpressCode.split('\n');

// Replace lines 110 to 351 (0-indexed 110 to 351 inclusive)
lines.splice(110, 352 - 110, ...newLines);

fs.writeFileSync(file, lines.join('\n'));
console.log('Successfully refactored index.js to use Express!');
