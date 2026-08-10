import { describe, expect, it } from 'vitest';
import {
  DNSPOD_ALLOWED_ACTIONS,
  buildRecordPayload,
  createTencentCloudHeaders,
  guardOpenWorldDomain,
  normalizeApiAction
} from '../src/tencent-dnspod.js';

describe('DNSPod payload guard', () => {
  it('forces every mutable request to stay within open-world.cn', () => {
    expect(guardOpenWorldDomain('CreateRecord', { Domain: 'open-world.cn' })).toEqual({ Domain: 'open-world.cn' });
    expect(() => guardOpenWorldDomain('CreateRecord', { Domain: 'example.com' })).toThrow(/open-world\.cn/);
    expect(() => guardOpenWorldDomain('CreateRecord', { DomainList: ['open-world.cn', 'example.com'] })).toThrow(/open-world\.cn/);
  });

  it('keeps read-only metadata actions available without domain payloads', () => {
    expect(guardOpenWorldDomain('DescribeRecordType', { DomainGrade: 'DP_Free' })).toEqual({ DomainGrade: 'DP_Free' });
  });

  it('does not inject Domain into domain list requests', () => {
    expect(guardOpenWorldDomain('DescribeDomainList', { Limit: 10, Domain: 'open-world.cn' })).toEqual({ Limit: 10 });
  });

  it('adds required domain and grade for record line requests', () => {
    expect(guardOpenWorldDomain('DescribeRecordLineList', { DomainGrade: 'DP_FREE' })).toEqual({
      Domain: 'open-world.cn',
      DomainGrade: 'DP_FREE'
    });
  });

  it('limits batch search to open-world.cn without sending unsupported Domain', () => {
    expect(guardOpenWorldDomain('DescribeDomainAndRecordList', { DomainList: ['open-world.cn'], RecordType: 'A' })).toEqual({
      DomainList: ['open-world.cn'],
      RecordType: 'A'
    });
    expect(() => guardOpenWorldDomain('DescribeDomainAndRecordList', { DomainList: ['example.com'] })).toThrow(/open-world\.cn/);
  });
});

describe('DNSPod record payload normalization', () => {
  it('normalizes create/modify record fields and numeric options', () => {
    expect(buildRecordPayload({
      SubDomain: 'www',
      RecordType: 'A',
      RecordLine: '默认',
      Value: '1.2.3.4',
      MX: '0',
      TTL: '600',
      Weight: '10',
      Status: 'ENABLE',
      RecordId: '123'
    }, true)).toEqual({
      Domain: 'open-world.cn',
      SubDomain: 'www',
      RecordType: 'A',
      RecordLine: '默认',
      Value: '1.2.3.4',
      MX: 0,
      TTL: 600,
      Weight: 10,
      Status: 'ENABLE',
      RecordId: 123
    });
  });

  it('rejects incomplete records before calling Tencent Cloud', () => {
    expect(() => buildRecordPayload({ SubDomain: 'www', RecordType: 'A' }, false)).toThrow(/Value/);
    expect(() => buildRecordPayload({ SubDomain: 'www', RecordType: 'A', RecordLine: '默认', Value: '1.2.3.4' }, true)).toThrow(/RecordId/);
  });
});

describe('Tencent Cloud API 3.0 signing', () => {
  it('creates TC3 headers for the DNSPod endpoint', async () => {
    const body = { Domain: 'open-world.cn', Limit: 20 };
    const headers = await createTencentCloudHeaders({
      action: 'DescribeRecordList',
      payload: body,
      secretId: 'secret-id',
      secretKey: 'secret-key',
      timestamp: 1710000000
    });

    expect(headers['X-TC-Action']).toBe('DescribeRecordList');
    expect(headers['X-TC-Version']).toBe('2021-03-23');
    expect(headers['X-TC-Timestamp']).toBe('1710000000');
    expect(headers.Authorization).toMatch(/^TC3-HMAC-SHA256 Credential=secret-id\/2024-03-09\/dnspod\/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=[a-f0-9]{64}$/);
  });
});

describe('DNSPod action allowlist', () => {
  it('accepts known DNSPod actions and rejects unknown names', () => {
    expect(DNSPOD_ALLOWED_ACTIONS.has('CreateRecord')).toBe(true);
    expect(normalizeApiAction('ModifyRecord')).toBe('ModifyRecord');
    expect(() => normalizeApiAction('DeleteAnything')).toThrow(/不支持/);
  });
});
