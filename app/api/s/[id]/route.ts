import { NextResponse } from "next/server";
import { AffiliateLink } from "@/models/AffiliateLink";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const link = await AffiliateLink.findById(id).select("affiliateUrl status").lean<{ affiliateUrl?: string; status?: string } | null>();

  if (!link || link.status !== "active" || !link.affiliateUrl) {
    return NextResponse.json({ ok: false, message: "Affiliate link not found" }, { status: 404 });
  }

  await AffiliateLink.findByIdAndUpdate(id, {
    $inc: { clickCount: 1 },
    lastClickedAt: new Date()
  }).catch(() => null);

  return NextResponse.redirect(link.affiliateUrl, 302);
}
