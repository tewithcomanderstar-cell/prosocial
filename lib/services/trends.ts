export async function getTrendIdeas(userId: string) {
  void userId;
  return {
    topics: [
      { keyword: "โปรโมชั่นหน้าร้อน", score: 88, source: "internal trend board" },
      { keyword: "ไอเดียแต่งตัวทำงาน", score: 79, source: "content inspiration" },
      { keyword: "รีวิวลูกค้าจริง", score: 74, source: "engagement pattern" },
      { keyword: "สินค้าขายดีประจำสัปดาห์", score: 71, source: "seasonal campaign" }
    ],
    note: "Trend discovery is currently an internal idea engine foundation. Connect external providers later for live trend feeds."
  };
}
