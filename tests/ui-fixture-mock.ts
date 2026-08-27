/**
 * Smoke-test mock backend with a multi-firm fixture so the firm-flat
 * StepReview layout is visible. Replaces `npm run mock:backend` for
 * manual UI verification — same HTTP surface, richer dataset.
 *
 * Layout:
 *   - 3 firms: TEST-FIRM-A (Aktif Bank), TEST-FIRM-B (Garanti), TEST-CODEC
 *   - ~24 txIds across keyword groups IPTAL / ODEME / BILGI / HATA
 *     All IPTAL → A; all ODEME → B; BILGI → mixed A/B; HATA + others → Codec
 *
 * Run:    npm run mock:ui  (alias `tsx tests/ui-fixture-mock.ts`)
 * Port:   8788 (default — same as the original mock-server)
 */
import "dotenv/config";
import { createApp, startOnRandomPort } from "../ai-proxy/src/mock-server.js";

const FIXTURE = {
  customers: [
    { name: "AKTIF-BANK ---- Aktif Bank", acntEuId: "aaaaaaaa-0000-0000-0000-000000000001" },
    { name: "GARANTI ---- Garanti Bankası", acntEuId: "bbbbbbbb-0000-0000-0000-000000000002" },
  ],
  items: [
    // 8 → IPTAL → Aktif Bank
    { transactionId: 1001, keyword1: "IPTAL", keyword2: "", msgContent: "Abonelik iptal", shortCode: "3525", msgDate: "2026-08-20T10:00:00", id: "1001|20.08.2026 10:00:00", phone: "5550001001" },
    { transactionId: 1002, keyword1: "IPTAL", keyword2: "", msgContent: "Abonelik iptal", shortCode: "3525", msgDate: "2026-08-20T10:01:00", id: "1002|20.08.2026 10:01:00", phone: "5550001002" },
    { transactionId: 1003, keyword1: "IPTAL", keyword2: "", msgContent: "İptal etmek istiyorum", shortCode: "3525", msgDate: "2026-08-20T10:02:00", id: "1003|20.08.2026 10:02:00", phone: "5550001003" },
    { transactionId: 1004, keyword1: "IPTAL", keyword2: "", msgContent: "İptal", shortCode: "3525", msgDate: "2026-08-20T10:03:00", id: "1004|20.08.2026 10:03:00", phone: "5550001004" },
    { transactionId: 1005, keyword1: "IPTAL", keyword2: "", msgContent: "Lütfen iptal", shortCode: "3525", msgDate: "2026-08-20T10:04:00", id: "1005|20.08.2026 10:04:00", phone: "5550001005" },
    { transactionId: 1006, keyword1: "IPTAL", keyword2: "", msgContent: "İptal talebi", shortCode: "3525", msgDate: "2026-08-20T10:05:00", id: "1006|20.08.2026 10:05:00", phone: "5550001006" },
    { transactionId: 1007, keyword1: "IPTAL", keyword2: "", msgContent: "Abonelikten çıkmak", shortCode: "3525", msgDate: "2026-08-20T10:06:00", id: "1007|20.08.2026 10:06:00", phone: "5550001007" },
    { transactionId: 1008, keyword1: "IPTAL", keyword2: "", msgContent: "İptal ediniz", shortCode: "3525", msgDate: "2026-08-20T10:07:00", id: "1008|20.08.2026 10:07:00", phone: "5550001008" },

    // 6 → ODEME → Garanti
    { transactionId: 2001, keyword1: "ODEME", keyword2: "", msgContent: "Ödeme geri al", shortCode: "3525", msgDate: "2026-08-20T10:10:00", id: "2001|20.08.2026 10:10:00", phone: "5550002001" },
    { transactionId: 2002, keyword1: "ODEME", keyword2: "", msgContent: "Ödeme iade", shortCode: "3525", msgDate: "2026-08-20T10:11:00", id: "2002|20.08.2026 10:11:00", phone: "5550002002" },
    { transactionId: 2003, keyword1: "ODEME", keyword2: "", msgContent: "Para iadesi", shortCode: "3525", msgDate: "2026-08-20T10:12:00", id: "2003|20.08.2026 10:12:00", phone: "5550002003" },
    { transactionId: 2004, keyword1: "ODEME", keyword2: "", msgContent: "Geri ödeme talebi", shortCode: "3525", msgDate: "2026-08-20T10:13:00", id: "2004|20.08.2026 10:13:00", phone: "5550002004" },
    { transactionId: 2005, keyword1: "ODEME", keyword2: "", msgContent: "İade istiyorum", shortCode: "3525", msgDate: "2026-08-20T10:14:00", id: "2005|20.08.2026 10:14:00", phone: "5550002005" },
    { transactionId: 2006, keyword1: "ODEME", keyword2: "", msgContent: "Ücret iadesi", shortCode: "3525", msgDate: "2026-08-20T10:15:00", id: "2006|20.08.2026 10:15:00", phone: "5550002006" },

    // 4 → BILGI → Aktif Bank
    { transactionId: 3001, keyword1: "BILGI", keyword2: "", msgContent: "Bilgi almak istiyorum", shortCode: "3525", msgDate: "2026-08-20T10:20:00", id: "3001|20.08.2026 10:20:00", phone: "5550003001" },
    { transactionId: 3002, keyword1: "BILGI", keyword2: "", msgContent: "Detay verin", shortCode: "3525", msgDate: "2026-08-20T10:21:00", id: "3002|20.08.2026 10:21:00", phone: "5550003002" },
    { transactionId: 3003, keyword1: "BILGI", keyword2: "", msgContent: "Hesap bilgisi", shortCode: "3525", msgDate: "2026-08-20T10:22:00", id: "3003|20.08.2026 10:22:00", phone: "5550003003" },
    { transactionId: 3004, keyword1: "BILGI", keyword2: "", msgContent: "Bilgi", shortCode: "3525", msgDate: "2026-08-20T10:23:00", id: "3004|20.08.2026 10:23:00", phone: "5550003004" },

    // 3 → HATA → Codec fallback
    { transactionId: 4001, keyword1: "HATA", keyword2: "", msgContent: "Hata aldım", shortCode: "3525", msgDate: "2026-08-20T10:30:00", id: "4001|20.08.2026 10:30:00", phone: "5550004001" },
    { transactionId: 4002, keyword1: "HATA", keyword2: "", msgContent: "Yanlış ücretlendirme", shortCode: "3525", msgDate: "2026-08-20T10:31:00", id: "4002|20.08.2026 10:31:00", phone: "5550004002" },
    { transactionId: 4003, keyword1: "HATA", keyword2: "", msgContent: "İtiraz", shortCode: "3525", msgDate: "2026-08-20T10:32:00", id: "4003|20.08.2026 10:32:00", phone: "5550004003" },

    // 3 → mixed → Codec fallback (garbage/empty keyword1)
    { transactionId: 5001, keyword1: ".", keyword2: "", msgContent: "", shortCode: "3525", msgDate: "2026-08-20T10:40:00", id: "5001|20.08.2026 10:40:00", phone: "5550005001" },
    { transactionId: 5002, keyword1: "", keyword2: "", msgContent: "???", shortCode: "3525", msgDate: "2026-08-20T10:41:00", id: "5002|20.08.2026 10:41:00", phone: "5550005002" },
    { transactionId: 5003, keyword1: "x", keyword2: "", msgContent: "", shortCode: "3525", msgDate: "2026-08-20T10:42:00", id: "5003|20.08.2026 10:42:00", phone: "5550005003" },
  ],
};

const { app } = createApp(FIXTURE as Parameters<typeof createApp>[0]);
const PORT = Number(process.env.MOCK_PORT ?? 8788);

app.listen(PORT, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`[mock-ui] http://localhost:${PORT}`);
  console.log(`[mock-ui] customers=${FIXTURE.customers.length} items=${FIXTURE.items.length}`);
  console.log(`[mock-ui]   POST /api/Menu3525/GetCustomersToBeCharged`);
  console.log(`[mock-ui]   POST /api/Menu3525/GetUnMatchedList`);
  console.log(`[mock-ui]   POST /api/Menu3525/Charged`);
  console.log(`[mock-ui]   GET  /__mock/health`);
  console.log(`[mock-ui]   GET  /__mock/charged-log`);
});