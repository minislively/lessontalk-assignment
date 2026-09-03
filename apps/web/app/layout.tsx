import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lessontalk",
  description: "Lesson feedback workspace",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
