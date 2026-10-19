const adFreeRoutes = ["/dashboard", "/planner", "/account", "/sign-in", "/reset-password", "/auth"];

export function isAdFreeRoute(pathname: string | null | undefined) {
  return Boolean(pathname && adFreeRoutes.some((route) => pathname === route || pathname.startsWith(`${route}/`)));
}
