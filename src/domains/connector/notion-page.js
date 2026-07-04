const axios = require('axios');
const config = require('../../core/config');
const http = axios.create({ timeout: config.externalApiTimeout });

function buildSyncChildren(content, checklistItems = []) {
  const innerChildren = [];
  if (content && content.trim() !== '') {
    const lines = content.split('\n');
    const attachmentRegex = /!\[([^\]]*)\]\(([a-f0-9]+\/[^\)]+)\)/gi;

    for (const line of lines) {
      const cleanedLine = line.replace(attachmentRegex, '').trim();
      if (cleanedLine !== '') {
        innerChildren.push({
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [
              {
                type: 'text',
                text: {
                  content: cleanedLine.substring(0, 2000),
                },
              },
            ],
          },
        });
      }
    }
  }

  if (Array.isArray(checklistItems) && checklistItems.length > 0) {
    for (const checklistItem of checklistItems) {
      const itemTitle = checklistItem.title || '';
      if (itemTitle.trim() !== '') {
        innerChildren.push({
          object: 'block',
          type: 'to_do',
          to_do: {
            rich_text: [
              {
                type: 'text',
                text: {
                  content: itemTitle.substring(0, 2000),
                },
              },
            ],
            checked: checklistItem.status === 1 || checklistItem.status === 2,
          },
        });
      }
    }
  }

  if (innerChildren.length > 0) {
    return [{
      object: 'block',
      type: 'toggle',
      toggle: {
        rich_text: [{ type: 'text', text: { content: 'TickTick Sync Content' } }],
        children: innerChildren.slice(0, 99)
      }
    }];
  }
  return [];
}

async function createNotionPage(notionService, properties, content, dbSchema, fallbackTitle, checklistItems = [], templateId = null) {
  const children = buildSyncChildren(content, checklistItems);

  let hasTitle = false;
  for (const key of Object.keys(properties)) {
    if (dbSchema[key]?.type === 'title') {
      hasTitle = true;
      break;
    }
  }

  if (!hasTitle) {
    const titlePropName = Object.keys(dbSchema).find(k => dbSchema[k].type === 'title') || 'Name';
    properties[titlePropName] = {
      title: [{ type: 'text', text: { content: fallbackTitle.substring(0, 2000) } }]
    };
  }

  let page;
  let shouldDelay = false;

  if (templateId) {
    console.log(`[Notion Service] Creating page using template ID: ${templateId}...`);
    const { dataSourceId, isRealDataSource } = await notionService.getDataSourceId();

    const headers = {
      'Authorization': `Bearer ${notionService.notionToken}`,
      'Notion-Version': '2026-03-11',
      'Content-Type': 'application/json'
    };

    const buildPayload = (parentType) => ({
      parent: parentType === 'database_id'
        ? { type: 'database_id', database_id: dataSourceId }
        : { type: 'data_source_id', data_source_id: dataSourceId },
      template: { type: 'template_id', template_id: templateId },
      properties,
    });

    try {
      const res = await http.post(
        'https://api.notion.com/v1/pages',
        isRealDataSource ? buildPayload('data_source_id') : buildPayload('database_id'),
        { headers }
      );
      page = res.data;
      shouldDelay = true;
    } catch (firstErr) {
      if (!isRealDataSource && firstErr.response?.status === 404) {
        console.log(`[Notion Service] Retrying with data_source_id parent type...`);
        const res = await http.post('https://api.notion.com/v1/pages', buildPayload('data_source_id'), { headers });
        page = res.data;
        shouldDelay = true;
      } else {
        throw firstErr;
      }
    }
  } else {
    try {
      page = await notionService.client.pages.create({
        parent: { database_id: notionService.databaseId },
        properties: properties,
      });
    } catch (err) {
      if (err.code === 'object_not_found' || err.code === 'validation_error') {
        console.log(`[Notion Service] Falling back to data_source_id for page creation...`);
        page = await notionService.client.pages.create({
          parent: { type: 'data_source_id', data_source_id: notionService.databaseId },
          properties: properties,
        });
      } else {
        throw err;
      }
    }
  }

  if (shouldDelay) {
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  return page;
}

module.exports = { createNotionPage, buildSyncChildren };
