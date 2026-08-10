(function (global) {
  const DEFAULT_OPTIONS = {
    targetBytes: 200 * 1024,
    hardLimitBytes: 220 * 1024,
    initialSize: 256,
    minSize: 96,
    sizeStep: 0.75,
    initialQuality: 0.86,
    minQuality: 0.48,
    qualityStep: 0.08,
    outputType: 'image/webp'
  };

  function estimateDataUrlBytes(dataUrl) {
    if (typeof dataUrl !== 'string') return 0;
    const commaIndex = dataUrl.indexOf(',');
    const payload = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
    const padding = payload.endsWith('==') ? 2 : (payload.endsWith('=') ? 1 : 0);
    return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
  }

  function getUploadBytes(dataUrl) {
    if (typeof dataUrl !== 'string') return 0;
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(dataUrl).byteLength;
    return dataUrl.length;
  }

  function blobToDataUrl(blob, adapter) {
    const FileReaderCtor = adapter.FileReader || global.FileReader;
    return new Promise((resolve, reject) => {
      const reader = new FileReaderCtor();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('头像读取失败'));
      reader.readAsDataURL(blob);
    });
  }

  function readFileAsDataUrl(file, adapter) {
    const FileReaderCtor = adapter.FileReader || global.FileReader;
    return new Promise((resolve, reject) => {
      const reader = new FileReaderCtor();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('头像读取失败'));
      reader.readAsDataURL(file);
    });
  }

  function loadImage(src, adapter) {
    const ImageCtor = adapter.Image || global.Image;
    return new Promise((resolve, reject) => {
      const img = new ImageCtor();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('头像图片加载失败'));
      img.src = src;
    });
  }

  function createCanvas(adapter) {
    if (adapter.createCanvas) return adapter.createCanvas();
    return global.document.createElement('canvas');
  }

  function canvasToDataUrl(canvas, type, quality, adapter) {
    if (adapter.canvasToDataUrl) return Promise.resolve(adapter.canvasToDataUrl(canvas, type, quality));
    if (typeof canvas.toBlob === 'function') {
      return new Promise((resolve, reject) => {
        canvas.toBlob(async blob => {
          if (!blob) {
            reject(new Error('头像压缩失败'));
            return;
          }
          try {
            resolve(await blobToDataUrl(blob, adapter));
          } catch (error) {
            reject(error);
          }
        }, type, quality);
      });
    }
    return Promise.resolve(canvas.toDataURL(type, quality));
  }

  function drawCenteredSquare(image, size, adapter) {
    const canvas = createCanvas(adapter);
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前浏览器不支持头像压缩');

    const sourceSize = Math.min(image.width, image.height);
    const sx = (image.width - sourceSize) / 2;
    const sy = (image.height - sourceSize) / 2;
    ctx.clearRect?.(0, 0, size, size);
    ctx.drawImage(image, sx, sy, sourceSize, sourceSize, 0, 0, size, size);
    return canvas;
  }

  async function compressAvatarFile(file, options = {}) {
    const config = { ...DEFAULT_OPTIONS, ...options };
    const adapter = config.adapter || {};
    const sourceUrl = await readFileAsDataUrl(file, adapter);
    const image = await loadImage(sourceUrl, adapter);
    let best = null;

    for (let size = config.initialSize; size >= config.minSize; size = Math.floor(size * config.sizeStep)) {
      const canvas = drawCenteredSquare(image, size, adapter);
      for (let quality = config.initialQuality; quality >= config.minQuality; quality = Number((quality - config.qualityStep).toFixed(2))) {
        const dataUrl = await canvasToDataUrl(canvas, config.outputType, quality, adapter);
        const bytes = getUploadBytes(dataUrl);
        const candidate = { dataUrl, bytes, size, quality };
        if (!best || candidate.bytes < best.bytes) best = candidate;
        if (bytes <= config.targetBytes) return dataUrl;
      }
    }

    if (best && best.bytes <= config.hardLimitBytes) return best.dataUrl;
    throw new Error('头像压缩后仍然过大，请换一张更小的图片');
  }

  const api = { compressAvatarFile, estimateDataUrlBytes, getUploadBytes };
  global.AvatarCompression = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
