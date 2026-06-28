const { Client } = require('@notionhq/client');
const axios = require('axios');
const FormData = require('form-data');

class NotionService {
  /**
   * Initializes a Notion integration client dynamically.
   * @param {string} notionToken Notion API integration token
   * @param {string} databaseId Target database ID in Notion
   */
  constructor(notionToken, databaseId) {
    this.notionToken = notionToken;
    this.databaseId = databaseId;
    this.client = new Client({
      auth: this.notionToken,
    });
  }

  /**
   * Test the Notion connection by retrieving target database metadata.
   * @returns {Promise<object>} Database metadata
   */
  async testNotionConnection() {
    console.log('[Notion Service] Testing connection by fetching database metadata...');
    
    if (!this.notionToken || this.notionToken.startsWith('secret_your')) {
      throw new Error('Notion token is missing or placeholder.');
    }
    
    if (!this.databaseId || this.databaseId.startsWith('your_notion')) {
      throw new Error('Notion Database ID is missing or placeholder.');
    }

    try {
      const response = await this.client.databases.retrieve({
        database_id: this.databaseId,
      });
      
      // Database title can be a complex array, extract plaintext if available
      const dbTitle = response.title && response.title[0] ? response.title[0].plain_text : 'Untitled';
      console.log(`[Notion Service] Successfully connected! Target Database Title: "${dbTitle}"`);
      return response;
    } catch (error) {
      console.error('[Notion Service] Connection test failed:', error.message);
      throw error;
    }
  }

  /**
   * Retrieves all databases accessible by the integration token.
   * @returns {Promise<Array<{id: string, title: string}>>}
   */
  async listDatabases() {
    console.log('[Notion Service] Listing accessible databases...');
    
    if (!this.notionToken || this.notionToken.startsWith('secret_your')) {
      throw new Error('Notion token is missing or placeholder.');
    }

    try {
      const response = await this.client.search({
        filter: {
          value: 'database',
          property: 'object'
        }
      });
      
      const databases = response.results.map(db => {
        const title = db.title && db.title[0] ? db.title[0].plain_text : 'Untitled Database';
        return {
          id: db.id,
          title: title
        };
      });
      
      console.log(`[Notion Service] Found ${databases.length} databases.`);
      return databases;
    } catch (error) {
      console.error('[Notion Service] Failed to list databases:', error.message);
      throw error;
    }
  }

