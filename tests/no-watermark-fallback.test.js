'use strict';

const assert = require('assert');
const { resolveResultImage } = require('../server');

async function run() {
  const hdUrl = await resolveResultImage({
    requireHd: true,
    fetchHdImage: async () => 'https://example.test/hd.png',
    previewImage: 'https://example.test/watermarked-preview.png',
  });
  assert.strictEqual(hdUrl, 'https://example.test/hd.png');

  await assert.rejects(
    resolveResultImage({
      requireHd: true,
      fetchHdImage: async () => null,
      previewImage: 'https://example.test/watermarked-preview.png',
    }),
    /拒绝回退到带水印预览图/
  );

  const previewUrl = await resolveResultImage({
    requireHd: false,
    fetchHdImage: async () => { throw new Error('should not run'); },
    previewImage: 'https://example.test/preview.png',
  });
  assert.strictEqual(previewUrl, 'https://example.test/preview.png');

  console.log('no-watermark fallback regression passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
