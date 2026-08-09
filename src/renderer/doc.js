let current = '';

function getDoc() { return current; }
function setDoc(md) { current = md; }

module.exports = { getDoc, setDoc };