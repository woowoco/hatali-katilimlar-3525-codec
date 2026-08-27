/* eslint-disable no-console */
// Demo veri seeder. Mock backend /__mock/demo-seed.js üzerinden servis edilir.
// Popup'ın DevTools Console'unda tek satırla çalıştırılır:
//   fetch("http://localhost:8788/__mock/demo-seed.js").then(r=>r.text()).then(eval)

const DEMO_SETTINGS = {
  sessionId: "demo",
  proxyUrl: "http://localhost:8787",
  model: "demo",
  throttleMs: 200,
};

const FIRM_AKTIF = "aaaaaaaa-0000-0000-0000-000000000001";
const FIRM_GARANTI = "bbbbbbbb-0000-0000-0000-000000000002";

const CUSTOMERS = [
  { name: "AKTIF-BANK ---- Aktif Bank", acntEuId: FIRM_AKTIF },
  { name: "GARANTI ---- Garanti Bankası", acntEuId: FIRM_GARANTI },
];

const ITEMS = [
  { transactionId: 1001, phone: "5550001001", keyword1: "IPTAL", keyword2: "", msgContent: "Abonelik iptal", shortCode: "3525", msgDate: "2026-08-20T10:00:00", id: "1001|20.08.2026 10:00:00" },
  { transactionId: 1002, phone: "5550001002", keyword1: "IPTAL", keyword2: "", msgContent: "Abonelik iptal", shortCode: "3525", msgDate: "2026-08-20T10:01:00", id: "1002|20.08.2026 10:01:00" },
  { transactionId: 1003, phone: "5550001003", keyword1: "IPTAL", keyword2: "", msgContent: "Iptal etmek istiyorum", shortCode: "3525", msgDate: "2026-08-20T10:02:00", id: "1003|20.08.2026 10:02:00" },
  { transactionId: 1004, phone: "5550001004", keyword1: "IPTAL", keyword2: "", msgContent: "Iptal", shortCode: "3525", msgDate: "2026-08-20T10:03:00", id: "1004|20.08.2026 10:03:00" },
  { transactionId: 1005, phone: "5550001005", keyword1: "IPTAL", keyword2: "", msgContent: "Lutfen iptal", shortCode: "3525", msgDate: "2026-08-20T10:04:00", id: "1005|20.08.2026 10:04:00" },
  { transactionId: 1006, phone: "5550001006", keyword1: "IPTAL", keyword2: "", msgContent: "Iptal talebi", shortCode: "3525", msgDate: "2026-08-20T10:05:00", id: "1006|20.08.2026 10:05:00" },
  { transactionId: 1007, phone: "5550001007", keyword1: "IPTAL", keyword2: "", msgContent: "Abonelikten cikmak", shortCode: "3525", msgDate: "2026-08-20T10:06:00", id: "1007|20.08.2026 10:06:00" },
  { transactionId: 1008, phone: "5550001008", keyword1: "IPTAL", keyword2: "", msgContent: "Iptal ediniz", shortCode: "3525", msgDate: "2026-08-20T10:07:00", id: "1008|20.08.2026 10:07:00" },
  { transactionId: 2001, phone: "5550002001", keyword1: "ODEME", keyword2: "", msgContent: "Odeme geri al", shortCode: "3525", msgDate: "2026-08-20T10:10:00", id: "2001|20.08.2026 10:10:00" },
  { transactionId: 2002, phone: "5550002002", keyword1: "ODEME", keyword2: "", msgContent: "Odeme iade", shortCode: "3525", msgDate: "2026-08-20T10:11:00", id: "2002|20.08.2026 10:11:00" },
  { transactionId: 2003, phone: "5550002003", keyword1: "ODEME", keyword2: "", msgContent: "Para iadesi", shortCode: "3525", msgDate: "2026-08-20T10:12:00", id: "2003|20.08.2026 10:12:00" },
  { transactionId: 2004, phone: "5550002004", keyword1: "ODEME", keyword2: "", msgContent: "Geri odeme talebi", shortCode: "3525", msgDate: "2026-08-20T10:13:00", id: "2004|20.08.2026 10:13:00" },
  { transactionId: 2005, phone: "5550002005", keyword1: "ODEME", keyword2: "", msgContent: "Iade istiyorum", shortCode: "3525", msgDate: "2026-08-20T10:14:00", id: "2005|20.08.2026 10:14:00" },
  { transactionId: 2006, phone: "5550002006", keyword1: "ODEME", keyword2: "", msgContent: "Ucret iadesi", shortCode: "3525", msgDate: "2026-08-20T10:15:00", id: "2006|20.08.2026 10:15:00" },
  { transactionId: 3001, phone: "5550003001", keyword1: "BILGI", keyword2: "", msgContent: "Bilgi almak istiyorum", shortCode: "3525", msgDate: "2026-08-20T10:20:00", id: "3001|20.08.2026 10:20:00" },
  { transactionId: 3002, phone: "5550003002", keyword1: "BILGI", keyword2: "", msgContent: "Detay verin", shortCode: "3525", msgDate: "2026-08-20T10:21:00", id: "3002|20.08.2026 10:21:00" },
  { transactionId: 3003, phone: "5550003003", keyword1: "BILGI", keyword2: "", msgContent: "Hesap bilgisi", shortCode: "3525", msgDate: "2026-08-20T10:22:00", id: "3003|20.08.2026 10:22:00" },
  { transactionId: 3004, phone: "5550003004", keyword1: "BILGI", keyword2: "", msgContent: "Bilgi", shortCode: "3525", msgDate: "2026-08-20T10:23:00", id: "3004|20.08.2026 10:23:00" },
  { transactionId: 4001, phone: "5550004001", keyword1: "HATA", keyword2: "", msgContent: "Hata aldim", shortCode: "3525", msgDate: "2026-08-20T10:30:00", id: "4001|20.08.2026 10:30:00" },
  { transactionId: 4002, phone: "5550004002", keyword1: "HATA", keyword2: "", msgContent: "Yanlis ucretlendirme", shortCode: "3525", msgDate: "2026-08-20T10:31:00", id: "4002|20.08.2026 10:31:00" },
  { transactionId: 4003, phone: "5550004003", keyword1: "HATA", keyword2: "", msgContent: "Itiraz", shortCode: "3525", msgDate: "2026-08-20T10:32:00", id: "4003|20.08.2026 10:32:00" },
  { transactionId: 5001, phone: "5550005001", keyword1: ".", keyword2: "", msgContent: "", shortCode: "3525", msgDate: "2026-08-20T10:40:00", id: "5001|20.08.2026 10:40:00" },
  { transactionId: 5002, phone: "5550005002", keyword1: "", keyword2: "", msgContent: "???", shortCode: "3525", msgDate: "2026-08-20T10:41:00", id: "5002|20.08.2026 10:41:00" },
  { transactionId: 5003, phone: "5550005003", keyword1: "x", keyword2: "", msgContent: "", shortCode: "3525", msgDate: "2026-08-20T10:42:00", id: "5003|20.08.2026 10:42:00" },
];

