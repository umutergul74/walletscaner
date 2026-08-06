import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Memecoin Alpha Intelligence",
  description: "Research-only memecoin signal, wallet intelligence, risk, backtest, and paper trading dashboard."
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
