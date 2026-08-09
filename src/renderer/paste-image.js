function getImageDataUrl(pasteEvent) {
  return new Promise((resolve) => {
    const items = pasteEvent.clipboardData && pasteEvent.clipboardData.items;
    if (!items) return resolve(null);
    for (const item of items) {
      if (item.type && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (!file) return resolve(null);
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
        return;
      }
    }
    resolve(null);
  });
}

function toMarkdown(dataUrl, alt) {
  return '![' + (alt || '图片') + '](' + dataUrl + ')';
}

module.exports = { getImageDataUrl, toMarkdown };