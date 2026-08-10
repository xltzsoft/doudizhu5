import {
  DNSPOD_ALLOWED_ACTIONS,
  MANAGED_DOMAIN,
  buildRecordPayload,
  callDnsPod,
  guardOpenWorldDomain,
  normalizeApiAction
} from '../../src/tencent-dnspod.js';
import {
  clearSessionCookie,
  createSessionToken,
  getSessionToken,
  sessionCookie,
  verifySessionToken
} from '../../src/session.js';

const SESSION_SECONDS = 12 * 60 * 60;

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const path = catchAllPath(context.params.path);
  const method = context.request.method.toUpperCase();

  try {
    if (method === 'POST' && path === '/login') return login(context.request, context.env);
    if (method === 'POST' && path === '/logout') return json({ success: true }, 200, { 'Set-Cookie': clearSessionCookie() });
    if (method === 'GET' && path === '/session') return requireAuth(context, () => json({ authenticated: true, domain: MANAGED_DOMAIN }));

    return requireAuth(context, () => routeDnsRequest(context, method, path, url));
  } catch (error) {
    return json({ error: error.message || '服务异常' }, 500);
  }
}

function catchAllPath(value) {
  if (Array.isArray(value)) return `/${value.join('/')}`;
  if (typeof value === 'string' && value) return `/${value}`;
  return '/';
}

async function routeDnsRequest(context, method, path, url) {
  if (method === 'GET' && path === '/dns/actions') {
    return json({
      domain: MANAGED_DOMAIN,
      actions: [...DNSPOD_ALLOWED_ACTIONS].sort()
    });
  }

  if (method === 'GET' && path === '/dns/meta') {
    return json(await loadMeta(context.env));
  }

  if (method === 'GET' && path === '/dns/records') {
    const payload = searchParamsToPayload(url.searchParams);
    payload.Domain = MANAGED_DOMAIN;
    payload.Limit = clampInteger(payload.Limit, 1, 300, 100);
    payload.Offset = clampInteger(payload.Offset, 0, 100000, 0);
    return json(await callDnsPod(context.env, 'DescribeRecordList', payload));
  }

  if (method === 'POST' && path === '/dns/records') {
    const payload = buildRecordPayload(await readJson(context.request), false);
    return json(await callDnsPod(context.env, 'CreateRecord', payload));
  }

  const recordMatch = path.match(/^\/dns\/records\/(\d+)(?:\/(status|remark|fields))?$/);
  if (recordMatch) {
    const recordId = Number(recordMatch[1]);
    const subAction = recordMatch[2] || '';
    if (method === 'GET' && !subAction) {
      return json(await callDnsPod(context.env, 'DescribeRecord', { Domain: MANAGED_DOMAIN, RecordId: recordId }));
    }
    if ((method === 'PUT' || method === 'PATCH') && !subAction) {
      const payload = buildRecordPayload({ ...await readJson(context.request), RecordId: recordId }, true);
      return json(await callDnsPod(context.env, 'ModifyRecord', payload));
    }
    if (method === 'DELETE' && !subAction) {
      return json(await callDnsPod(context.env, 'DeleteRecord', { Domain: MANAGED_DOMAIN, RecordId: recordId }));
    }
    if (method === 'PATCH' && subAction === 'status') {
      const body = await readJson(context.request);
      return json(await callDnsPod(context.env, 'ModifyRecordStatus', {
        Domain: MANAGED_DOMAIN,
        RecordId: recordId,
        Status: String(body.Status || body.status || '').toUpperCase()
      }));
    }
    if (method === 'PATCH' && subAction === 'remark') {
      const body = await readJson(context.request);
      return json(await callDnsPod(context.env, 'ModifyRecordRemark', {
        Domain: MANAGED_DOMAIN,
        RecordId: recordId,
        Remark: String(body.Remark ?? body.remark ?? '')
      }));
    }
    if (method === 'PATCH' && subAction === 'fields') {
      const payload = guardOpenWorldDomain('ModifyRecordFields', { ...await readJson(context.request), Domain: MANAGED_DOMAIN, RecordId: recordId });
      return json(await callDnsPod(context.env, 'ModifyRecordFields', payload));
    }
  }

  if (method === 'POST' && path === '/dns/action') {
    const body = await readJson(context.request);
    const action = normalizeApiAction(body.Action || body.action);
    const payload = guardOpenWorldDomain(action, body.Payload || body.payload || {});
    return json(await callDnsPod(context.env, action, payload));
  }

  return json({ error: '接口不存在' }, 404);
}

async function login(request, env) {
  const body = await readJson(request);
  const password = String(body.password || '');
  if (!env.ADMIN_PASSWORD || password !== env.ADMIN_PASSWORD) {
    return json({ error: '密码错误' }, 401);
  }
  const token = await createSessionToken(env.SESSION_SECRET || env.ADMIN_PASSWORD, SESSION_SECONDS);
  return json(
    { success: true, domain: MANAGED_DOMAIN },
    200,
    { 'Set-Cookie': sessionCookie(token, SESSION_SECONDS) }
  );
}

async function requireAuth(context, handler) {
  const token = getSessionToken(context.request);
  const ok = await verifySessionToken(context.env.SESSION_SECRET || context.env.ADMIN_PASSWORD, token);
  if (!ok) return json({ error: '未登录或会话已过期' }, 401);
  return handler();
}

async function loadMeta(env) {
  const calls = [
    ['domain', 'DescribeDomain', { Domain: MANAGED_DOMAIN }],
    ['recordTypes', 'DescribeRecordType', { DomainGrade: 'DP_FREE' }],
    ['recordLines', 'DescribeRecordLineList', { Domain: MANAGED_DOMAIN, DomainGrade: 'DP_FREE' }],
    ['recordLineCategories', 'DescribeRecordLineCategoryList', { Domain: MANAGED_DOMAIN }],
    ['recordGroups', 'DescribeRecordGroupList', { Domain: MANAGED_DOMAIN }],
    ['purview', 'DescribeDomainPurview', { Domain: MANAGED_DOMAIN }]
  ];
  const settled = await Promise.allSettled(calls.map(([, action, payload]) => callDnsPod(env, action, payload)));
  return calls.reduce((result, [key], index) => {
    const item = settled[index];
    result[key] = item.status === 'fulfilled' ? item.value : { error: item.reason?.message || '加载失败' };
    return result;
  }, { domain: MANAGED_DOMAIN });
}

function searchParamsToPayload(searchParams) {
  const payload = {};
  for (const [key, value] of searchParams.entries()) {
    if (value === '') continue;
    const normalizedKey = key.slice(0, 1).toUpperCase() + key.slice(1);
    payload[normalizedKey] = /^\d+$/.test(value) ? Number(value) : value;
  }
  return payload;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

async function readJson(request) {
  if (!request.headers.get('content-type')?.includes('application/json')) return {};
  return request.json();
}

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers
    }
  });
}
