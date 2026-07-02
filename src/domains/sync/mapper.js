function mapSourceToDest(sourceItem, fieldMappings, sourceSchema, destSchema, statusMappings = null) {
  const properties = {};
  let content = '';

  for (const m of fieldMappings) {
    const { sourceField, destField } = m;
    if (!sourceField || !destField) continue;

    let value = sourceItem[sourceField];
    if (sourceField === 'title' && !value && sourceItem.name) value = sourceItem.name;
    if ((sourceField === 'desc' || sourceField === 'content') && !value) value = sourceItem.desc || sourceItem.content || '';
    if (destField === '__content__') { content = value ? String(value) : ''; continue; }

    const destProp = destSchema[destField];
    if (!destProp) continue;
    if (value === undefined || value === null) continue;

    switch (destProp.type) {
      case 'title':
        properties[destField] = { title: [{ type: 'text', text: { content: String(value).substring(0, 2000) } }] };
        break;
      case 'rich_text':
        properties[destField] = { rich_text: [{ type: 'text', text: { content: String(value).substring(0, 2000) } }] };
        break;
      case 'number':
        properties[destField] = { number: Number(value) };
        break;
      case 'checkbox':
        properties[destField] = { checkbox: Boolean(value) };
        break;
      case 'url':
        properties[destField] = { url: String(value) };
        break;
      case 'select':
        properties[destField] = { select: { name: String(value).substring(0, 100) } };
        break;
      case 'status': {
        const statusOptions = destProp.status?.options || [];
        const numVal = Number(value);
        let mappedName;
        if (statusMappings && statusMappings.incompleteDefault && statusMappings.completeDefault) {
          mappedName = numVal === 2 ? statusMappings.completeDefault : statusMappings.incompleteDefault;
        } else {
          if (numVal === 2) {
            const match = statusOptions.find(o => ['completed', 'complete', 'done'].includes(o.name.toLowerCase()));
            mappedName = match ? match.name : (statusOptions.find(o => o.color === 'green')?.name || 'Completed');
          } else {
            const match = statusOptions.find(o => ['not started', 'to-do', 'todo'].includes(o.name.toLowerCase()));
            mappedName = match ? match.name : (statusOptions[0]?.name || 'Not Started');
          }
        }
        properties[destField] = { status: { name: mappedName } };
        break;
      }
      case 'multi_select': {
        let tags = Array.isArray(value) ? value : String(value).split(',').map(t => t.trim()).filter(Boolean);
        const options = destProp.multi_select?.options || [];
        properties[destField] = { multi_select: tags.map(tag => {
          const match = options.find(o => o.name.toLowerCase() === tag.toLowerCase());
          return { name: match ? match.name : tag };
        })};
        break;
      }
      case 'date':
        try { properties[destField] = { date: { start: new Date(value).toISOString() } }; } catch {}
        break;
    }
  }
  return { properties, content };
}

module.exports = { mapSourceToDest };
