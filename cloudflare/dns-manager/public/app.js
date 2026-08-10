const state = {
  records: [],
  meta: {},
  actions: []
};

const $ = selector => document.querySelector(selector);

const views = {
  login: $('#loginView'),
  dashboard: $('#dashboard')
};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  bindEvents();
  const session = await api('/api/session', { quiet: true });
  if (session?.authenticated) {
    showDashboard();
    await loadInitialData();
  } else {
    showLogin();
  }
}

function bindEvents() {
  $('#loginForm').addEventListener('submit', onLogin);
  $('#logoutBtn').addEventListener('click', onLogout);
  $('#refreshBtn').addEventListener('click', loadRecords);
  $('#searchBtn').addEventListener('click', loadRecords);
  $('#newRecordBtn').addEventListener('click', () => openRecordDialog());
  $('#recordForm').addEventListener('submit', saveRecord);
  $('#closeDialogBtn').addEventListener('click', closeRecordDialog);
  $('#cancelDialogBtn').addEventListener('click', closeRecordDialog);
  $('#actionForm').addEventListener('submit', callAdvancedAction);
}

async function onLogin(event) {
  event.preventDefault();
  $('#loginError').textContent = '';
  try {
    await api('/api/login', {
      method: 'POST',
      body: { password: $('#password').value }
    });
    showDashboard();
    await loadInitialData();
  } catch (error) {
    $('#loginError').textContent = error.message;
  }
}

async function onLogout() {
  await api('/api/logout', { method: 'POST', quiet: true });
  state.records = [];
  showLogin();
}

function showLogin() {
  views.login.classList.remove('hidden');
  views.dashboard.classList.add('hidden');
}

function showDashboard() {
  views.login.classList.add('hidden');
  views.dashboard.classList.remove('hidden');
}

async function loadInitialData() {
  const [meta, actions] = await Promise.all([
    api('/api/dns/meta'),
    api('/api/dns/actions')
  ]);
  state.meta = meta;
  state.actions = actions.actions || [];
  renderMeta();
  renderActionOptions();
  await loadRecords();
}

async function loadRecords() {
  const params = new URLSearchParams();
  const keyword = $('#keyword').value.trim();
  const type = $('#recordTypeFilter').value;
  const status = $('#statusFilter').value;
  if (keyword) params.set('Keyword', keyword);
  if (type) params.set('RecordType', type);
  if (status) params.set('Status', status);
  params.set('Limit', '100');
  const data = await api(`/api/dns/records?${params.toString()}`);
  state.records = normalizeRecords(data);
  renderRecords();
}

function normalizeRecords(data) {
  return data.RecordList || data.RecordListInfo?.RecordList || data.Records || [];
}

