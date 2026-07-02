const { Firestore } = require('@google-cloud/firestore');
const cronParser = require('cron-parser');
const { TickTickService } = require('../services/ticktick');
const { NotionService } = require('../services/notion');
const { decrypt } = require('../utils/encryption');

// Initialize Firestore
const db = new Firestore();

const runningConfigs = new Set();

/**
 * Extracts the first URL found in a text string.
 * @param {string} text Input text
 * @returns {string|null} First matched URL or null
 */
function extractFirstUrl(text) {
  if (!text) return null;
  const urlRegex = /(https?:\/\/[^\s]+)/i;
  const match = text.match(urlRegex);
  return match ? match[0] : null;
}

/**
 * Generates page children (blocks) and creates a Notion page dynamically based on mappings.
 */
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

  // Ensure title property exists in properties payload
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
    const dataSourceId = await notionService.getDataSourceId();
    
    const axios = require('axios');
    const headers = {
      'Authorization': `Bearer ${notionService.notionToken}`,
      'Notion-Version': '2026-03-11',
      'Content-Type': 'application/json'
    };

    const payload = {
      parent: {
        type: 'data_source_id',
        data_source_id: dataSourceId
      },
      template: {
        type: 'template_id',
        template_id: templateId
      },
      properties: properties
    };

    const res = await axios.post('https://api.notion.com/v1/pages', payload, { headers });
    page = res.data;
    shouldDelay = true;
  } else {
    // Check if the database has any templates (indicating a default template may be applied)
    const templates = await notionService.listTemplates().catch(() => []);
    const hasDefaultTemplate = templates.length > 0;

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
    
    if (hasDefaultTemplate) {
      shouldDelay = true;
    }
  }

  if (children.length > 0) {
    if (shouldDelay) {
      console.log(`[Notion Service] Waiting 3 seconds for template layout engine to fully populate page ${page.id}...`);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    console.log(`[Notion Service] Appending ${children.length} child blocks to page ${page.id}...`);
    await notionService.client.blocks.children.append({
      block_id: page.id,
      children: children,
    });
  }

  return page;
}

/**
 * Deletes existing blocks on a page and appends new description and checklist blocks.
 */
async function updateNotionPageContent(notionService, pageId, content, checklistItems = []) {
  console.log(`[Notion Service] Updating content and subtasks for page ${pageId}...`);
  try {
    // 1. Fetch current blocks on the page
    let blocks = [];
    let cursor = undefined;
    let hasMore = true;

    while (hasMore) {
      const response = await notionService.client.blocks.children.list({
        block_id: pageId,
        start_cursor: cursor,
        page_size: 100,
      });
      blocks = blocks.concat(response.results);
      hasMore = response.has_more;
      cursor = response.next_cursor;
    }

    // 2. Search and delete all existing TickTick Sync Content toggle blocks
    const syncBlocks = blocks.filter(b => 
      b.type === 'toggle' && 
      b.toggle?.rich_text?.[0]?.plain_text === 'TickTick Sync Content'
    );

    if (syncBlocks.length > 0) {
      for (const block of syncBlocks) {
        console.log(`[Notion Service] Found existing sync toggle block (${block.id}). Deleting...`);
        try {
          await notionService.client.blocks.delete({ block_id: block.id });
        } catch (err) {
          console.warn(`[Notion Service] ⚠️ Failed to delete sync toggle block ${block.id}:`, err.message);
        }
      }
    } else {
      console.log(`[Notion Service] No existing sync toggle block found on page.`);
    }

    // 3. Build new blocks list
    const children = buildSyncChildren(content, checklistItems);

    // 4. Append new blocks
    if (children.length > 0) {
      await notionService.client.blocks.children.append({
        block_id: pageId,
        children: children,
      });
      console.log(`[Notion Service] ✅ Successfully updated page content inside sync toggle.`);
    } else {
      console.log(`[Notion Service] No sync content to append.`);
    }
  } catch (error) {
    console.error(`[Notion Service] ❌ Failed to update page content blocks:`, error.message);
  }
}

/**
 * Calculates streaks and completion counts for all TickTick habits.
 * @param {TickTickService} ticktickService
 * @returns {Promise<Array>} List of habit objects with streak & totalCompletions
 */
