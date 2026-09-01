import type { Metadata } from "next";
import "./globals.css";
import { Header } from "@/components/layout/header";
import { Footer } from "@/components/layout/footer";

export const metadata: Metadata = { metadataBase: new URL("https://games.binbho.com"), title: { default: "GameHub — 发现游戏与官方资源", template: "%s | GameHub" }, description: "查找游戏资料、官方网站和可信的官方商店入口。", alternates: { canonical: "/" }, openGraph: { siteName: "GameHub", locale: "zh_CN", type: "website" }, robots: { index: true, follow: true } };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="zh-CN"><body className="min-h-screen antialiased"><Header /><main>{children}</main><Footer /></body></html>; }
