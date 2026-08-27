// Parse the admin-panel HAR for session/cookie clues.
// Filters out massive `text` fields (JS bundles, response bodies).
const fs = require("fs");
const path = process.argv[2];
if (!path) {
  console.error("usage: node parse-har.js <har-file>");
  process.exit(1);
}
const raw = fs.readFileSync(path, "utf8");
const har = JSON.parse(raw);

const entries = har.log?.entries || [];
console.log(`entries: ${entries.length}`);
console.log("---");

// 1) Every Set-Cookie header across responses.
const setCookies = new Set();
entries.forEach((e, idx) => {
  const headers = (e.response?.headers) || [];
  for (const h of headers) {
    if (/^set-cookie$/i.test(h.name)) setCookies.add(`${idx}: ${h.value}`);
  }
});
console.log(`Set-Cookie count: ${setCookies.size}`);
[...setCookies].slice(0, 10).forEach((s) => console.log("  ", s));

console.log("---");
// 2) Cookie header (request side).
const reqCookies = new Set();
entries.forEach((e) => {
  const headers = e.request?.headers || [];
  for (const h of headers) {
    if (/^cookie$/i.test(h.name)) reqCookies.add(h.value);
  }
});
console.log(`Cookie header count (distinct): ${reqCookies.size}`);
[...reqCookies].slice(0, 5).forEach((s) => console.log("  ", s));

console.log("---");
// 3) sessionid / appid header values.
const sessIds = new Set();
const appIds = new Set();
entries.forEach((e) => {
  const headers = e.request?.headers || [];
  for (const h of headers) {
    if (/^sessionid$/i.test(h.name)) sessIds.add(h.value);
    if (/^appid$/i.test(h.name)) appIds.add(h.value);
  }
});
console.log(`distinct sessionid headers: ${sessIds.size}`);
[...sessIds].slice(0, 5).forEach((s) => console.log("  ", s));
console.log(`distinct appid headers: ${appIds.size}`);
[...appIds].forEach((s) => console.log("  ", s));

console.log("---");
// 4) Cookies on requests (har format uses request.cookies array).
const reqCookieNames = new Set();
entries.forEach((e) => {
  for (const c of e.request?.cookies || []) reqCookieNames.add(c.name);
});
console.log(`request.cookies names: ${[...reqCookieNames].join(", ")}`);

console.log("---");
// 5) Look at the response cookies across all entries.
const respCookieNames = new Set();
entries.forEach((e) => {
  for (const c of e.response?.cookies || []) respCookieNames.add(c.name);
});
console.log(`response.cookies names: ${[...respCookieNames].join(", ")}`);

console.log("---");
// 6) Look for any reference to localStorage/sessionStorage in the postData / request bodies of XHR/fetch.
const storeHits = [];
entries.forEach((e, idx) => {
  const url = e.request?.url || "";
  if (/localStorage|sessionStorage/.test(url)) {
    storeHits.push(`url: ${idx}: ${url}`);
  }
  const text = (e.request?.postData?.text) || "";
  if (/localStorage|sessionStorage/.test(text)) {
    storeHits.push(`body: ${idx}: ${text.slice(0, 200)}`);
  }
});
console.log(`storage hits in url/body: ${storeHits.length}`);
storeHits.slice(0, 5).forEach((s) => console.log("  ", s));
