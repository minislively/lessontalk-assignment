import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lessontalk",
  description: "레슨 피드백 관리 서비스",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