async function fetchHabitsWithStats(ticktickService) {
  console.log('[Workflow] Fetching habits with stats...');
  const habits = await ticktickService.getHabits();
  const habitsWithStats = [];

  for (const habit of habits) {
    let streak = 0;
    let totalCompletions = 0;

    try {
      const checkinData = await ticktickService.getHabitCheckins(habit.id);
      const checkins = checkinData.checkins || [];

      // Sort checkins by stamp descending (YYYYMMDD)
      const sortedCheckins = checkins
        .filter(c => c.value >= c.goal)
        .sort((a, b) => b.stamp - a.stamp);

      totalCompletions = sortedCheckins.length;

      if (sortedCheckins.length > 0) {
        // Parse YYYYMMDD stamp to Date
        const parseStamp = (stamp) => {
          const s = String(stamp);
          const y = parseInt(s.slice(0, 4), 10);
          const m = parseInt(s.slice(4, 6), 10) - 1;
          const d = parseInt(s.slice(6, 8), 10);
          return new Date(y, m, d);
        };

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const yesterday = new Date(today);
        yesterday.setDate(today.getDate() - 1);

        const latestCheckinDate = parseStamp(sortedCheckins[0].stamp);
        latestCheckinDate.setHours(0, 0, 0, 0);

        if (latestCheckinDate.getTime() === today.getTime() || latestCheckinDate.getTime() === yesterday.getTime()) {
          streak = 1;
          let prevDate = latestCheckinDate;

          for (let i = 1; i < sortedCheckins.length; i++) {
            const currDate = parseStamp(sortedCheckins[i].stamp);
            currDate.setHours(0, 0, 0, 0);

            const diffDays = Math.round((prevDate.getTime() - currDate.getTime()) / (1000 * 60 * 60 * 24));

            if (diffDays === 1) {
              streak++;
              prevDate = currDate;
            } else if (diffDays > 1) {
              break;
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[Workflow] ⚠️ Failed to fetch checkins for habit "${habit.name}":`, err.message);
    }

    habitsWithStats.push({
      ...habit,
      title: habit.name, // alias for title matching
      streak,
      totalCompletions,
      modifiedTime: habit.modifiedTime || new Date().toISOString()
    });
  }

  return habitsWithStats;
}

/**
 * Maps standard TickTick properties into Notion Properties payload.
 */
async function mapTickTickToNotion(ticktickItem, mappings, notionDbSchema, ticktickToMapping = new Map(), statusMappings = null) {
  const properties = {};
  let content = '';

  for (const m of mappings) {
    const { ticktickField, notionProperty } = m;
    if (!ticktickField || !notionProperty) continue;

    let value = ticktickItem[ticktickField];
    if (ticktickField === 'title' && !value && ticktickItem.name) {
      value = ticktickItem.name;
    }

    // Fallback for desc vs content naming mismatch from TickTick OpenAPI
    if ((ticktickField === 'desc' || ticktickField === 'content') && (value === undefined || value === null || value === '')) {
      value = ticktickItem.desc || ticktickItem.content || '';
    }

    if (notionProperty === '__content__') {
      content = value ? String(value) : '';
      continue;
    }

    const propSchema = notionDbSchema[notionProperty];
    if (!propSchema) continue;

    if ((value === undefined || value === null) && propSchema.type !== 'relation') continue;

    switch (propSchema.type) {
      case 'title':
        properties[notionProperty] = {
          title: [{ type: 'text', text: { content: String(value).substring(0, 2000) } }]
        };
        break;
      case 'rich_text':
        properties[notionProperty] = {
          rich_text: [{ type: 'text', text: { content: String(value).substring(0, 2000) } }]
        };
        break;
      case 'number':
        properties[notionProperty] = { number: Number(value) };
        break;
      case 'checkbox':
        properties[notionProperty] = { checkbox: Boolean(value) };
        break;
      case 'url':
        properties[notionProperty] = { url: String(value) };
        break;
      case 'select':
        if (statusMappings && statusMappings.incompleteDefault && statusMappings.completeDefault && ticktickField === 'status') {
          const numVal = Number(value);
          const mappedSelectName = numVal === 2 ? statusMappings.completeDefault : statusMappings.incompleteDefault;
          properties[notionProperty] = { select: { name: mappedSelectName } };
        } else {
          properties[notionProperty] = { select: { name: String(value).substring(0, 100) } };
        }
        break;
      case 'status':
        const statusOptions = propSchema.status?.options || [];
        let mappedStatusName = null;
        
        const numVal = Number(value);
        if (statusMappings && statusMappings.incompleteDefault && statusMappings.completeDefault) {
          if (numVal === 2) {
            mappedStatusName = statusMappings.completeDefault;
          } else {
            mappedStatusName = statusMappings.incompleteDefault;
          }
        } else {
          if (numVal === 2) {
            // Look for "Completed" or similar in options
            const match = statusOptions.find(opt => 
              ['completed', 'complete', 'done'].includes(opt.name.toLowerCase())
            );
            mappedStatusName = match ? match.name : (statusOptions.find(opt => opt.color === 'green')?.name || 'Completed');
          } else {
            // Look for "Not Started" or similar in options
            const match = statusOptions.find(opt => 
              ['not started', 'to-do', 'todo'].includes(opt.name.toLowerCase())
            );
            mappedStatusName = match ? match.name : (statusOptions[0]?.name || 'Not Started');
          }
        }
        
        properties[notionProperty] = { status: { name: mappedStatusName } };
        break;
      case 'multi_select':
        let tags = [];
        if (Array.isArray(value)) {
          tags = value;
        } else if (typeof value === 'string') {
          tags = value.split(',').map(t => t.trim()).filter(Boolean);
        } else {
          tags = [String(value)];
        }
        
        const availableOptions = propSchema.multi_select?.options || [];
        const multiSelectValues = tags.map(tag => {
          const match = availableOptions.find(opt => opt.name.toLowerCase() === tag.toLowerCase());
          return { name: match ? match.name : tag };
        });
        
        properties[notionProperty] = { multi_select: multiSelectValues };
        break;
      case 'date':
        try {
          const isoDate = new Date(value).toISOString();
          properties[notionProperty] = { date: { start: isoDate } };
        } catch {
          console.warn(`[Workflow] Invalid date value "${value}" for property "${notionProperty}"`);
        }
        break;
      case 'relation':
        if (ticktickField === 'parentId' && value) {
          const parentMapping = ticktickToMapping.get(value);
          if (parentMapping && parentMapping.notionPageId) {
            properties[notionProperty] = {
              relation: [{ id: parentMapping.notionPageId }]
            };
          } else {
            console.log(`[Workflow] Parent mapping not found for TickTick parent ID ${value}. Relation not set yet.`);
            properties[notionProperty] = { relation: [] };
          }
        } else {
          properties[notionProperty] = { relation: [] };
        }
        break;
    }
  }

  return { properties, content };
}

/**
 * Maps standard Notion Page properties into TickTick Item payload.
 */
async function mapNotionToTickTick(notionPage, mappings, targetEntity, notionService, notionToMapping = new Map(), statusMappings = null) {
  const ticktickItem = {};

  for (const m of mappings) {
    const { ticktickField, notionProperty } = m;
    if (!ticktickField || !notionProperty) continue;

    if (notionProperty === '__content__') {
      const pageBody = await notionService.getPageContentBlocks(notionPage.id);
      ticktickItem[ticktickField] = pageBody;
      continue;
    }

    const propVal = notionPage.properties[notionProperty];
    if (!propVal) continue;

    let value = null;
    switch (propVal.type) {
      case 'title':
        value = (propVal.title || []).map(t => t.plain_text).join('');
        break;
      case 'rich_text':
        value = (propVal.rich_text || []).map(t => t.plain_text).join('');
        break;
      case 'number':
        value = propVal.number;
        break;
      case 'checkbox':
        value = propVal.checkbox;
        break;
      case 'url':
        value = propVal.url;
        break;
      case 'select':
        value = propVal.select?.name || null;
        break;
      case 'status':
        value = propVal.status?.name || null;
        break;
      case 'multi_select':
        value = (propVal.multi_select || []).map(o => o.name);
        break;
      case 'date':
        value = propVal.date?.start || null;
        break;
      case 'relation':
        const relatedPageId = propVal.relation?.[0]?.id;
        if (relatedPageId && ticktickField === 'parentId') {
          const parentMapping = notionToMapping.get(relatedPageId);
          if (parentMapping && parentMapping.ticktickEntityId) {
            value = parentMapping.ticktickEntityId;
          } else {
            console.log(`[Workflow] TickTick mapping not found for Notion parent page ID ${relatedPageId}.`);
            value = '';
          }
        } else {
          value = '';
        }
        break;
    }

    ticktickItem[ticktickField] = value;
  }

  // Set default structures
  if (targetEntity === 'Tasks') {
    ticktickItem.kind = 'TEXT';
    if (ticktickItem.status !== undefined) {
      const s = ticktickItem.status;
      if (typeof s === 'boolean') {
        ticktickItem.status = s ? 2 : 0;
      } else if (typeof s === 'string') {
        if (statusMappings && Array.isArray(statusMappings.complete) && Array.isArray(statusMappings.incomplete)) {
          const isComplete = statusMappings.complete.some(name => name.toLowerCase() === s.toLowerCase());
          const isIncomplete = statusMappings.incomplete.some(name => name.toLowerCase() === s.toLowerCase());
          if (isComplete) {
            ticktickItem.status = 2;
          } else if (isIncomplete) {
            ticktickItem.status = 0;
          } else {
            // Default fallback if not matched in lists but matched in defaults
            if (statusMappings.completeDefault && s.toLowerCase() === statusMappings.completeDefault.toLowerCase()) {
              ticktickItem.status = 2;
            } else {
              ticktickItem.status = 0;
            }
          }
        } else {
          const lower = s.toLowerCase();
          ticktickItem.status = (lower === 'done' || lower === 'completed' || lower === 'complete') ? 2 : 0;
        }
      }
    }
    if (ticktickItem.priority !== undefined) {
      const p = String(ticktickItem.priority).toLowerCase();
      if (p.includes('high') || p === '5') ticktickItem.priority = 5;
      else if (p.includes('medium') || p === '3') ticktickItem.priority = 3;
      else if (p.includes('low') || p === '1') ticktickItem.priority = 1;
      else ticktickItem.priority = 0;
    }
  } else if (targetEntity === 'Notes') {
    ticktickItem.kind = 'NOTE';
  } else if (targetEntity === 'Habits') {
    if (ticktickItem.title && !ticktickItem.name) {
      ticktickItem.name = ticktickItem.title;
    }
    if (!ticktickItem.type) ticktickItem.type = 'Boolean';
    if (!ticktickItem.goal) ticktickItem.goal = 1.0;
    if (!ticktickItem.step) ticktickItem.step = 1.0;
    if (!ticktickItem.unit) ticktickItem.unit = 'Count';
    if (!ticktickItem.repeatRule) ticktickItem.repeatRule = 'RRULE:FREQ=DAILY;INTERVAL=1';
  }

  return ticktickItem;
}

/**
 * Resolves which TickTick items are syncable based on tags and parent hierarchy.
 */
function getSyncableTickTickItems(items, syncTag, ticktickToMapping) {
  if (!syncTag) return items;
  const syncTagLower = syncTag.toLowerCase();

  const itemMap = new Map();
  for (const item of items) {
    itemMap.set(item.id, item);
  }

  const isSyncableMap = new Map();

  function checkSyncable(item) {
    if (!item) return false;
    if (isSyncableMap.has(item.id)) {
      return isSyncableMap.get(item.id);
    }

    // Direct match: has the sync tag
    const hasTag = item.tags && item.tags.some(tag => tag.toLowerCase() === syncTagLower);
    if (hasTag) {
      isSyncableMap.set(item.id, true);
      return true;
    }

    // Indirect match: parent is mapped
    if (item.parentId) {
      if (ticktickToMapping.has(item.parentId)) {
        isSyncableMap.set(item.id, true);
        return true;
      }
      const parentItem = itemMap.get(item.parentId);
      if (parentItem) {
        const parentSyncable = checkSyncable(parentItem);
        isSyncableMap.set(item.id, parentSyncable);
        return parentSyncable;
      }
    }

    isSyncableMap.set(item.id, false);
    return false;
  }

  return items.filter(item => checkSyncable(item));
}

/**
 * Resolves which Notion pages are syncable based on tags and parent hierarchy.
 */
function getSyncableNotionPages(pages, syncTag, tagPropName, parentPropName, mappedNotionPageIds, notionToMapping) {
  if (!syncTag) return pages;
  const syncTagLower = syncTag.toLowerCase();

  const pageMap = new Map();
  for (const page of pages) {
    pageMap.set(page.id, page);
  }

  const isSyncableMap = new Map();

  function checkSyncable(page) {
    if (!page) return false;
    if (isSyncableMap.has(page.id)) {
      return isSyncableMap.get(page.id);
    }

    // Always keep already mapped pages to ensure updates and deletion propagation function correctly
    if (mappedNotionPageIds.has(page.id)) {
      isSyncableMap.set(page.id, true);
      return true;
    }

    // Direct match: check tag property
    let hasTag = false;
    if (tagPropName) {
      const propVal = page.properties[tagPropName];
      if (propVal) {
        if (propVal.type === 'multi_select') {
          hasTag = (propVal.multi_select || []).some(opt => opt.name.toLowerCase() === syncTagLower);
        } else if (propVal.type === 'select') {
          hasTag = propVal.select?.name?.toLowerCase() === syncTagLower;
        } else if (propVal.type === 'rich_text') {
          const text = (propVal.rich_text || []).map(t => t.plain_text).join('').toLowerCase();
          hasTag = text.includes(syncTagLower);
        }
      }
    }

    if (hasTag) {
      isSyncableMap.set(page.id, true);
      return true;
    }

    // Indirect match: parent is syncable or already mapped
    if (parentPropName) {
      const parentRelation = page.properties[parentPropName]?.relation;
      const parentPageId = parentRelation && parentRelation[0]?.id;
      if (parentPageId) {
        if (mappedNotionPageIds.has(parentPageId) || notionToMapping.has(parentPageId)) {
          isSyncableMap.set(page.id, true);
          return true;
        }
        const parentPage = pageMap.get(parentPageId);
        if (parentPage) {
          const parentSyncable = checkSyncable(parentPage);
          isSyncableMap.set(page.id, parentSyncable);
          return parentSyncable;
        }
      }
    }

    isSyncableMap.set(page.id, false);
    return false;
  }

  return pages.filter(page => checkSyncable(page));
}

/**
 * Checks if a Notion page is already marked as completed.
 */
function isNotionPageCompleted(page, fieldMappings, statusMappings = null) {
  const statusMapping = fieldMappings.find(m => m.ticktickField === 'status');
  if (statusMapping && statusMapping.notionProperty) {
    const propVal = page.properties[statusMapping.notionProperty];
    if (propVal) {
      if (propVal.type === 'status') {
        const statusName = propVal.status?.name || '';
        if (statusMappings && Array.isArray(statusMappings.complete)) {
          return statusMappings.complete.some(name => name.toLowerCase() === statusName.toLowerCase());
        }
        return ['completed', 'complete', 'done'].includes(statusName.toLowerCase());
      }
      if (propVal.type === 'select') {
        const selectName = propVal.select?.name || '';
        if (statusMappings && Array.isArray(statusMappings.complete)) {
          return statusMappings.complete.some(name => name.toLowerCase() === selectName.toLowerCase());
        }
        return ['completed', 'complete', 'done'].includes(selectName.toLowerCase());
      }
      if (propVal.type === 'checkbox') {
        return propVal.checkbox === true;
      }
    }
  }
  return false;
}



/**
 * Runs the sync workflow for all enabled Firestore configurations.
 */
async function runSyncWorkflow(force = false) {
  console.log('[Workflow] Starting sync: Retrieving active configurations from Firestore...');
  
  try {
    const snapshot = await db.collection('sync_configs').where('enabled', '==', true).get();
    
    if (snapshot.empty) {
      console.log('[Workflow] No active sync configurations found in Firestore.');
      return;
    }

    console.log(`[Workflow] Found ${snapshot.size} active configurations to sync.`);
    
    for (const doc of snapshot.docs) {
      const config = doc.data();
      const configId = doc.id;
      const configName = config.description || doc.id;
      
      const schedule = config.cronSchedule || '*/5 * * * *';
      let shouldRun = false;
      try {
        const interval = cronParser.CronExpressionParser.parse(schedule);
        const now = new Date();
        now.setSeconds(0, 0);
        shouldRun = interval.includesDate(now);
      } catch (err) {
        console.warn(`[Workflow] ⚠️ Invalid cron schedule "${schedule}" for config "${configName}". Skipping.`);
        continue;
      }

      if (!force && !shouldRun) {
        console.log(`[Workflow] ⏭️ Skipping Config: "${configName}" (Schedule "${schedule}" does not match current minute)`);
        continue;
      }

      console.log(`\n=================== Executing Config: "${configName}" ===================`);
      try {
        await runSyncForConfig(config, configId);
      } catch (err) {
        console.error(`[Workflow] ❌ Failed to execute config "${configName}":`, err.message);
      }
      console.log(`=======================================================================\n`);
    }
  } catch (error) {
    console.error('[Workflow] ❌ Failed to query configurations from Firestore:', error.message);
  }
}

/**
 * Runs the synchronization workflow for a single configuration.
 */
async function runSyncForConfig(config, configId = 'unknown') {
  if (runningConfigs.has(configId)) {
    console.log(`[Workflow] ⏭️ Skipping execution for config "${configId}" as a sync run is already in progress.`);
    return;
  }
  runningConfigs.add(configId);
  
  const startTime = new Date().toISOString();
  let logRef;
  try {
    logRef = await db.collection('execution_logs').add({
      configId,
      configName: config.description || configId,
      workspaceId: config.workspaceId || null,
      startTime,
      status: 'running'
    });
  } catch (err) {
    console.error(`[Workflow] ⚠️ Failed to create execution log:`, err.message);
  }

  try {
    const notionConfig = config.notion || {
      integrationToken: config.p2Settings?.accessToken || config.p2Creds?.accessToken,
      databaseId: config.p2Settings?.database,
      templateId: config.p2Settings?.templateId
    };
    const ticktickConfig = config.ticktick || {
      accessToken: config.p1Settings?.accessToken || config.p1Creds?.accessToken,
      listName: config.p1Settings?.listName,
      syncTag: config.p1Settings?.tags,
      clientId: config.p1Creds?.clientId,
      clientSecret: config.p1Creds?.clientSecret
    };

    let syncType = config.syncType || 'TickTick_to_Notion';
    const syncTypeMap = { 'Source_to_Dest': 'TickTick_to_Notion', 'Dest_to_Source': 'Notion_to_TickTick' };
    syncType = syncTypeMap[syncType] || syncType;
    const deleteAfterSync = config.deleteAfterSync === true;
    const targetEntity = config.targetEntity || config.p1Settings?.targetEntity || 'Tasks';
    const syncTag = (ticktickConfig.syncTag || '').toLowerCase();
    const listName = ticktickConfig.listName || 'Inbox';
    const templateId = notionConfig.templateId || null;

    // Extract custom field mappings or fallback to defaults
    let fieldMappings = (config.fieldMappings || []).map(m => ({
      ticktickField: m.ticktickField ?? m.sourceField,
      notionProperty: m.notionProperty ?? m.destField,
    })).filter(m => m.ticktickField && m.notionProperty);
    if (fieldMappings.length === 0) {
      if (targetEntity === 'Tasks') {
        fieldMappings = [
          { ticktickField: 'title', notionProperty: 'Name' },
          { ticktickField: 'tags', notionProperty: 'Topic' },
          { ticktickField: 'desc', notionProperty: '__content__' }
        ];
      } else if (targetEntity === 'Notes') {
        fieldMappings = [
          { ticktickField: 'title', notionProperty: 'Name' },
          { ticktickField: 'tags', notionProperty: 'Topic' },
          { ticktickField: 'content', notionProperty: '__content__' }
        ];
      } else if (targetEntity === 'Habits') {
        fieldMappings = [
          { ticktickField: 'name', notionProperty: 'Name' }
        ];
      }
    }

    // Load Secure OAuth Connections if available
    if (config.workspaceId) {
      const p1ConnId = config.ticktickConnectionId || config.platform1ConnectionId;
      const p2ConnId = config.notionConnectionId || config.platform2ConnectionId;
      if (p1ConnId || p2ConnId) {
        try {
          const credsDoc = await db.collection('credentials').doc(config.workspaceId).get();
          if (credsDoc.exists) {
            const creds = credsDoc.data();
            if (p1ConnId) {
              const ttConnDoc = await db.collection('connected_accounts').doc(p1ConnId).get();
              if (ttConnDoc.exists) {
                const provider = ttConnDoc.data().provider;
                if (creds[provider]) {
                  ticktickConfig.accessToken = decrypt(creds[provider].accessToken);
                  ticktickConfig.clientId = creds[provider].clientId;
                  ticktickConfig.clientSecret = creds[provider].clientSecret;
                }
              }
            }
            if (p2ConnId) {
              const nConnDoc = await db.collection('connected_accounts').doc(p2ConnId).get();
              if (nConnDoc.exists) {
                const provider = nConnDoc.data().provider;
                if (creds[provider]) {
                  notionConfig.integrationToken = decrypt(creds[provider].accessToken);
                }
              }
            }
          }
        } catch (err) {
          console.error(`[Workflow] Failed to resolve secure connection credentials:`, err.message);
        }
      }
    }

    const ticktickService = new TickTickService({
      accessToken: ticktickConfig.accessToken,
      clientId: ticktickConfig.clientId,
      clientSecret: ticktickConfig.clientSecret
    });

    const notionService = new NotionService(
      notionConfig.integrationToken,
      notionConfig.databaseId
    );

  console.log(`[Workflow] Sync Settings:`);
  console.log(`  - Entity type     : ${targetEntity}`);
  console.log(`  - Sync direction  : ${syncType}`);
  console.log(`  - Post-sync delete: ${deleteAfterSync}`);
  console.log(`  - Field mappings  : ${JSON.stringify(fieldMappings)}`);

  // Load Notion database schema
  const dbSchema = await notionService.getDatabaseSchema();

  // 1. Fetch active items from TickTick (both uncompleted and recently completed tasks to sync status)
  let ticktickItems = [];
  if (targetEntity === 'Habits') {
    ticktickItems = await fetchHabitsWithStats(ticktickService);
  } else {
    // Tasks or Notes
    const tasks = await ticktickService.getTasksFromList(listName);
    let items = [];
    if (targetEntity === 'Notes') {
      items = tasks.filter(t => t.kind === 'NOTE');
    } else {
      items = tasks.filter(t => t.kind !== 'NOTE');
      try {
        const completedTasks = await ticktickService.getCompletedTasksFromList(listName);
        items = items.concat(completedTasks.filter(t => t.kind !== 'NOTE'));
      } catch (err) {
        console.warn(`[Workflow] ⚠️ Failed to fetch completed tasks from TickTick:`, err.message);
      }
    }
    ticktickItems = items;
  }

  // 2. Fetch active items from Notion
  let notionPages = await notionService.getDatabasePages();

  // 3. Load mappings from Firestore
  const mappingsSnapshot = await db.collection('workspaces').doc(config.workspaceId).collection('sync_configs').doc(configId).collection('sync_mappings').get();
  
  const notionToMapping = new Map();
  const ticktickToMapping = new Map();
  const mappedNotionPageIds = new Set();
  
  mappingsSnapshot.forEach(doc => {
    const data = doc.data();
    const mappingDoc = { mappingId: doc.id, ...data };
    notionToMapping.set(data.notionPageId, mappingDoc);
    ticktickToMapping.set(data.ticktickEntityId, mappingDoc);
    mappedNotionPageIds.add(data.notionPageId);
  });

  console.log(`[Workflow] Loaded ${mappingsSnapshot.size} state mappings from Firestore.`);

  // Filter by sync tag if specified (using hierarchical check for child subtasks)
  if (syncTag && targetEntity !== 'Habits') {
    ticktickItems = getSyncableTickTickItems(ticktickItems, syncTag, ticktickToMapping);
  }

  console.log(`[Workflow] Found ${ticktickItems.length} active TickTick ${targetEntity} objects.`);

  // Filter Notion pages by sync tag if specified (using hierarchical check for child subtasks)
  if (syncTag && targetEntity !== 'Habits') {
    const tagMapping = fieldMappings.find(m => m.ticktickField === 'tags');
    const tagPropName = tagMapping?.notionProperty;
    const parentMapping = fieldMappings.find(m => m.ticktickField === 'parentId');
    const parentPropName = parentMapping?.notionProperty;

    notionPages = getSyncableNotionPages(notionPages, syncTag, tagPropName, parentPropName, mappedNotionPageIds, notionToMapping);
  }

  console.log(`[Workflow] Found ${notionPages.length} active Notion database pages matching sync criteria.`);

  let syncedCount = 0;
  let deletedCount = 0;
  let failedCount = 0;

  // Track active page and entity sets for O(1) existence checks
  const activeTickTickIds = new Set(ticktickItems.map(item => item.id));
  const activeNotionIds = new Set(notionPages.map(page => page.id));

  // Sort tasks/pages so that parents are processed before child subtasks
  if (targetEntity === 'Tasks') {
    // 1. Sort TickTick items: parentId falsy comes first
    ticktickItems.sort((a, b) => {
      const parentA = a.parentId || '';
      const parentB = b.parentId || '';
      if (!parentA && parentB) return -1;
      if (parentA && !parentB) return 1;
      return 0;
    });

    // 2. Sort Notion pages: relation with Parent item falsy comes first
    const parentMapping = fieldMappings.find(m => m.ticktickField === 'parentId');
    if (parentMapping && parentMapping.notionProperty) {
      const parentPropName = parentMapping.notionProperty;
      const hasParent = (page) => {
        const propVal = page.properties[parentPropName];
        return propVal && propVal.relation && propVal.relation.length > 0;
      };
      notionPages.sort((a, b) => {
        const hasA = hasParent(a);
        const hasB = hasParent(b);
        if (!hasA && hasB) return -1;
        if (hasA && !hasB) return 1;
        return 0;
      });
    }
  }

  // Helper: Save/Update mapping in Firestore and update local in-memory caches
  const saveMapping = async (notionPageId, ticktickEntityId, notionLastEditedTime, ticktickLastModifiedTime, checklistState = '', notionRelationState = '') => {
    const mappingData = {
      configId,
      notionPageId,
      ticktickEntityId,
      ticktickEntityType: targetEntity,
      lastSyncedAt: new Date().toISOString(),
      notionLastEditedTime,
      ticktickLastModifiedTime,
      ticktickChecklistState: checklistState,
      notionRelationState
    };

    const mappingDoc = { ...mappingData };
    const existing = ticktickToMapping.get(ticktickEntityId) || notionToMapping.get(notionPageId);
    const mappingsRef = db.collection('workspaces').doc(config.workspaceId).collection('sync_configs').doc(configId).collection('sync_mappings');
    if (existing) {
      mappingDoc.mappingId = existing.mappingId;
      await mappingsRef.doc(existing.mappingId).update(mappingData);
    } else {
      const docRef = await mappingsRef.add(mappingData);
      mappingDoc.mappingId = docRef.id;
    }

    // Update in-memory maps so subsequent loop iterations can resolve parent-child relations instantly
    ticktickToMapping.set(ticktickEntityId, mappingDoc);
    notionToMapping.set(notionPageId, mappingDoc);
  };

  // Helper: Compute a canonical string representing the current relation state of a Notion page.
  // Reads the type directly from each Notion property object (type === 'relation') so we don't
  // need to rely on fieldMapping keys that may not include notionFieldType.
  // Used to detect relation changes independently of the timestamp debounce window.
  const computeNotionRelationState = (notionPage) => {
    const entries = Object.entries(notionPage.properties || {})
      .filter(([, prop]) => prop.type === 'relation')
      .map(([name, prop]) => {
        const ids = (prop.relation || []).map(r => r.id).sort().join(',');
        return `${name}:${ids}`;
      })
      .sort(); // sort property names for consistent ordering
    return entries.join(';');
  };

  // Helper: Delete mapping in Firestore and update local in-memory caches
  const removeMapping = async (mappingDoc) => {
    if (mappingDoc && mappingDoc.mappingId) {
      await db.collection('workspaces').doc(config.workspaceId).collection('sync_configs').doc(configId).collection('sync_mappings').doc(mappingDoc.mappingId).delete();
      ticktickToMapping.delete(mappingDoc.ticktickEntityId);
      notionToMapping.delete(mappingDoc.notionPageId);
    }
  };

  // ----------------------------------------------------
  // Sync Logic execution based on directionality
  // ----------------------------------------------------

  if (syncType === 'TickTick_to_Notion') {
    // ----------------------------------------------------
    // One-way: Integration Hub sync
    // ----------------------------------------------------
    for (const item of ticktickItems) {
      try {
        let mapping = ticktickToMapping.get(item.id);
        if (mapping && !activeNotionIds.has(mapping.notionPageId)) {
          console.log(`[Workflow] Stale mapping found: Mapped Notion page ${mapping.notionPageId} is missing or deleted in Notion. Re-syncing.`);
          mapping = null;
        }
        const { properties, content } = await mapTickTickToNotion(item, fieldMappings, dbSchema, ticktickToMapping, config.statusMappings);

        const checklistState = (item.items || []).map(i => `${i.title}:${i.status}`).join(';');

        if (!mapping) {
          console.log(`[Workflow] Syncing new TickTick item to Notion: "${item.title || item.name}"`);
          const newPage = await createNotionPage(
            notionService,
            properties,
            content,
            dbSchema,
            item.title || item.name || 'Untitled Sync',
            item.items,
            templateId
          );

          syncedCount++;

          if (deleteAfterSync) {
            console.log(`[Workflow] DeleteAfterSync active: deleting TickTick source item ${item.id}...`);
            if (targetEntity === 'Habits') {
              await ticktickService.deleteHabit(item.id);
            } else {
              await ticktickService.deleteTask(item.projectId, item.id);
            }
            deletedCount++;
          } else {
            // Retrieve fresh page with timestamps
            const updatedPage = await notionService.client.pages.retrieve({ page_id: newPage.id });
            await saveMapping(newPage.id, item.id, updatedPage.last_edited_time, item.modifiedTime, checklistState);
          }
        } else {
          // Check modification
          const isTickTickModified = new Date(item.modifiedTime).getTime() > new Date(mapping.ticktickLastModifiedTime || 0).getTime() + 1000;
          const isChecklistChanged = checklistState !== (mapping.ticktickChecklistState || '');
          const notionPage = notionPages.find(p => p.id === mapping.notionPageId);
          const isCompletedStateChanged = notionPage ? ((item.status === 2) !== isNotionPageCompleted(notionPage, fieldMappings, config.statusMappings)) : false;
          
          if (isTickTickModified || isChecklistChanged || isCompletedStateChanged) {
            console.log(`[Workflow] Updating modified TickTick item in Notion: "${item.title || item.name}" (modified=${isTickTickModified}, checklistChanged=${isChecklistChanged}, statusChanged=${isCompletedStateChanged})`);
            await notionService.updateDatabasePage(mapping.notionPageId, properties);
            await updateNotionPageContent(notionService, mapping.notionPageId, content, item.items);
            
            const updatedPage = await notionService.client.pages.retrieve({ page_id: mapping.notionPageId });
            await saveMapping(mapping.notionPageId, item.id, updatedPage.last_edited_time, item.modifiedTime, checklistState);
            syncedCount++;
          }

          if (deleteAfterSync) {
            console.log(`[Workflow] DeleteAfterSync active: deleting TickTick source item ${item.id}...`);
            if (targetEntity === 'Habits') {
              await ticktickService.deleteHabit(item.id);
            } else {
              await ticktickService.deleteTask(item.projectId, item.id);
            }
            await removeMapping(mapping);
            deletedCount++;
          }
        }
      } catch (err) {
        console.error(`[Workflow] ❌ Failed to sync TickTick item "${item.title || item.name}":`, err.message);
        failedCount++;
      }
    }

    // Deletion propagation: check for items deleted in TickTick
    if (!deleteAfterSync) {
      for (const [ticktickId, mapping] of ticktickToMapping.entries()) {
        if (!activeTickTickIds.has(ticktickId)) {
          const notionPage = notionPages.find(p => p.id === mapping.notionPageId);
          if (notionPage && isNotionPageCompleted(notionPage, fieldMappings, config.statusMappings)) {
            console.log(`[Workflow] Mapped TickTick item ${ticktickId} is completed. Skipping deletion propagation.`);
            continue;
          }

          console.log(`[Workflow] Propagating TickTick deletion. Archiving Notion page: ${mapping.notionPageId}`);
          try {
            await notionService.archiveDatabasePage(mapping.notionPageId);
            await removeMapping(mapping);
            deletedCount++;
          } catch (err) {
            console.error(`[Workflow] ❌ Failed to archive Notion page ${mapping.notionPageId}:`, err.message);
            failedCount++;
          }
        }
      }
    }

  } else if (syncType === 'Notion_to_TickTick') {
    // ----------------------------------------------------
    // One-way: Notion to TickTick
    // ----------------------------------------------------
    for (const page of notionPages) {
      try {
        let mapping = notionToMapping.get(page.id);
        if (mapping && !activeTickTickIds.has(mapping.ticktickEntityId)) {
          console.log(`[Workflow] Stale mapping found: Mapped TickTick item ${mapping.ticktickEntityId} is missing or deleted in TickTick. Re-syncing.`);
          mapping = null;
        }
        const mappedItem = await mapNotionToTickTick(page, fieldMappings, targetEntity, notionService, notionToMapping, config.statusMappings);

        if (!mapping) {
          console.log(`[Workflow] Syncing new Notion page to TickTick: "${mappedItem.title || mappedItem.name}"`);
          let newEntity;
          if (targetEntity === 'Habits') {
            newEntity = await ticktickService.createHabit(mappedItem);
          } else {
            // Task or Note
            mappedItem.projectId = listName.toLowerCase() === 'inbox' ? 'inbox' : undefined; 
            // Resolve project ID if not Inbox
            if (listName.toLowerCase() !== 'inbox') {
              const projects = await ticktickService.getTasksFromList(listName); // query to fetch and verify projectId context
              if (projects.length > 0) mappedItem.projectId = projects[0].projectId;
            }
            newEntity = await ticktickService.createTask(mappedItem);
          }

          syncedCount++;

          if (deleteAfterSync) {
            console.log(`[Workflow] DeleteAfterSync active: archiving Notion source page ${page.id}...`);
            await notionService.archiveDatabasePage(page.id);
            deletedCount++;
          } else {
            await saveMapping(page.id, newEntity.id, page.last_edited_time, newEntity.modifiedTime || new Date().toISOString());
          }
        } else {
          // Check modification
          const isNotionModified = new Date(page.last_edited_time).getTime() > new Date(mapping.notionLastEditedTime || 0).getTime() + 15000;
          if (isNotionModified) {
            console.log(`[Workflow] Updating modified Notion page in TickTick: "${mappedItem.title || mappedItem.name}"`);
            // Include the task's own ID in the payload (required by TickTick API)
            mappedItem.id = mapping.ticktickEntityId;
            let updatedEntity;
            if (targetEntity === 'Habits') {
              updatedEntity = await ticktickService.updateHabit(mapping.ticktickEntityId, mappedItem);
            } else {
              updatedEntity = await ticktickService.updateTask(mapping.ticktickEntityId, mappedItem);
            }

            await saveMapping(page.id, mapping.ticktickEntityId, page.last_edited_time, updatedEntity?.modifiedTime || new Date().toISOString());
            syncedCount++;
          }

          if (deleteAfterSync) {
            console.log(`[Workflow] DeleteAfterSync active: archiving Notion source page ${page.id}...`);
            await notionService.archiveDatabasePage(page.id);
            await removeMapping(mapping);
            deletedCount++;
          }
        }
      } catch (err) {
        const title = page.properties.Name?.title?.[0]?.plain_text || 'Untitled';
        console.error(`[Workflow] ❌ Failed to sync Notion page "${title}":`, err.message);
        failedCount++;
      }
    }

    // Deletion propagation: check for pages archived/deleted in Notion
    if (!deleteAfterSync) {
      for (const [notionId, mapping] of notionToMapping.entries()) {
        if (!activeNotionIds.has(notionId)) {
          console.log(`[Workflow] Propagating Notion deletion. Deleting TickTick item: ${mapping.ticktickEntityId}`);
          try {
            if (targetEntity === 'Habits') {
              await ticktickService.deleteHabit(mapping.ticktickEntityId);
            } else {
              // Retrieve projectId from a default lookup or store it
              await ticktickService.deleteTask('inbox', mapping.ticktickEntityId); 
            }
            await removeMapping(mapping);
            deletedCount++;
          } catch (err) {
            console.error(`[Workflow] ❌ Failed to delete TickTick item ${mapping.ticktickEntityId}:`, err.message);
            failedCount++;
          }
        }
      }
    }

  } else if (syncType === 'Bidirectional') {
    // ----------------------------------------------------
    // Bidirectional Sync
    // ----------------------------------------------------
    
    // Phase 1: Propagate Deletions
    for (const [ticktickId, mapping] of ticktickToMapping.entries()) {
      const isTickTickActive = activeTickTickIds.has(ticktickId);
      const isNotionActive = activeNotionIds.has(mapping.notionPageId);

      if (!isTickTickActive && isNotionActive) {
        const notionPage = notionPages.find(p => p.id === mapping.notionPageId);
        if (notionPage && isNotionPageCompleted(notionPage, fieldMappings, config.statusMappings)) {
          console.log(`[Workflow] Bidirectional: Mapped TickTick item ${ticktickId} is completed. Skipping deletion propagation.`);
          continue;
        }

        console.log(`[Workflow] Bidirectional: TickTick item ${ticktickId} was deleted. Archiving Notion page: ${mapping.notionPageId}`);
        try {
          await notionService.archiveDatabasePage(mapping.notionPageId);
          await removeMapping(mapping);
          deletedCount++;
        } catch (err) {
          console.error(`[Workflow] ❌ Failed to archive Notion page ${mapping.notionPageId}:`, err.message);
          failedCount++;
        }
      } else if (isTickTickActive && !isNotionActive) {
        console.log(`[Workflow] Bidirectional: Notion page ${mapping.notionPageId} was deleted. Deleting TickTick item: ${ticktickId}`);
        try {
          const item = ticktickItems.find(t => t.id === ticktickId);
          if (targetEntity === 'Habits') {
            await ticktickService.deleteHabit(ticktickId);
          } else {
            await ticktickService.deleteTask(item?.projectId || 'inbox', ticktickId);
          }
          await removeMapping(mapping);
          deletedCount++;
        } catch (err) {
          console.error(`[Workflow] ❌ Failed to delete TickTick item ${ticktickId}:`, err.message);
          failedCount++;
        }
      } else if (!isTickTickActive && !isNotionActive) {
        // Both deleted, just remove mapping
        await removeMapping(mapping);
      }
    }

    // Refresh maps after deletions
    mappingsSnapshot.forEach(doc => {
      const data = doc.data();
      const mappingDoc = { mappingId: doc.id, ...data };
      notionToMapping.set(data.notionPageId, mappingDoc);
      ticktickToMapping.set(data.ticktickEntityId, mappingDoc);
    });

    // Phase 2: Sync TickTick updates and additions
    for (const item of ticktickItems) {
      try {
        const mapping = ticktickToMapping.get(item.id);
        const { properties, content } = await mapTickTickToNotion(item, fieldMappings, dbSchema, ticktickToMapping, config.statusMappings);
        const checklistState = (item.items || []).map(i => `${i.title}:${i.status}`).join(';');

        if (!mapping) {
          console.log(`[Workflow] Bidirectional: Syncing new TickTick item to Notion: "${item.title || item.name}"`);
          const newPage = await createNotionPage(
            notionService,
            properties,
            content,
            dbSchema,
            item.title || item.name || 'Untitled Sync',
            item.items,
            templateId
          );
          
          const updatedPage = await notionService.client.pages.retrieve({ page_id: newPage.id });
          const newRelationState = computeNotionRelationState(updatedPage);
          await saveMapping(newPage.id, item.id, updatedPage.last_edited_time, item.modifiedTime, checklistState, newRelationState);
          
          syncedCount++;
        } else {
          // Compare modification
          const notionPage = notionPages.find(p => p.id === mapping.notionPageId);
          if (!notionPage) continue; // page missing, deletion phase handles it

          const isTickTickModified = new Date(item.modifiedTime).getTime() > new Date(mapping.ticktickLastModifiedTime || 0).getTime() + 1000;
          const isChecklistChanged = checklistState !== (mapping.ticktickChecklistState || '');
          const isNotionModified = new Date(notionPage.last_edited_time).getTime() > new Date(mapping.notionLastEditedTime || 0).getTime() + 15000;
          // Detect Notion relation changes independently of timestamp debounce
          const currentRelationState = computeNotionRelationState(notionPage);
          const isNotionRelationChanged = currentRelationState !== (mapping.notionRelationState || '');

          // PRIORITY 1: Notion relation changes ALWAYS propagate to TickTick (explicit user intent).
          // Checked first to avoid being blocked by a stale isTickTickModified from a previous sync bounce.
          if (isNotionRelationChanged) {
            console.log(`[Workflow] Bidirectional: Notion relation changed, syncing to TickTick: "${item.title || item.name}"`);
            const mappedItem = await mapNotionToTickTick(notionPage, fieldMappings, targetEntity, notionService, notionToMapping, config.statusMappings);
            // Include TickTick-side identifiers required by the API (not available in Notion)
            mappedItem.id = item.id;
            if (item.projectId) mappedItem.projectId = item.projectId;
            let updatedEntity;
            if (targetEntity === 'Habits') {
              updatedEntity = await ticktickService.updateHabit(item.id, mappedItem);
            } else {
              updatedEntity = await ticktickService.updateTask(item.id, mappedItem);
            }
            const finalChecklistState = (updatedEntity?.items || []).map(i => `${i.title}:${i.status}`).join(';');
            await saveMapping(notionPage.id, item.id, notionPage.last_edited_time, updatedEntity?.modifiedTime || new Date().toISOString(), finalChecklistState, currentRelationState);
            syncedCount++;
          // PRIORITY 2: Conflict — both sides modified by timestamp, compare to resolve
          } else if ((isTickTickModified || isChecklistChanged) && isNotionModified) {
            // Conflict! Compare modification timestamps directly
            const ticktickTime = new Date(item.modifiedTime).getTime();
            const notionTime = new Date(notionPage.last_edited_time).getTime();

            if (ticktickTime >= notionTime) {
              console.log(`[Workflow] Bidirectional Conflict resolved: TickTick wins for "${item.title || item.name}"`);
              await notionService.updateDatabasePage(mapping.notionPageId, properties);
              await updateNotionPageContent(notionService, mapping.notionPageId, content, item.items);
              const updatedPage = await notionService.client.pages.retrieve({ page_id: mapping.notionPageId });
              const updatedRelationState = computeNotionRelationState(updatedPage);
              await saveMapping(mapping.notionPageId, item.id, updatedPage.last_edited_time, item.modifiedTime, checklistState, updatedRelationState);
            } else {
              console.log(`[Workflow] Bidirectional Conflict resolved: Notion wins for "${item.title || item.name}"`);
              const mappedItem = await mapNotionToTickTick(notionPage, fieldMappings, targetEntity, notionService, notionToMapping, config.statusMappings);
              // Include TickTick-side identifiers required by the API (not available in Notion)
              mappedItem.id = item.id;
              if (item.projectId) mappedItem.projectId = item.projectId;
              let updatedEntity;
              if (targetEntity === 'Habits') {
                updatedEntity = await ticktickService.updateHabit(item.id, mappedItem);
              } else {
                updatedEntity = await ticktickService.updateTask(item.id, mappedItem);
              }
              const finalChecklistState = (updatedEntity?.items || []).map(i => `${i.title}:${i.status}`).join(';');
              await saveMapping(notionPage.id, item.id, notionPage.last_edited_time, updatedEntity?.modifiedTime || new Date().toISOString(), finalChecklistState, currentRelationState);
            }
            syncedCount++;
          // PRIORITY 3: Only TickTick changed — push to Notion
          } else if (isTickTickModified || isChecklistChanged) {
            console.log(`[Workflow] Bidirectional: TickTick modified, syncing to Notion: "${item.title || item.name}" (modified=${isTickTickModified}, checklistChanged=${isChecklistChanged})`);
            await notionService.updateDatabasePage(mapping.notionPageId, properties);
            await updateNotionPageContent(notionService, mapping.notionPageId, content, item.items);
            const updatedPage = await notionService.client.pages.retrieve({ page_id: mapping.notionPageId });
            const updatedRelationState = computeNotionRelationState(updatedPage);
            await saveMapping(mapping.notionPageId, item.id, updatedPage.last_edited_time, item.modifiedTime, checklistState, updatedRelationState);
            syncedCount++;
          // PRIORITY 4: Only Notion changed (general timestamp) — push to TickTick
          } else if (isNotionModified) {
            console.log(`[Workflow] Bidirectional: Notion modified, syncing to TickTick: "${item.title || item.name}"`);
            const mappedItem = await mapNotionToTickTick(notionPage, fieldMappings, targetEntity, notionService, notionToMapping, config.statusMappings);
            // Include TickTick-side identifiers required by the API (not available in Notion)
            mappedItem.id = item.id;
            if (item.projectId) mappedItem.projectId = item.projectId;
            let updatedEntity;
            if (targetEntity === 'Habits') {
              updatedEntity = await ticktickService.updateHabit(item.id, mappedItem);
            } else {
              updatedEntity = await ticktickService.updateTask(item.id, mappedItem);
            }
            const finalChecklistState = (updatedEntity?.items || []).map(i => `${i.title}:${i.status}`).join(';');
            await saveMapping(notionPage.id, item.id, notionPage.last_edited_time, updatedEntity?.modifiedTime || new Date().toISOString(), finalChecklistState, currentRelationState);
            syncedCount++;
          }
        }
      } catch (err) {
        console.error(`[Workflow] ❌ Failed bidirectional sync on TickTick item "${item.title || item.name}":`, err.message);
        failedCount++;
      }
    }

    // Phase 3: Sync Notion additions (new unmapped Notion pages)
    for (const page of notionPages) {
      try {
        const mapping = notionToMapping.get(page.id);
        if (!mapping) {
          const mappedItem = await mapNotionToTickTick(page, fieldMappings, targetEntity, notionService, notionToMapping, config.statusMappings);
          console.log(`[Workflow] Bidirectional: Syncing new Notion page to TickTick: "${mappedItem.title || mappedItem.name}"`);
          
          let newEntity;
          if (targetEntity === 'Habits') {
            newEntity = await ticktickService.createHabit(mappedItem);
          } else {
            mappedItem.projectId = listName.toLowerCase() === 'inbox' ? 'inbox' : undefined;
            if (listName.toLowerCase() !== 'inbox') {
              const projects = await ticktickService.getTasksFromList(listName);
              if (projects.length > 0) mappedItem.projectId = projects[0].projectId;
            }
            newEntity = await ticktickService.createTask(mappedItem);
          }

          const finalChecklistState = (newEntity?.items || []).map(i => `${i.title}:${i.status}`).join(';');
          await saveMapping(page.id, newEntity.id, page.last_edited_time, newEntity.modifiedTime || new Date().toISOString(), finalChecklistState);
          syncedCount++;
        }
      } catch (err) {
        const title = page.properties.Name?.title?.[0]?.plain_text || 'Untitled';
        console.error(`[Workflow] ❌ Failed bidirectional sync on Notion page "${title}":`, err.message);
        failedCount++;
      }
    }
  }

  console.log('\n=================== Sync Summary ===================');
  console.log(`  Target Entity       : ${targetEntity}`);
  console.log(`  Sync Direction      : ${syncType}`);
  console.log(`  Successfully Synced : ${syncedCount}`);
  console.log(`  Deleted / Archived  : ${deletedCount}`);
  console.log(`  Failed Actions      : ${failedCount}`);
  console.log('====================================================\n');
  
  if (logRef) {
    try {
      const now = new Date().toISOString();
      await logRef.update({
        status: 'success',
        endTime: now,
        syncedCount,
        deletedCount,
        failedCount
      });
      const { Firestore } = require('@google-cloud/firestore');
      const db = new Firestore();
      await db.collection('workspaces').doc(config.workspaceId).collection('sync_configs').doc(configId).update({ lastRunAt: now }).catch(() => {});
    } catch (e) {
      console.error(`[Workflow] ⚠️ Failed to update execution log or config:`, e.message);
    }
  }
  
  return { syncedCount, deletedCount, failedCount };
  } catch (err) {
    if (logRef) {
      try {
        await logRef.update({
          status: 'error',
          endTime: new Date().toISOString(),
          error: err.message
        });
      } catch (e) {}
    }
    throw err;
  } finally {
    runningConfigs.delete(configId);
  }
}

module.exports = {
  createNotionPage,
  runSyncWorkflow,
  runSyncForConfig,
  updateNotionPageContent,
};