const M = (id, group, accountId, accountName, conf, field, value) => ({
  transactionId: id,
  matchedField: field || "keyword1",
  matchedValue: value || "",
  keywordGroup: group,
  suggestedAccountEuId: accountId,
  suggestedAccountName: accountName,
  confidence: conf || "high",
  reasoning: "",
});

const MATCHES = [
  // 8 IPTAL -> Aktif Bank
  M(1001, "iptal", FIRM_AKTIF, "AKTIF-BANK", "high", "keyword1", "IPTAL"),
  M(1002, "iptal", FIRM_AKTIF, "AKTIF-BANK", "high", "keyword1", "IPTAL"),
  M(1003, "iptal", FIRM_AKTIF, "AKTIF-BANK", "medium", "msgContent", "Iptal etmek istiyorum"),
  M(1004, "iptal", FIRM_AKTIF, "AKTIF-BANK", "high", "keyword1", "IPTAL"),
  M(1005, "iptal", FIRM_AKTIF, "AKTIF-BANK", "high", "keyword1", "IPTAL"),
  M(1006, "iptal", FIRM_AKTIF, "AKTIF-BANK", "high", "keyword1", "IPTAL"),
  M(1007, "iptal", FIRM_AKTIF, "AKTIF-BANK", "medium", "msgContent", "Abonelikten cikmak"),
  M(1008, "iptal", FIRM_AKTIF, "AKTIF-BANK", "high", "keyword1", "IPTAL"),
  // 6 ODEME -> Garanti
  M(2001, "odeme", FIRM_GARANTI, "GARANTI", "high", "keyword1", "ODEME"),
  M(2002, "odeme", FIRM_GARANTI, "GARANTI", "high", "keyword1", "ODEME"),
  M(2003, "odeme", FIRM_GARANTI, "GARANTI", "high", "msgContent", "Para iadesi"),
  M(2004, "odeme", FIRM_GARANTI, "GARANTI", "medium", "msgContent", "Geri odeme talebi"),
  M(2005, "odeme", FIRM_GARANTI, "GARANTI", "low", "msgContent", "Iade istiyorum"),
  M(2006, "odeme", FIRM_GARANTI, "GARANTI", "medium", "msgContent", "Ucret iadesi"),
  // 4 BILGI -> Aktif Bank (farkli keywordGroup, AYNI firma, tek tablo!)
  M(3001, "bilgi", FIRM_AKTIF, "AKTIF-BANK", "high", "keyword1", "BILGI"),
  M(3002, "bilgi", FIRM_AKTIF, "AKTIF-BANK", "medium", "msgContent", "Detay verin"),
  M(3003, "bilgi", FIRM_AKTIF, "AKTIF-BANK", "medium", "msgContent", "Hesap bilgisi"),
  M(3004, "bilgi", FIRM_AKTIF, "AKTIF-BANK", "high", "keyword1", "BILGI"),
  // 3 HATA -> Codec (null)
  M(4001, "hata", null, null, "low", "keyword1", "HATA"),
  M(4002, "hata", null, null, "low", "msgContent", "Yanlis ucretlendirme"),
  M(4003, "hata", null, null, "low", "msgContent", "Itiraz"),
  // 3 garbage -> Codec (null)
  M(5001, "unknown", null, null, "low", "keyword1", "."),
  M(5002, "unknown", null, null, "low", "msgContent", "???"),
  M(5003, "unknown", null, null, "low", "keyword1", "x"),
];

await chrome.storage.local.set({
  "settings.v1": DEMO_SETTINGS,
  "session.v1": {
    customers: CUSTOMERS,
    items: ITEMS,
    matches: MATCHES,
    model: "demo",
    fetchedAt: "2026-08-20T10:00:00",
    chargedIds: [],
    ignoredIds: [],
    firmOverrides: {},
    txFirmOverrides: {},
  },
});
console.log("[demo-seed] OK - popup'i F5 ile yenileyin, /review acilacak.");