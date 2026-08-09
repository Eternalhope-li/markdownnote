
// roundtrip-test.js ?? ???????? SENTINEL/ZWSP ? serialize -> load ??????
module.exports = String.raw`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    if (document.querySelectorAll('.file-item').length > 0) break;
    await sleep(200);
  }
  const pane = document.getElementById('typoraPane');
  const out = {};
  const weird = (s) => { const r = []; for (const ch of s || '') { const c = ch.codePointAt(0); if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 0xfffd || c === 0xfeff) r.push('U+' + c.toString(16).toUpperCase().padStart(4,'0')); } return r; };
  const lib = (await window.api.readConfig()).library || (await window.api.getAppInfo()).defaultLibrary;
  const notePath = lib + '/' + document.getElementById('fileName').textContent;
  const orig = await window.api.readFile(notePath);
  const reset = async () => { await window.api.writeFile(notePath, orig); if (window.__test && window.__test.openNote) await window.__test.openNote(notePath); await sleep(300); };
  try {
    // 1) ?? -> ???? -> ?? 'a' + ???????? execCommand insertParagraph?
    await reset();
    pane.focus();
    document.execCommand('selectAll');
    document.execCommand('delete');
    document.execCommand('insertText', false, 'a');
    pane.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(100);
    // ?? Enter?insertParagraph + input
    document.execCommand('insertParagraph');
    pane.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(500);
    out.afterEnter = pane.innerHTML.replace(/\u200b/g,'<Z>').replace(/\u0001/g,'<S>');
    // 2) ??
    if (window.__test && window.__test.save) await window.__test.save();
    await sleep(300);
    const md1 = await window.api.readFile(notePath);
    out.savedMd = JSON.stringify(md1);
    out.savedWeird = weird(md1);
    // 3) ???load?
    if (window.__test && window.__test.openNote) await window.__test.openNote(notePath);
    await sleep(300);
    out.afterReload = pane.innerHTML.replace(/\u200b/g,'<Z>').replace(/\u0001/g,'<S>');
    out.afterReloadText = JSON.stringify(pane.textContent);
    out.afterReloadWeird = weird(pane.textContent);
    // 4) ???????????????doc.getDoc ????
    pane.focus();
    document.execCommand('selectAll');
    document.execCommand('delete');
    document.execCommand('insertText', false, 'b');
    pane.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(1200); // ?? serialize
    const notes = Array.from(document.querySelectorAll('.file-item'));
    if (notes.length > 1) { notes[1].click(); await sleep(300); notes[0].click(); await sleep(300); }
    out.afterSwitchBack = pane.innerHTML.replace(/\u200b/g,'<Z>').replace(/\u0001/g,'<S>').slice(0, 300);
    out.afterSwitchBackWeird = weird(pane.textContent);
  } catch (e) { out.error = String(e && e.stack || e); }
  await reset();
  return out;
})()`;
