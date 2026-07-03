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

  async fetch(entityType, filter = {}) {
    const svc = new TickTickService(this.credentials);
    await svc.authenticate();
    const listName = filter.listName || 'Inbox';

    if (entityType === 'Habits') {
      const habits = await svc.getHabits();
      const results = [];
      for (const habit of habits) {
        const checkins = await svc.getHabitCheckins(habit.id).catch(() => ({ checkins: [] }));
        results.push({ ...habit, title: habit.name, ...checkins });
      }
      return filterByTag(results, filter);
    }

    const tasks = await svc.getTasksFromList(listName);
    if (entityType === 'Notes') return filterByTag(tasks.filter(t => t.kind === 'NOTE'), filter);
    const items = tasks.filter(t => t.kind !== 'NOTE');
    try {
      const completed = await svc.getCompletedTasksFromList(listName);
      items.push(...completed.filter(t => t.kind !== 'NOTE'));
    } catch {}
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
      return (projects || []).map(p => ({ value: p.id || p.name, label: p.name }));
    }
    return [];
  }
}

register('ticktick', TickTickConnector);
module.exports = TickTickConnector;
