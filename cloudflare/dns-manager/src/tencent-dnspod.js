const DNSPOD_HOST = 'dnspod.tencentcloudapi.com';
const DNSPOD_SERVICE = 'dnspod';
const DNSPOD_VERSION = '2021-03-23';
export const MANAGED_DOMAIN = 'open-world.cn';

const DOMAINLESS_ACTIONS = new Set([
  'DescribeDomainList'
]);

const GRADE_ONLY_ACTIONS = new Set([
  'DescribeRecordType'
]);

const DOMAIN_AND_GRADE_ACTIONS = new Set([
  'DescribeRecordLineList'
]);

const DOMAIN_REQUIRED_ACTIONS = new Set([
  'DescribeDomain',
  'DescribeDomainLogList',
  'DescribeDomainPurview',
  'DescribeDomainShareInfo',
  'DescribeRecord',
  'DescribeRecordExistExceptDefaultNS',
  'DescribeRecordFilterList',
  'DescribeRecordGroupList',
  'DescribeRecordLineCategoryList',
  'DescribeRecordList',
  'DescribeRecordSnapshotRollbackResult',
  'DescribeSubdomainAnalytics',
  'DescribeSubdomainValidateStatus',
  'CreateRecord',
  'CreateRecordBatch',
  'CreateRecordGroup',
  'CreateSubdomainValidateTXTValue',
  'ModifyRecord',
  'ModifyRecordBatchV3',
  'ModifyRecordFields',
  'ModifyRecordGroup',
  'ModifyRecordRemark',
  'ModifyRecordStatus',
  'ModifyRecordToGroup',
  'DeleteRecord',
  'DeleteRecordBatch',
  'DeleteRecordGroup',
  'CheckRecordSnapshotRollback',
  'RollbackRecordSnapshot'
]);

export const DNSPOD_ALLOWED_ACTIONS = new Set([
  'DescribeDomain',
  'DescribeDomainList',
  'DescribeDomainLogList',
  'DescribeDomainPurview',
  'DescribeDomainShareInfo',
  'DescribeRecord',
  'DescribeRecordExistExceptDefaultNS',
  'DescribeRecordFilterList',
  'DescribeRecordGroupList',
  'DescribeRecordLineCategoryList',
  'DescribeRecordLineList',
  'DescribeRecordList',
  'DescribeRecordSnapshotRollbackResult',
  'DescribeRecordType',
  'DescribeSubdomainAnalytics',
  'DescribeSubdomainValidateStatus',
  'DescribeDomainAndRecordList',
  'CreateRecord',
  'CreateRecordBatch',
  'CreateRecordGroup',
  'CreateSubdomainValidateTXTValue',
  'ModifyRecord',
  'ModifyRecordBatchV3',
  'ModifyRecordFields',
  'ModifyRecordGroup',
  'ModifyRecordRemark',
  'ModifyRecordStatus',
  'ModifyRecordToGroup',
  'DeleteRecord',
  'DeleteRecordBatch',
  'DeleteRecordGroup',
  'CheckRecordSnapshotRollback',
  'RollbackRecordSnapshot'
]);

export function normalizeApiAction(action) {
  const value = String(action || '').trim();
  if (!DNSPOD_ALLOWED_ACTIONS.has(value)) {
    throw new Error(`不支持的 DNSPod 操作：${value || '(空)'}`);
  }
  return value;
}

export function buildRecordPayload(input = {}, includeRecordId = false) {
  const payload = {
    Domain: MANAGED_DOMAIN,
    SubDomain: stringField(input.SubDomain, 'SubDomain'),
    RecordType: stringField(input.RecordType, 'RecordType').toUpperCase(),
    RecordLine: stringField(input.RecordLine || '默认', 'RecordLine'),
    Value: stringField(input.Value, 'Value')
  };

  if (input.RecordLineId) payload.RecordLineId = String(input.RecordLineId);
  for (const field of ['MX', 'TTL', 'Weight', 'RecordId']) {
    if (input[field] !== undefined && input[field] !== '') payload[field] = integerField(input[field], field);
  }
  if (input.Status) payload.Status = String(input.Status).toUpperCase();
  if (input.Remark !== undefined) payload.Remark = String(input.Remark);

  if (includeRecordId && !Number.isInteger(payload.RecordId)) {
    throw new Error('RecordId 必填且必须为整数');
  }
  return payload;
}

