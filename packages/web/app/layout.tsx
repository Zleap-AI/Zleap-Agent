import type { Metadata } from 'next';
import './globals.css';
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { I18nProvider } from "@/components/I18nProvider";

export const metadata: Metadata = {
  title: 'Zleap Agent',
  description: 'A chat-centric agent that runs tools locally and routes work into spaces.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="font-sans">
      <body>
        <I18nProvider>
          <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
          <Toaster position="top-center" />
        </I18nProvider>
      </body>
    </html>
  );
}
