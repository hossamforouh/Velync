const { Connector } = require('./interface');
const { TickTickService } = require('../../../services/ticktick');
const { register } = require('./registry');

function filterByTag(items, filter = {}) {
  const raw = filter.syncTag ?? filter.tags;
  if (!raw || (Array.isArray(raw) && raw.length === 0) || (!Array.isArray(raw) && !String(raw).trim())) return items;
  const tags = Array.isArray(raw) ? raw.map(t => t.toLowerCase()) : [String(raw).toLowerCase()];
  return items.filter(item => item.tags && item.tags.some(t => tags.includes(t.toLowerCase())));
}

class TickTickConnector extends Connector {
  async connect() {
    const svc = new TickTickService(this.credentials);
    try {
      await svc.authenticate();
      return true;
    } catch {
      return false;
    }
  }

  async fetch(entityType, filter = {}, options = {}) {
    const svc = new TickTickService(this.credentials);
    await svc.authenticate();
    const listName = filter.listName || 'Inbox';
    const since = options.modifiedSince;

    if (entityType === 'Habits') {
      const habits = await svc.getHabits();
      const results = [];
      for (const habit of habits) {
        if (since && habit.modifiedTime && habit.modifiedTime <= since) continue;
        const checkins = await svc.getHabitCheckins(habit.id).catch(() => ({ checkins: [] }));
        results.push({ ...habit, title: habit.name, ...checkins });
      }
      return filterByTag(results, filter);
    }

    const tasks = await svc.getTasksFromList(listName);
    let items;
    if (entityType === 'Notes') {
      items = tasks.filter(t => t.kind === 'NOTE');
    } else {
      items = tasks.filter(t => t.kind !== 'NOTE');
      try {
        const completed = await svc.getCompletedTasksFromList(listName, since ? new Date(since) : null);
        items.push(...completed.filter(t => t.kind !== 'NOTE'));
      } catch {}
    }
    if (since) items = items.filter(t => !t.modifiedTime || t.modifiedTime > since);
    return filterByTag(items, filter);
  }

  async create(entityType, data) {
    const svc = new TickTickService(this.credentials);
    await svc.authenticate();
    if (entityType === 'Habits') return svc.createHabit(data);
    return svc.createTask(data);
  }

  async update(entityType, id, data) {
    const svc = new TickTickService(this.credentials);
    await svc.authenticate();
    if (entityType === 'Habits') return svc.updateHabit(id, data);
    return svc.updateTask(id, data);
  }

  async delete(entityType, id, projectId) {
    const svc = new TickTickService(this.credentials);
    await svc.authenticate();
    if (entityType === 'Habits') return svc.deleteHabit(id);
    return svc.deleteTask(projectId || 'inbox', id);
  }

  getDisplayTitle(item) {
    return item.title || item.name || 'Untitled';
  }

  getEntityTypes() {
    return ['Tasks', 'Notes', 'Habits'];
  }

  getSchema(entityType, context = {}) {
    const base = { title: { type: 'title', label: 'Title' }, tags: { type: 'multi_select', label: 'Tags' } };
    if (entityType === 'Tasks') {
      return { ...base, desc: { type: 'rich_text', label: 'Description' }, status: { type: 'status', label: 'Status' }, priority: { type: 'number', label: 'Priority' }, parentId: { type: 'relation', label: 'Parent' } };
    }
    if (entityType === 'Notes') return { ...base, content: { type: 'rich_text', label: 'Content' } };
    if (entityType === 'Habits') return { name: { type: 'title', label: 'Name' }, type: { type: 'select', label: 'Type' }, goal: { type: 'number', label: 'Goal' } };
    return base;
  }

  async getDataSource(fieldId, context = {}) {
    const svc = new TickTickService(this.credentials);
    await svc.authenticate();
    if (fieldId === 'lists') {
      const projects = await svc.getProjects();
      // TickTick's API has no per-list "this is a task list / note list"
      // flag — a single list can hold both. The Target Entity dropdown
      // (Tasks/Notes) is passed through here as parentValue, and we use
      // the same kind/name heuristic the sync engine itself relies on at
      // fetch time (see fetch(), which splits by t.kind === 'NOTE') so the
      // picker only shows lists relevant to what the user is about to sync
      // — otherwise every list shows regardless of entity type.
      let filtered = projects || [];
      if (context.parentValue) {
        const pValStr = String(context.parentValue).toLowerCase();
        if (pValStr.includes('note')) {
          filtered = filtered.filter(p => p.kind === 'NOTE' || (p.name || '').toLowerCase().includes('note'));
        } else if (pValStr.includes('task')) {
          filtered = filtered.filter(p => p.kind !== 'NOTE' && !(p.name || '').toLowerCase().includes('note'));
        }
      }
      return filtered.map(p => ({ value: p.id || p.name, label: p.name }));
    }
    if (fieldId === 'tags') {
      const tags = await svc.getAllTags();
      return (tags || []).map(t => ({ value: t.id, label: t.name }));
    }
    return [];
  }

  static getDataSources() {
    return [
      { id: 'lists', name: 'TickTick Lists' },
      { id: 'tags', name: 'TickTick Tags' },
    ];
  }
}

register('ticktick', TickTickConnector);
module.exports = TickTickConnector;
