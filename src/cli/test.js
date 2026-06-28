const { NotionService } = require('../../services/notion');
const { TickTickService } = require('../../services/ticktick');
const { getConnector } = require('../domains/connector/registry');
const { resolveConnectionTokens } = require('../domains/connection/resolver');
const logger = require('../core/logger');

async function testConfigConnections(config, configId) {
  const description = config.description || configId;
  logger.info('cli', `Testing connections for "${description}"`);

  // New-style configs (marketplace)
  if (config.sourcePlatform && config.sourceConnectionId) {
    try {
      const creds = await resolveConnectionTokens(config.workspaceId, config.sourceConnectionId);
      const Cls = getConnector(config.sourcePlatform);
      const instance = new Cls(creds);
      const ok = await instance.connect();
      logger.info('cli', `${config.sourcePlatform} connected for "${description}" — ${ok ? '✅' : '❌'}`);
    } catch (err) {
      logger.error('cli', `${config.sourcePlatform} test failed for "${description}"`, { error: err.message });
    }
  } else {
    // Legacy TickTick/Notion configs
    const ticktickConfig = config.ticktick || {};
    try {
      const ticktick = new TickTickService({
        accessToken: ticktickConfig.accessToken,
        clientId: ticktickConfig.clientId,
        clientSecret: ticktickConfig.clientSecret,
      });
      const listName = ticktickConfig.listName || 'Inbox';
      const tasks = await ticktick.getTasksFromList(listName);
      logger.info('cli', `TickTick connected for "${description}" — ${tasks.length} tasks in ${listName}`);
    } catch (err) {
      logger.error('cli', `TickTick test failed for "${description}"`, { error: err.message });
    }
  }

  if (config.destPlatform && config.destConnectionId) {
    try {
      const creds = await resolveConnectionTokens(config.workspaceId, config.destConnectionId);
      const Cls = getConnector(config.destPlatform);
      const instance = new Cls(creds);
      const ok = await instance.connect();
      logger.info('cli', `${config.destPlatform} connected for "${description}" — ${ok ? '✅' : '❌'}`);
    } catch (err) {
      logger.error('cli', `${config.destPlatform} test failed for "${description}"`, { error: err.message });
    }
  } else {
    // Legacy Notion
    const notionConfig = config.notion || {};
    try {
      const notion = new NotionService(notionConfig.integrationToken, notionConfig.databaseId);
      await notion.testNotionConnection();
      logger.info('cli', `Notion connected for "${description}" — ✅`);
    } catch (err) {
      logger.error('cli', `Notion test failed for "${description}"`, { error: err.message });
    }
  }
}

module.exports = { testConfigConnections };