function renderRecords() {
  $('#recordCount').textContent = state.records.length;
  const body = $('#recordsBody');
  body.innerHTML = '';
  if (!state.records.length) {
    body.innerHTML = '<tr><td colspan="9">暂无解析记录</td></tr>';
    return;
  }

  for (const record of state.records) {
    const id = record.RecordId || record.RecordId?.toString?.() || record.id;
    const status = normalizeStatus(record.Status ?? record.Enabled);
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${escapeHtml(record.Name || record.SubDomain || '@')}</td>
      <td>${escapeHtml(record.Type || record.RecordType || '')}</td>
      <td>${escapeHtml(record.Line || record.RecordLine || record.Area || '默认')}</td>
      <td class="value" title="${escapeHtml(record.Value || '')}">${escapeHtml(record.Value || '')}</td>
      <td>${escapeHtml(record.TTL || '')}</td>
      <td>${escapeHtml(record.MX ?? '')}</td>
      <td>${escapeHtml(record.Weight ?? '')}</td>
      <td class="${status === 'ENABLE' ? 'status-enable' : 'status-disable'}">${status === 'ENABLE' ? '启用' : '暂停'}</td>
      <td>
        <div class="row-actions">
          <button type="button" data-action="edit">编辑</button>
          <button type="button" data-action="toggle">${status === 'ENABLE' ? '暂停' : '启用'}</button>
          <button type="button" data-action="delete" class="danger">删除</button>
        </div>
      </td>
    `;
    row.querySelector('[data-action="edit"]').addEventListener('click', () => openRecordDialog(record));
    row.querySelector('[data-action="toggle"]').addEventListener('click', () => toggleStatus(id, status));
    row.querySelector('[data-action="delete"]').addEventListener('click', () => deleteRecord(id, record));
    body.append(row);
  }
}

function renderMeta() {
  const domain = state.meta.domain?.DomainInfo || state.meta.domain || {};
  $('#domainInfo').innerHTML = [
    ['域名', domain.Domain || 'open-world.cn'],
    ['套餐', domain.GradeTitle || domain.Grade || '-'],
    ['状态', domain.Status || '-'],
    ['记录数', domain.RecordCount || domain.RecordTotal || '-'],
    ['所有者', domain.Owner || '-']
  ].map(([key, value]) => `<dt>${key}</dt><dd>${escapeHtml(value)}</dd>`).join('');

  const types = state.meta.recordTypes?.TypeList || ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA'];
  fillOptions($('#recordType'), types);
  fillOptions($('#recordTypeFilter'), ['', ...types], ['全部类型']);
}

function renderActionOptions() {
  fillOptions($('#apiAction'), state.actions);
}

function fillOptions(select, values, labels = []) {
  select.innerHTML = '';
  values.forEach((value, index) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = labels[index] || value;
    select.append(option);
  });
}

function openRecordDialog(record = null) {
  $('#recordDialogTitle').textContent = record ? '修改解析' : '新增解析';
  $('#recordId').value = record?.RecordId || '';
  $('#subDomain').value = record?.Name || record?.SubDomain || '';
  $('#recordType').value = record?.Type || record?.RecordType || 'A';
  $('#recordLine').value = record?.Line || record?.RecordLine || record?.Area || '默认';
  $('#recordValue').value = record?.Value || '';
  $('#ttl').value = record?.TTL || 600;
  $('#mx').value = record?.MX ?? 0;
  $('#weight').value = record?.Weight ?? '';
  $('#recordStatus').value = normalizeStatus(record?.Status ?? record?.Enabled);
  $('#remark').value = record?.Remark || '';
  $('#recordError').textContent = '';
  $('#recordDialog').showModal();
}

function closeRecordDialog() {
  $('#recordDialog').close();
}

async function saveRecord(event) {
  event.preventDefault();
  $('#recordError').textContent = '';
  const id = $('#recordId').value;
  const payload = {
    SubDomain: $('#subDomain').value.trim(),
    RecordType: $('#recordType').value,
    RecordLine: $('#recordLine').value.trim() || '默认',
    Value: $('#recordValue').value.trim(),
    TTL: numberOrEmpty($('#ttl').value),
    MX: numberOrEmpty($('#mx').value),
    Weight: numberOrEmpty($('#weight').value),
    Status: $('#recordStatus').value,
    Remark: $('#remark').value.trim()
  };

  try {
    await api(id ? `/api/dns/records/${id}` : '/api/dns/records', {
      method: id ? 'PUT' : 'POST',
      body: payload
    });
    closeRecordDialog();
    await loadRecords();
  } catch (error) {
    $('#recordError').textContent = error.message;
  }
}

async function toggleStatus(id, status) {
  await api(`/api/dns/records/${id}/status`, {
    method: 'PATCH',
    body: { Status: status === 'ENABLE' ? 'DISABLE' : 'ENABLE' }
  });
  await loadRecords();
}

async function deleteRecord(id, record) {
  const label = `${record.Name || record.SubDomain || '@'} ${record.Type || record.RecordType || ''} ${record.Value || ''}`;
  if (!confirm(`确认删除解析记录？\n${label}`)) return;
  await api(`/api/dns/records/${id}`, { method: 'DELETE' });
  await loadRecords();
}

async function callAdvancedAction(event) {
  event.preventDefault();
  $('#apiResult').textContent = '';
  try {
    const payload = JSON.parse($('#apiPayload').value || '{}');
    const result = await api('/api/dns/action', {
      method: 'POST',
      body: {
        Action: $('#apiAction').value,
        Payload: payload
      }
    });
    $('#apiResult').textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    $('#apiResult').textContent = error.message;
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    credentials: 'include',
    headers: options.body ? { 'content-type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !options.quiet) showLogin();
    throw new Error(data.error || `请求失败：HTTP ${response.status}`);
  }
  return data;
}

function normalizeStatus(value) {
  if (value === 1 || value === '1' || String(value).toUpperCase() === 'ENABLE') return 'ENABLE';
  return 'DISABLE';
}

function numberOrEmpty(value) {
  return value === '' ? '' : Number(value);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}
