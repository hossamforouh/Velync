require('dotenv').config();
const { Firestore } = require('@google-cloud/firestore');
const { NotionService } = require('./services/notion');
const { resolveConnectionTokens } = require('./src/domains/connection/resolver');

const db = new Firestore();

async function run() {
  try {
    // 1. Find the connection "My Notion 3"
    const snap = await db.collection('connected_accounts')
                         .where('provider', '==', 'notion')
                         .get();
                         
    if (snap.empty) {
      console.error('No Notion connections found.');
      return;
    }
    
    console.log('Available Notion Connections:');
    snap.docs.forEach(d => console.log(`- ${d.data().label} (id: ${d.id})`));
    
    // Use the first one or match "My Notion (3)"
    const connDoc = snap.docs.find(d => d.data().label?.includes('My Notion')) || snap.docs[0];
    
    const connId = connDoc.id;
    const uid = connDoc.data().userId;
    
    console.log(`Found connection: ${connId} (userId: ${uid})`);
    
    const creds = await resolveConnectionTokens(uid, connId);
    console.log(`Token acquired. Length: ${creds.accessToken.length}`);
    
    const { Client } = require('@notionhq/client');
    const client = new Client({ auth: creds.accessToken });
    
    // 2. Run search
    console.log('\n--- Running Search ---');
    const searchRes = await client.search({});
    console.log(`Search returned ${searchRes.results.length} items.`);
    searchRes.results.forEach(res => {
      let title = 'Untitled';
      if (res.object === 'database' && res.title?.[0]) title = res.title[0].plain_text;
      if (res.object === 'page') {
         const tProp = res.properties?.title || res.properties?.Name;
         if (tProp?.title?.[0]) title = tProp.title[0].plain_text;
      }
      console.log(`- [${res.object}] ${title} (id: ${res.id})`);
    });
    
    // 3. Find the 'Vaults' page ID
    const vaultsPage = searchRes.results.find(r => {
      const tProp = r.properties?.title || r.properties?.Name;
      return tProp?.title?.[0]?.plain_text === 'Vaults';
    });
    
    if (!vaultsPage) {
      console.log('Vaults page not found in search results. Checking all pages.');
      return;
    }
    
    console.log(`\n--- Fetching block children for Vaults (${vaultsPage.id}) ---`);
    
    // 4. Recursive block fetcher
    async function printBlocks(blockId, depth = 0) {
      const indent = '  '.repeat(depth);
      let cursor = undefined;
      let hasMore = true;
      while (hasMore) {
        const blocks = await client.blocks.children.list({ block_id: blockId, start_cursor: cursor, page_size: 100 });
        for (const block of blocks.results) {
          let extra = '';
          if (block.type === 'child_database') extra = ` -> title: ${block.child_database.title}`;
          if (block.type === 'child_page') extra = ` -> title: ${block.child_page.title}`;
          console.log(`${indent}- [${block.type}] (id: ${block.id})${extra}`);
          
          if (block.has_children) {
            await printBlocks(block.id, depth + 1);
          }
        }
        hasMore = blocks.has_more;
        cursor = blocks.next_cursor;
      }
    }
    
    await printBlocks(vaultsPage.id);
    
  } catch (err) {
    console.error('Error:', err);
  }
}

run();
