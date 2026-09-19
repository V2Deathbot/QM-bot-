import { type ReactNode, useEffect } from 'react';
import { Link, useLocation } from 'wouter';
import { TerminalSquare, Shield, FileText, Activity, type LucideIcon } from 'lucide-react';
import {
  CONTACT_EMAIL,
  CREATOR_DISCORD,
  CREATOR_NAME,
  EFFECTIVE_DATE,
  OPERATOR_NAME,
  OWNER_NAME,
} from '@/lib/constants';

function NavLink({ href, children, icon: Icon }: { href: string, children: ReactNode, icon: LucideIcon }) {
  const [location] = useLocation();
  const isActive = location === href;

  return (
    <Link href={href} className={`flex items-center gap-2 px-3 py-2 text-sm font-medium transition-colors ${isActive ? 'text-primary bg-primary/5 border-b-2 border-primary' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50 border-b-2 border-transparent'}`} data-testid={`link-nav-${href.replace('/', '') || 'home'}`}>
      <Icon className="w-4 h-4" />
      {children}
    </Link>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();

  useEffect(() => {
    let title = "Quartermaster Bot Status";
    let desc = "Real-time operational status for the Quartermaster bot infrastructure.";
    
    if (location === "/terms") {
      title = "Terms of Service | Quartermaster";
      desc = "Terms of Service for the Quartermaster Discord bot.";
    } else if (location === "/privacy") {
      title = "Privacy Policy | Quartermaster";
      desc = "Privacy Policy for the Quartermaster Discord bot.";
    }

    document.title = title;
    const metadata = [
      ['meta[name="description"]', 'content', desc],
      ['meta[property="og:title"]', 'content', title],
      ['meta[property="og:description"]', 'content', desc],
      ['meta[name="twitter:title"]', 'content', title],
      ['meta[name="twitter:description"]', 'content', desc],
    ] as const;
    for (const [selector, attribute, value] of metadata) {
      document.querySelector(selector)?.setAttribute(attribute, value);
    }
  }, [location]);

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background text-foreground font-sans selection:bg-primary/20">
      <header className="sticky top-0 z-40 w-full border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="max-w-6xl mx-auto flex h-14 items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-2">
            <Link href="/" className="flex items-center gap-2 group" data-testid="link-home-logo" aria-label="Quartermaster status home">
              <div className="bg-primary/10 p-1.5 border border-primary/20 group-hover:bg-primary/20 transition-colors">
                <TerminalSquare className="w-5 h-5 text-primary" />
              </div>
              <div className="font-mono font-bold tracking-tight text-sm uppercase">
                Quartermaster <span className="text-muted-foreground font-normal">/</span> Syscom
              </div>
            </Link>
          </div>

          <nav className="hidden md:flex items-center gap-2 h-full pt-1">
            <NavLink href="/" icon={Activity}>Status</NavLink>
            <NavLink href="/terms" icon={FileText}>Terms</NavLink>
            <NavLink href="/privacy" icon={Shield}>Privacy</NavLink>
          </nav>
        </div>
      </header>
      
      <nav aria-label="Mobile navigation" className="md:hidden border-b border-border bg-card/50 overflow-x-auto flex px-4">
        <NavLink href="/" icon={Activity}>Status</NavLink>
        <NavLink href="/terms" icon={FileText}>Terms</NavLink>
        <NavLink href="/privacy" icon={Shield}>Privacy</NavLink>
      </nav>

      <main className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-6 py-8 md:py-12">
        {children}
      </main>

      <footer className="border-t border-border bg-card mt-auto">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 md:py-12">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
            <div className="md:col-span-2 space-y-4">
              <div className="flex items-center gap-2">
                <TerminalSquare className="w-5 h-5 text-muted-foreground" />
                <div className="font-mono font-bold tracking-tight text-sm text-muted-foreground uppercase">
                  Quartermaster
                </div>
              </div>
              <p className="text-sm text-muted-foreground max-w-xs leading-relaxed">
                Disciplined operations and infrastructure management for Discord communities. Not affiliated with Discord or Roblox.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-sm tracking-wider uppercase text-foreground mb-4 font-mono">Legal</h3>
              <ul className="space-y-3">
                <li>
                  <Link href="/terms" className="text-sm text-muted-foreground hover:text-primary transition-colors" data-testid="link-footer-terms">
                    Terms of Service
                  </Link>
                </li>
                <li>
                  <Link href="/privacy" className="text-sm text-muted-foreground hover:text-primary transition-colors" data-testid="link-footer-privacy">
                    Privacy Policy
                  </Link>
                </li>
              </ul>
            </div>
            
            <div>
              <h3 className="font-semibold text-sm tracking-wider uppercase text-foreground mb-4 font-mono">Information</h3>
              <ul className="space-y-3">
                <li className="text-sm text-muted-foreground">
                  Owned by {OWNER_NAME}
                </li>
                <li className="text-sm text-muted-foreground">
                  Operated by {OPERATOR_NAME}
                </li>
                <li className="text-sm text-muted-foreground">
                  Created and managed by {CREATOR_NAME}
                  <span className="block font-mono text-xs mt-1">Discord: {CREATOR_DISCORD}</span>
                </li>
                <li className="text-sm text-muted-foreground">
                  Effective: {EFFECTIVE_DATE}
                </li>
                <li>
                  <a
                    href={`mailto:${CONTACT_EMAIL}`}
                    className="text-sm text-muted-foreground hover:text-primary transition-colors break-all"
                    data-testid="link-footer-contact"
                  >
                    Contact support
                  </a>
                </li>
              </ul>
            </div>
          </div>
          
          <div className="mt-12 pt-8 border-t border-border flex flex-col sm:flex-row justify-between items-center gap-4 text-xs text-muted-foreground">
            <p>© {new Date().getFullYear()} {OWNER_NAME}. All rights reserved.</p>
            <p>Systems operational.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
