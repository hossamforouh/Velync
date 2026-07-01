const axios = require('axios');

/**
 * TickTick API Service Wrapper
 */
class TickTickService {
  /**
   * Initializes a TickTick integration client dynamically.
   * @param {object} credentials The authentication credentials
   * @param {string} credentials.accessToken Pre-generated OAuth Access Token
   * @param {string} credentials.clientId OAuth2 Client ID
   * @param {string} credentials.clientSecret OAuth2 Client Secret
   */
  constructor(credentials = {}) {
    this.accessToken = credentials.accessToken || null;
    this.clientId = credentials.clientId || null;
    this.clientSecret = credentials.clientSecret || null;
    
    this.isUnofficial = false;

    // Official API Base
    this.officialBaseUrl = 'https://api.ticktick.com/open/v1';
    // Unofficial API Base
    this.unofficialBaseUrl = 'https://ticktick.com/api/v2';
  }

  /**
   * Performs authentication.
   * Priority:
   *  1. Pre-configured OAuth Access Token
   *  2. OAuth2 Client Credentials flow (Client ID + Secret)
   */
  async authenticate() {
    // 1. Use pre-configured access token
    if (this.accessToken) {
      console.log('[TickTick Service] Authenticated using pre-configured OAuth Access Token.');
      this.isUnofficial = false;
      return true;
    }

    // 2. OAuth2 Client Credentials (fallback — note: may have limited scope)
    if (this.clientId && this.clientSecret && !this.clientId.startsWith('your_ticktick')) {
      console.log('[TickTick Service] Authenticating via OAuth2 Client Credentials (Client ID + Secret)...');
      try {
        const credentialsBase64 = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
        const response = await axios.post(
          'https://ticktick.com/oauth/token?grant_type=client_credentials',
          {},
          {
            headers: {
              'Authorization': `Basic ${credentialsBase64}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          }
        );

        if (response.data && response.data.access_token) {
          this.accessToken = response.data.access_token;
          this.isUnofficial = false;
          console.log('[TickTick Service] OAuth2 token obtained successfully via Client Credentials.');
          return true;
        } else {
          throw new Error('OAuth2 response did not contain an access_token.');
        }
      } catch (error) {
        const errMsg = error.response?.data?.error_description || error.response?.data?.error || error.message;
        console.error(`[TickTick Service] Client Credentials flow also failed: ${errMsg}`);
        throw new Error(`TickTick authentication failed: ${errMsg}`);
      }
    }

    throw new Error('Authentication failed: No valid credentials provided.');
  }

  /**
   * Fetches all projects (lists) from TickTick.
   * @returns {Promise<Array>} List of project objects with at least id and name
   */
  async getProjects() {
    await this.authenticate();
    const res = await axios.get(`${this.officialBaseUrl}/project`, {
      headers: { 'Authorization': `Bearer ${this.accessToken}` }
    });
    const projects = res.data || [];
    return [{ id: 'inbox', name: 'Inbox' }, ...projects];
  }

  /**
   * Fetches projects filtered by whether they contain a given entity type.
   * Inspects each project's content to determine if it has tasks, notes, or both.
   * @param {string} entityType 'Tasks' | 'Notes' | '' (empty returns all)
   * @returns {Promise<Array>} Array of { id, name } objects
   */
  async getProjectsFiltered(entityType) {
    await this.authenticate();
    const projects = await this.getProjects();
    // Return all projects immediately to avoid 120s timeout and rate limits.
    // TickTick allows creating tasks/notes in any list, so filtering by existing content is unnecessary and slow.
    const mapped = projects.map(p => ({ id: p.id || p.name, name: p.name }));
    
    // Always include 'Inbox' as a valid target for Tasks/Notes if it's not present
    if (!mapped.find(p => p.id === 'inbox' || p.name.toLowerCase() === 'inbox')) {
      mapped.unshift({ id: 'inbox', name: 'Inbox' });
    }
    
    return mapped;
  }

  /**
   * Fetches all unique tags from across all projects.
   * @returns {Promise<Array>} Array of { id, name } objects
   */
  async getAllTags() {
    await this.authenticate();
    const projects = await this.getProjects();
    const tagSet = new Set();
    for (const project of projects) {
      try {
        const taskRes = await axios.get(`${this.officialBaseUrl}/project/${project.id}/data`, {
          headers: { 'Authorization': `Bearer ${this.accessToken}` }
        });
        const tasks = taskRes.data?.tasks || [];
        for (const task of tasks) {
          if (task.tags && Array.isArray(task.tags)) {
            task.tags.forEach(t => tagSet.add(t));
          }
        }
      } catch (err) {
        console.warn(`[TickTick Service] Could not fetch tasks for project "${project.name}":`, err.message);
      }
    }
    return Array.from(tagSet).map(name => ({ id: name, name }));
  }

  /**
   * Fetches uncompleted tasks.
   * @returns {Promise<Array>} List of uncompleted tasks
   */
  async getUncompletedTasks() {
    await this.authenticate();

    if (this.isUnofficial) {
      return this._getUncompletedTasksUnofficial();
    } else {
      return this._getUncompletedTasksOfficial();
    }
  }

  /**
   * Fetches tasks using the official developer API
   */
  async _getUncompletedTasksOfficial() {
    console.log('[TickTick Service] Fetching tasks via official API...');
    try {
      const projectRes = await axios.get(`${this.officialBaseUrl}/project`, {
        headers: { 'Authorization': `Bearer ${this.accessToken}` }
      });

      const projects = projectRes.data;
      let allTasks = [];

      for (const project of projects) {
        try {
          const taskRes = await axios.get(`${this.officialBaseUrl}/project/${project.id}/data`, {
            headers: { 'Authorization': `Bearer ${this.accessToken}` }
          });

          if (taskRes.data && taskRes.data.tasks) {
            const uncompleted = taskRes.data.tasks.filter(t => t.status === 0);
            allTasks = allTasks.concat(uncompleted);
          }
        } catch (err) {
          console.warn(`[TickTick Service] Could not fetch tasks for project "${project.name}":`, err.message);
        }
      }

      console.log(`[TickTick Service] Retrieved ${allTasks.length} uncompleted tasks via official API.`);
      return allTasks;
    } catch (error) {
      console.error('[TickTick Service] Official API call failed:', error.message);
      throw error;
    }
  }

  /**
   * Fetches tasks using the unofficial direct-login API (batch checkout)
   */
  async _getUncompletedTasksUnofficial() {
    console.log('[TickTick Service] Fetching tasks via unofficial batch endpoint...');
    try {
      const response = await axios.get(`${this.unofficialBaseUrl}/batch/check/0`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        }
      });

      const tasks = response.data?.syncTaskBean?.update || [];
      const uncompletedTasks = tasks.filter(t => t.status === 0 && !t.deleted);

      console.log(`[TickTick Service] Retrieved ${uncompletedTasks.length} uncompleted tasks via unofficial API.`);
      return uncompletedTasks;
    } catch (error) {
      console.error('[TickTick Service] Unofficial API call failed:', error.message);
      throw error;
    }
  }

  /**
   * Fetches uncompleted tasks specifically from the Inbox list.
   * @returns {Promise<Array>} List of uncompleted Inbox tasks
   */
  async getInboxTasks() {
    await this.authenticate();
    if (this.isUnofficial) {
      const tasks = await this._getUncompletedTasksUnofficial();
      return tasks.filter(t => t.projectId && t.projectId.startsWith('inbox'));
    } else {
      console.log('[TickTick Service] Fetching Inbox tasks via official API...');
      try {
        const res = await axios.get(`${this.officialBaseUrl}/project/inbox/data`, {
          headers: { 'Authorization': `Bearer ${this.accessToken}` }
        });
        return res.data.tasks ? res.data.tasks.filter(t => t.status === 0) : [];
      } catch (error) {
        console.error('[TickTick Service] Failed to fetch Inbox tasks via official API:', error.message);
        throw error;
      }
    }
  }

  /**
   * Fetches uncompleted tasks from a specific list (project) name.
   * Falls back to Inbox if listName is not found or not specified.
   * @param {string} listName The name of the list
   * @returns {Promise<Array>} List of tasks
   */
  async getTasksFromList(listName) {
    await this.authenticate();
    const normalizedList = (listName || 'Inbox').toLowerCase();

    if (normalizedList === 'inbox') {
      return this.getInboxTasks();
    }

    if (this.isUnofficial) {
      console.log(`[TickTick Service] Querying projects to find list "${listName}" (unofficial)...`);
      try {
        const response = await axios.get(`${this.unofficialBaseUrl}/batch/check/0`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          }
        });
        const projects = response.data?.projectProfiles || [];
        let project = projects.find(p => p.name.toLowerCase() === normalizedList);
        if (!project) {
          project = projects.find(p => p.name.toLowerCase().includes(normalizedList));
        }
        
        if (!project) {
          console.warn(`[TickTick Service] Custom list "${listName}" not found. Falling back to Inbox.`);
          return this.getInboxTasks();
        }

        const tasks = await this._getUncompletedTasksUnofficial();
        return tasks.filter(t => t.projectId === project.id);
      } catch (error) {
        console.error(`[TickTick Service] Failed to fetch custom list "${listName}" (unofficial):`, error.message);
        throw error;
      }
    } else {
      console.log(`[TickTick Service] Querying projects to find list "${listName}" (official)...`);
      try {
        const projectRes = await axios.get(`${this.officialBaseUrl}/project`, {
          headers: { 'Authorization': `Bearer ${this.accessToken}` }
        });

        const projects = projectRes.data;
        let project = projects.find(p => p.name.toLowerCase() === normalizedList);
        if (!project) {
          project = projects.find(p => p.name.toLowerCase().includes(normalizedList));
        }
        
        if (!project) {
          console.warn(`[TickTick Service] Custom list "${listName}" not found. Falling back to Inbox.`);
          return this.getInboxTasks();
        }

        console.log(`[TickTick Service] Fetching tasks for list "${listName}" (ID: ${project.id}) via official API...`);
        const taskRes = await axios.get(`${this.officialBaseUrl}/project/${project.id}/data`, {
          headers: { 'Authorization': `Bearer ${this.accessToken}` }
        });

        return taskRes.data.tasks ? taskRes.data.tasks.filter(t => t.status === 0) : [];
      } catch (error) {
        console.error(`[TickTick Service] Failed to fetch tasks for list "${listName}" via official API:`, error.message);
        throw error;
      }
    }
  }

  /**
   * Fetches completed tasks for a list/project.
   * @param {string} listName Name of the list/project
   * @param {Date} sinceDate Optional start date to fetch completed tasks from
   * @returns {Promise<Array>} List of completed tasks
   */
  async getCompletedTasksFromList(listName, sinceDate = null) {
    await this.authenticate();
    if (this.isUnofficial) {
      console.warn('[TickTick Service] Fetching completed tasks is not supported in unofficial API mode.');
      return [];
    }

    const normalizedList = (listName || 'Inbox').toLowerCase();
    
    // Resolve project ID first
    let projectId = 'inbox';
    if (normalizedList !== 'inbox') {
      const projectRes = await axios.get(`${this.officialBaseUrl}/project`, {
        headers: { 'Authorization': `Bearer ${this.accessToken}` }
      });
      const projects = projectRes.data;
      let project = projects.find(p => p.name.toLowerCase() === normalizedList);
      if (!project) {
        project = projects.find(p => p.name.toLowerCase().includes(normalizedList));
      }
      if (!project) {
        console.warn(`[TickTick Service] Custom list "${listName}" not found for completed tasks. Falling back to Inbox.`);
      } else {
        projectId = project.id;
      }
    }

    // Prepare payload
    const payload = { projectIds: [projectId] };
    if (sinceDate) {
      payload.startDate = sinceDate.toISOString();
    } else {
      // Default to 30 days ago
      const defaultDate = new Date();
      defaultDate.setDate(defaultDate.getDate() - 30);
      payload.startDate = defaultDate.toISOString();
    }

    try {
      console.log(`[TickTick Service] Fetching completed tasks for list "${listName}" (project ID: ${projectId}) since ${payload.startDate} via official API...`);
      const response = await axios.post(`${this.officialBaseUrl}/task/completed`, payload, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      return response.data || [];
    } catch (error) {
      console.error(`[TickTick Service] Failed to fetch completed tasks for list "${listName}":`, error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Deletes a task from a project.
   * @param {string} projectId Project ID of the task
   * @param {string} taskId Task ID to delete
   */
  /**
   * Deletes a task from a project.
   * @param {string} projectId Project ID of the task
   * @param {string} taskId Task ID to delete
   */
  async deleteTask(projectId, taskId) {
    await this.authenticate();
    if (this.isUnofficial) {
      throw new Error('Task deletion is only supported in official API mode.');
    } else {
      console.log(`[TickTick Service] Deleting task ${taskId} from project ${projectId}...`);
      try {
        await axios.delete(`${this.officialBaseUrl}/project/${projectId}/task/${taskId}`, {
          headers: { 'Authorization': `Bearer ${this.accessToken}` }
        });
        console.log(`[TickTick Service] ✅ Task ${taskId} successfully deleted.`);
      } catch (error) {
        console.error(`[TickTick Service] Failed to delete task ${taskId}:`, error.message);
        throw error;
      }
    }
  }

  /**
   * Creates a new task.
   * @param {object} taskData The task properties
   * @returns {Promise<object>} Created task object
   */
  async createTask(taskData) {
    await this.authenticate();
    console.log(`[TickTick Service] Creating new task: "${taskData.title}"...`);
    try {
      const parentId = taskData.parentId;
      const createPayload = { ...taskData };
      delete createPayload.parentId;

      const response = await axios.post(`${this.officialBaseUrl}/task`, createPayload, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      
      let createdTask = response.data;
      if (parentId) {
        console.log(`[TickTick Service] Task created. Setting parentId ${parentId} via update...`);
        createdTask = await this.updateTask(createdTask.id, {
          id: createdTask.id,
          projectId: createdTask.projectId,
          title: createdTask.title,
          parentId: parentId
        });
      }
      return createdTask;
    } catch (error) {
      console.error('[TickTick Service] Failed to create task:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Updates an existing task.
   * @param {string} taskId Task ID to update
   * @param {object} taskData The updated task properties
   * @returns {Promise<object>} Updated task object
   */
  async updateTask(taskId, taskData) {
    await this.authenticate();
    console.log(`[TickTick Service] Updating task ${taskId}...`);
    try {
      const response = await axios.post(`${this.officialBaseUrl}/task/${taskId}`, taskData, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      return response.data;
    } catch (error) {
      console.error(`[TickTick Service] Failed to update task ${taskId}:`, error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Fetches all habits.
   * @returns {Promise<Array>} List of habits
   */
  async getHabits() {
    await this.authenticate();
    console.log('[TickTick Service] Fetching habits...');
    try {
      const response = await axios.get(`${this.officialBaseUrl}/habit`, {
        headers: { 'Authorization': `Bearer ${this.accessToken}` }
      });
      return response.data || [];
    } catch (error) {
      console.error('[TickTick Service] Failed to fetch habits:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Fetches habit check-in history.
   * @param {string} habitId The Habit ID
   * @returns {Promise<object>} Check-in records object
   */
  async getHabitCheckins(habitId) {
    await this.authenticate();
    console.log(`[TickTick Service] Fetching check-ins for habit: ${habitId}...`);
    try {
      const response = await axios.get(`${this.officialBaseUrl}/habit/${habitId}/checkin`, {
        headers: { 'Authorization': `Bearer ${this.accessToken}` }
      });
      return response.data || {};
    } catch (error) {
      console.error(`[TickTick Service] Failed to fetch check-ins for habit ${habitId}:`, error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Creates a new habit.
   * @param {object} habitData The habit properties
   * @returns {Promise<object>} Created habit object
   */
  async createHabit(habitData) {
    await this.authenticate();
    console.log(`[TickTick Service] Creating new habit: "${habitData.name}"...`);
    try {
      const response = await axios.post(`${this.officialBaseUrl}/habit`, habitData, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      return response.data;
    } catch (error) {
      console.error('[TickTick Service] Failed to create habit:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Updates an existing habit.
   * @param {string} habitId Habit ID to update
   * @param {object} habitData Updated habit properties
   * @returns {Promise<object>} Updated habit object
   */
  async updateHabit(habitId, habitData) {
    await this.authenticate();
    console.log(`[TickTick Service] Updating habit ${habitId}...`);
    try {
      // API typically supports POST or PUT. We will use POST matching task updates
      const response = await axios.post(`${this.officialBaseUrl}/habit/${habitId}`, habitData, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      return response.data;
    } catch (error) {
      console.error(`[TickTick Service] Failed to update habit ${habitId}:`, error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Deletes (or archives) a habit.
   * @param {string} habitId Habit ID to delete
   */
  async deleteHabit(habitId) {
    await this.authenticate();
    console.log(`[TickTick Service] Deleting/archiving habit ${habitId}...`);
    try {
      // First attempt DELETE
      await axios.delete(`${this.officialBaseUrl}/habit/${habitId}`, {
        headers: { 'Authorization': `Bearer ${this.accessToken}` }
      });
      console.log(`[TickTick Service] ✅ Habit ${habitId} deleted successfully via DELETE.`);
    } catch (error) {
      console.warn(`[TickTick Service] DELETE habit failed or unsupported (${error.message}). Attempting status: 0 archive update...`);
      try {
        // Fallback to update status: 0 (archived/disabled)
        await this.updateHabit(habitId, { status: 0 });
        console.log(`[TickTick Service] ✅ Habit ${habitId} successfully archived (status: 0).`);
      } catch (fallbackError) {
        console.error(`[TickTick Service] Failed to delete or archive habit ${habitId}:`, fallbackError.message);
        throw fallbackError;
      }
    }
  }

}

module.exports = {
  TickTickService,
};
