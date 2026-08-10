import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { compressAvatarFile, getUploadBytes } = require('../../public/js/avatar-compression.js');

function dataUrlWithUploadBytes(bytes) {
  const prefix = 'data:image/webp;base64,';
  const payloadLength = Math.max(0, bytes - prefix.length);
  return `${prefix}${'A'.repeat(payloadLength)}`;
}

function sourceDataUrlWithBytes(bytes) {
  const prefix = 'data:image/png;base64,';
  const payloadLength = Math.max(0, bytes - prefix.length);
  return `${prefix}${'A'.repeat(payloadLength)}`;
}

function makeAdapter(encodedSizes) {
  const calls = [];
  return {
    calls,
    FileReader: class {
      readAsDataURL(fileOrBlob) {
        this.result = fileOrBlob.dataUrl || sourceDataUrlWithBytes(fileOrBlob.bytes || 1);
        this.onload();
      }
    },
    Image: class {
      set src(value) {
        this.width = 1600;
        this.height = 900;
        this.onload();
      }
    },
    createCanvas() {
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          clearRect() {},
          drawImage() {}
        })
      };
    },
    canvasToDataUrl(canvas, type, quality) {
      calls.push({ width: canvas.width, height: canvas.height, type, quality });
      return dataUrlWithUploadBytes(encodedSizes[Math.min(calls.length - 1, encodedSizes.length - 1)]);
    }
  };
}

describe('avatar compression', () => {
  it('compresses avatars before upload and returns a data URL under the target size', async () => {
    const adapter = makeAdapter([260 * 1024, 230 * 1024, 180 * 1024]);
    const original = { dataUrl: 'data:image/png;base64,ORIGINAL' };

    const result = await compressAvatarFile(original, { adapter, targetBytes: 200 * 1024 });

    expect(result).toMatch(/^data:image\/webp;base64,/);
    expect(result).not.toBe(original.dataUrl);
    expect(getUploadBytes(result)).toBeLessThanOrEqual(200 * 1024);
    expect(adapter.calls.length).toBe(3);
    expect(adapter.calls[0]).toMatchObject({ width: 256, height: 256, type: 'image/webp', quality: 0.86 });
  });

  it('continues by reducing dimensions when quality alone is not enough', async () => {
    const adapter = makeAdapter([230 * 1024, 225 * 1024, 221 * 1024, 219 * 1024]);

    const result = await compressAvatarFile({ dataUrl: 'data:image/jpeg;base64,SOURCE' }, {
      adapter,
      targetBytes: 200 * 1024,
      hardLimitBytes: 220 * 1024,
      initialQuality: 0.86,
      minQuality: 0.78,
      qualityStep: 0.08,
      initialSize: 256,
      minSize: 128,
      sizeStep: 0.5
    });

    expect(getUploadBytes(result)).toBeLessThanOrEqual(220 * 1024);
    expect(adapter.calls.map(call => call.width)).toEqual([256, 256, 128, 128]);
  });
});
