import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const SESSION_COOKIE_NAME = "fb_auto_post_session";
const PUBLIC_PATHS = new Set(["/login", "/register", "/privacy-policy"]);

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  return secret ? new TextEncoder().encode(secret) : null;
}

async function hasValidSession(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const secret = getJwtSecret();

  if (!token || !secret) {
    return false;
  }

  try {
    await jwtVerify(token, secret);
    return true;
  } catch {
    return false;
  }
}

function isPublicPath(pathname: string) {
  if (PUBLIC_PATHS.has(pathname)) {
    return true;
  }

  return false;
}

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const isAuthenticated = await hasValidSession(request);

  if (pathname === "/") {
    const url = request.nextUrl.clone();
    url.pathname = isAuthenticated ? "/dashboard" : "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  if (isPublicPath(pathname)) {
    if (isAuthenticated && (pathname === "/login" || pathname === "/register")) {
      const url = request.nextUrl.clone();
      url.pathname = "/dashboard";
      url.search = "";
      return NextResponse.redirect(url);
    }

    return NextResponse.next();
  }

  if (!isAuthenticated) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    const nextPath = `${pathname}${search}`;
    if (pathname !== "/login") {
      url.searchParams.set("next", nextPath);
      url.searchParams.set("error", "unauthorized");
    }
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"]
};
