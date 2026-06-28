document.addEventListener('DOMContentLoaded', () => {
  const logsTbody = document.getElementById('logs-tbody');

  // Dummy mock data for execution logs
  const mockLogs = [
    {
      timestamp: new Date().toISOString(),
      integration: 'TickTick → Notion',
      status: 'success',
      details: 'Synced 12 new tasks successfully.'
    },
    {
      timestamp: new Date(Date.now() - 15 * 60000).toISOString(),
      integration: 'TickTick → Notion',
      status: 'failed',
      details: 'Failed to sync: Target database page in Notion was deleted or is inaccessible.'
    },
    {
      timestamp: new Date(Date.now() - 30 * 60000).toISOString(),
      integration: 'TickTick → Notion',
      status: 'success',
      details: 'Synced 3 updated tasks.'
    },
    {
      timestamp: new Date(Date.now() - 45 * 60000).toISOString(),
      integration: 'TickTick → Notion',
      status: 'success',
      details: 'No changes detected.'
    }
  ];

  function renderLogs() {
    if (!logsTbody) return;
    logsTbody.innerHTML = '';

    mockLogs.forEach(log => {
      const tr = document.createElement('tr');
      
      const dateObj = new Date(log.timestamp);
      const timeStr = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const dateStr = dateObj.toLocaleDateString();

      let statusBadge = '';
      if (log.status === 'success') {
        statusBadge = '<span class="badge badge-success">Success</span>';
      } else {
        statusBadge = '<span class="badge badge-failed">Failed</span>';
      }

      tr.innerHTML = `
        <td style="color: rgba(255,255,255,0.6);">${dateStr} ${timeStr}</td>
        <td style="font-weight: 500;">${log.integration}</td>
        <td>${statusBadge}</td>
        <td style="color: rgba(255,255,255,0.8);">${log.details}</td>
      `;
      logsTbody.appendChild(tr);
    });
  }

  // Initial render
  renderLogs();
});