  /**
   * Creates a new page in the target Notion Database.
   * @param {object} params Parameter object
   * @param {string} params.title The title of the page
   * @param {string} params.status The status value (defaults to "Inbox")
   * @param {string} params.format The format value (defaults to "Note / Idea")
   * @param {Array<string>} params.topics Topics / Tags list
   * @param {string} params.url The URL metadata field
   * @param {string} params.content Description text to insert into the page body
   * @returns {Promise<object>} Created page object
   */
  async createDatabasePage({ title, status = 'Inbox', format = 'Note / Idea', topics = [], url, content }) {
    console.log(`[Notion Service] Creating page in database: "${title}"...`);
    
    try {
      // 1. Fetch current database schema to map multi-select tags case-insensitively
      const dbMetadata = await this.client.databases.retrieve({ database_id: this.databaseId });
      const availableOptions = dbMetadata.properties.Topic?.multi_select?.options || [];
      
      // Map topics to their correctly cased database names, or keep original if not found
      const multiSelectValues = topics.map(topic => {
        const match = availableOptions.find(opt => opt.name.toLowerCase() === topic.toLowerCase());
        return { name: match ? match.name : topic };
      });

      // 2. Prepare block children for the page description/content
      const children = [];

      if (content && content.trim() !== '') {
        const lines = content.split('\n');
        // Regex to match TickTick internal image/attachment references
        const attachmentRegex = /!\[([^\]]*)\]\(([a-f0-9]+\/[^\)]+)\)/gi;

        for (const line of lines) {
          // Remove the attachment markdown, then trim
          const cleanedLine = line.replace(attachmentRegex, '').trim();

          if (cleanedLine !== '') {
            children.push({
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

      // 3. Perform page creation
      const pageProperties = {
        Name: {
          title: [
            {
              type: 'text',
              text: {
                content: title,
              },
            },
          ],
        },
        Status: {
          status: {
            name: status,
          },
        },
        Format: {
          select: {
            name: format,
          },
        },
        Topic: {
          multi_select: multiSelectValues,
        },
      };

      if (url) {
        pageProperties.URL = {
          url: url,
        };
      }

      const response = await this.client.pages.create({
        parent: { database_id: this.databaseId },
        properties: pageProperties,
        children: children.length > 0 ? children.slice(0, 100) : undefined,
      });

      console.log(`[Notion Service] ✅ Successfully created page! Page ID: ${response.id}`);
      return response;
    } catch (error) {
      console.error(`[Notion Service] Failed to create database page:`, error.message);
      throw error;
    }
  }

  /**
   * Retrieves all non-archived pages from the target database.
   * @returns {Promise<Array>} List of pages
   */
  async getDatabasePages() {
    console.log(`[Notion Service] Querying database pages for database ${this.databaseId}...`);
    try {
      let results = [];
      let cursor = undefined;
      let hasMore = true;

      while (hasMore) {
        const response = await this.client.databases.query({
          database_id: this.databaseId,
          start_cursor: cursor,
          page_size: 100,
        });
        results = results.concat(response.results);
        hasMore = response.has_more;
        cursor = response.next_cursor;
      }

      console.log(`[Notion Service] Retrieved ${results.length} pages.`);
      return results;
    } catch (error) {
      console.error(`[Notion Service] Failed to query database pages:`, error.message);
      throw error;
    }
  }

  /**
   * Retrieves the schema (properties) of the configured database.
   * @returns {Promise<object>} Map of property name to property details (type, options, etc.)
   */
  async getDatabaseSchema() {
    console.log(`[Notion Service] Fetching database schema for database ${this.databaseId}...`);
    try {
      const response = await this.client.databases.retrieve({
        database_id: this.databaseId,
      });
      return response.properties;
    } catch (error) {
      console.error(`[Notion Service] Failed to retrieve database schema:`, error.message);
      throw error;
    }
  }

  /**
   * Updates an existing database page's properties.
   * @param {string} pageId The page ID
   * @param {object} properties Notion property updates
   * @returns {Promise<object>} Updated page object
   */
  async updateDatabasePage(pageId, properties) {
    console.log(`[Notion Service] Updating database page ${pageId}...`);
    try {
      const response = await this.client.pages.update({
        page_id: pageId,
        properties: properties,
      });
      return response;
    } catch (error) {
      console.error(`[Notion Service] Failed to update page ${pageId}:`, error.message);
      throw error;
    }
  }

  /**
   * Archives a page (equivalent to deletion in Notion).
   * @param {string} pageId The page ID
   * @returns {Promise<object>} Updated page object
   */
  async archiveDatabasePage(pageId) {
    console.log(`[Notion Service] Archiving page ${pageId}...`);
    try {
      const response = await this.client.pages.update({
        page_id: pageId,
        archived: true,
      });
      return response;
    } catch (error) {
      console.error(`[Notion Service] Failed to archive page ${pageId}:`, error.message);
      throw error;
    }
  }

  /**
   * Retrieves page content blocks and concatenates their plain text.
   * @param {string} pageId The Notion page ID
   * @returns {Promise<string>} Concatenated plain text description/content
   */
  async getPageContentBlocks(pageId) {
    console.log(`[Notion Service] Fetching block children for page ${pageId}...`);
    try {
      const response = await this.client.blocks.children.list({
        block_id: pageId,
      });

      const textBlocks = response.results
        .filter(block => [
          'paragraph',
          'heading_1',
          'heading_2',
          'heading_3',
          'bulleted_list_item',
          'numbered_list_item',
          'quote',
          'callout'
        ].includes(block.type))
        .map(block => {
          const type = block.type;
          const richText = block[type]?.rich_text || [];
          return richText.map(t => t.plain_text).join('');
        });

      return textBlocks.join('\n');
    } catch (error) {
      console.error(`[Notion Service] Failed to retrieve page content for page ${pageId}:`, error.message);
      return '';
    }
  }

  /**
   * Retrieves the internal data_source_id for a database by fetching its metadata.
   * @returns {Promise<string>}
   */
  async getDataSourceId() {
    if (this.dataSourceId) return this.dataSourceId;
    const headers = {
      'Authorization': `Bearer ${this.notionToken}`,
      'Notion-Version': '2026-03-11',
      'Content-Type': 'application/json'
    };
    try {
      const res = await axios.get(`https://api.notion.com/v1/databases/${this.databaseId}`, { headers });
      const dataSources = res.data.data_sources || [];
      this.dataSourceId = dataSources.length > 0 ? dataSources[0].id : this.databaseId;
      return this.dataSourceId;
    } catch (err) {
      console.error('[Notion Service] Failed to retrieve data source ID:', err.message);
      return this.databaseId;
    }
  }

  /**
   * Retrieves the list of available database templates for the database.
   * @returns {Promise<Array<{id: string, name: string, is_default: boolean}>>}
   */
  async listTemplates() {
    const headers = {
      'Authorization': `Bearer ${this.notionToken}`,
      'Notion-Version': '2026-03-11',
      'Content-Type': 'application/json'
    };
    try {
      const dataSourceId = await this.getDataSourceId();
      const res = await axios.get(`https://api.notion.com/v1/data_sources/${dataSourceId}/templates`, { headers });
      return res.data.templates || [];
    } catch (err) {
      console.error('[Notion Service] Failed to list database templates:', err.message);
      throw err;
    }
  }
}

module.exports = {
  NotionService,
};