export function guardOpenWorldDomain(action, payload = {}) {
  const guarded = { ...payload };

  if (DOMAINLESS_ACTIONS.has(action)) {
    delete guarded.Domain;
    delete guarded.DomainId;
    delete guarded.DomainList;
    delete guarded.DomainIdList;
    delete guarded.GroupIdList;
    delete guarded.AllDomain;
    return guarded;
  }

  if (GRADE_ONLY_ACTIONS.has(action)) {
    delete guarded.Domain;
    delete guarded.DomainId;
    return guarded;
  }

  if (action === 'DescribeDomainAndRecordList') {
    if (Array.isArray(guarded.DomainList)) guarded.DomainList.forEach(checkManagedDomain);
    if (Array.isArray(guarded.DomainIdList) && guarded.DomainIdList.length) {
      throw new Error(`为避免误操作，仅允许查询 ${MANAGED_DOMAIN}`);
    }
    if (Array.isArray(guarded.GroupIdList) && guarded.GroupIdList.length) {
      throw new Error(`为避免误操作，仅允许查询 ${MANAGED_DOMAIN}`);
    }
    delete guarded.Domain;
    delete guarded.DomainId;
    delete guarded.DomainIdList;
    delete guarded.GroupIdList;
    delete guarded.AllDomain;
    guarded.DomainList = [MANAGED_DOMAIN];
    return guarded;
  }

  if (DOMAIN_AND_GRADE_ACTIONS.has(action)) {
    checkManagedDomain(guarded.Domain);
    delete guarded.DomainId;
    guarded.Domain = MANAGED_DOMAIN;
    guarded.DomainGrade = guarded.DomainGrade || 'DP_FREE';
    return guarded;
  }

  if (DOMAIN_REQUIRED_ACTIONS.has(action)) {
    checkManagedDomain(guarded.Domain);
    if (Array.isArray(guarded.DomainList)) guarded.DomainList.forEach(checkManagedDomain);
    if (Array.isArray(guarded.DomainIdList) && guarded.DomainIdList.length) {
      throw new Error(`为避免误操作，仅允许通过 Domain=${MANAGED_DOMAIN} 管理解析`);
    }
    delete guarded.DomainId;
    delete guarded.DomainList;
    delete guarded.DomainIdList;
    guarded.Domain = MANAGED_DOMAIN;
    return guarded;
  }

  return guarded;
}

function checkManagedDomain(value) {
  if (value !== undefined && String(value).trim().toLowerCase() !== MANAGED_DOMAIN) {
    throw new Error(`仅允许管理 ${MANAGED_DOMAIN} 的 DNS 解析`);
  }
}

export async function callDnsPod(env, action, payload = {}) {
  const normalizedAction = normalizeApiAction(action);
  const guardedPayload = guardOpenWorldDomain(normalizedAction, payload);
  const headers = await createTencentCloudHeaders({
    action: normalizedAction,
    payload: guardedPayload,
    secretId: env.TENCENT_SECRET_ID,
    secretKey: env.TENCENT_SECRET_KEY
  });

  const response = await fetch(`https://${DNSPOD_HOST}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(guardedPayload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.Response?.Error) {
    const error = data.Response?.Error;
    throw new Error(error ? `${error.Code}: ${error.Message}` : `DNSPod 请求失败：HTTP ${response.status}`);
  }
  return data.Response;
}

export async function createTencentCloudHeaders({ action, payload, secretId, secretKey, timestamp = Math.floor(Date.now() / 1000) }) {
  if (!secretId || !secretKey) throw new Error('缺少腾讯云 SecretId 或 SecretKey');
  const date = utcDate(timestamp);
  const body = JSON.stringify(payload || {});
  const hashedPayload = await sha256Hex(body);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${DNSPOD_HOST}\nx-tc-action:${String(action).toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, hashedPayload].join('\n');
  const credentialScope = `${date}/${DNSPOD_SERVICE}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(timestamp),
    credentialScope,
    await sha256Hex(canonicalRequest)
  ].join('\n');

  const secretDate = await hmacBytes(`TC3${secretKey}`, date);
  const secretService = await hmacBytes(secretDate, DNSPOD_SERVICE);
  const secretSigning = await hmacBytes(secretService, 'tc3_request');
  const signature = bytesToHex(await hmacBytes(secretSigning, stringToSign));

  return {
    Authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'Content-Type': 'application/json; charset=utf-8',
    Host: DNSPOD_HOST,
    'X-TC-Action': action,
    'X-TC-Timestamp': String(timestamp),
    'X-TC-Version': DNSPOD_VERSION
  };
}

function stringField(value, name) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${name} 必填`);
  return normalized;
}

function integerField(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`${name} 必须为整数`);
  return number;
}

function utcDate(timestamp) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}

async function hmacBytes(keyMaterial, message) {
  const keyBytes = typeof keyMaterial === 'string' ? new TextEncoder().encode(keyMaterial) : keyMaterial;
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

function bytesToHex(bytes) {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
