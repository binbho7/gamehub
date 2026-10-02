import type { Metadata } from "next";
import "./globals.css";
import { Header } from "@/components/layout/header";
import { Footer } from "@/components/layout/footer";
import { ROOT_METADATA } from "@/lib/seo";

export const metadata: Metadata = ROOT_METADATA;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="zh-CN"><body className="min-h-screen antialiased"><Header /><main>{children}</main><Footer /></body></html>; }
